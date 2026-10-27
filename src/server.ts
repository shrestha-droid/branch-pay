import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import { z } from 'zod';
import { config, geminiConfigured, paypalConfigured } from './config.js';
import { MODELS, pingModel, runBiller, runBuilder, runCollector, runScoper } from './agents.js';
import { handleMcp } from './mcp.js';
import { cancelInvoice, getAccessToken, getInvoice, recordPayment, refundInvoice, verifyWebhook } from './paypal.js';
import {
  addLog,
  createJob,
  combineInvoices,
  depositFor,
  findJobByInvoice,
  invoiceToChase,
  getJob,
  listJobs,
  paymentEvent,
  reminderDue,
  saveJob,
  toPublic,
  type Job,
} from './store.js';

const app = express();
app.set('trust proxy', 1); // Render and other hosts sit behind one proxy; this makes req.ip the visitor's IP.
app.use(express.json({ limit: '50kb' }));
app.use(express.static(join(process.cwd(), 'public')));

// Jobs that an agent is working on right now. Stops two requests from running the same step twice.
const busy = new Set<string>();

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (n: number) => `$${n.toFixed(2)}`;
const now = () => new Date().toISOString();

/** Runs one step on a job unless an agent is already on it. Returns false if it was busy. */
async function exclusive(job: Job, step: () => Promise<void>): Promise<boolean> {
  if (busy.has(job.id)) return false;
  busy.add(job.id);
  try {
    await step();
  } finally {
    busy.delete(job.id);
    saveJob(job);
  }
  return true;
}

const waitingForPayment = (job: Job) => job.status === 'invoiced' || job.status === 'preview';

/** The job's payment state from PayPal: one invoice, or a deposit + balance pair read as one. */
async function readInvoice(job: Job) {
  const first = await getInvoice(job.invoice!.id);
  return job.balanceInvoice ? combineInvoices(first, await getInvoice(job.balanceInvoice.id)) : first;
}
/** Every PayPal invoice behind a job. */
const invoiceIds = (job: Job) => [job.invoice!.id, ...(job.balanceInvoice ? [job.balanceInvoice.id] : [])];

// Every browser gets its own workspace (a random id kept in localStorage), so visitors to a public
// deployment only see their own jobs. Job ids are unguessable UUIDs, so they work as access tokens.
const WORKSPACE = /^[A-Za-z0-9_-]{16,80}$/;
const workspaceOf = (value: unknown) => (typeof value === 'string' && WORKSPACE.test(value) ? value : undefined);

// ponytail: in-memory and per process. Fine for one instance; move to Redis if you scale out.
const hits = new Map<string, number[]>();
function allow(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
  const ok = recent.length < max;
  if (ok) recent.push(t);
  hits.set(key, recent);
  return ok;
}
/** Each quote costs an AI call, so a public demo limits them per visitor and per day. */
const quoteAllowed = (ip: string) =>
  allow(`ip:${ip}`, config.quotesPerIpHour, 3_600_000) && allow('all', config.quotesPerDay, 86_400_000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/config', (_req, res) => {
  res.json({
    paypalConfigured,
    geminiConfigured,
    model: config.gemini.model,
    maxQuoteUsd: config.maxQuoteUsd,
    maxReminders: config.maxReminders,
    autoRemindMinutes: config.autoRemindMinutes,
    autoApproveUnderUsd: config.autoApproveUnderUsd,
    webhooks: Boolean(config.paypal.webhookId),
    sandbox: true,
  });
});

// Live check of both outside services, for judges and for debugging a deploy.
// Cached for 30 seconds so it can't be used to burn the AI quota.
let health: { at: number; body: unknown } | null = null;
app.get('/api/health', async (_req, res) => {
  if (!health || Date.now() - health.at > 30_000) {
    const check = async (run: () => Promise<unknown>) => {
      const started = Date.now();
      try {
        await run();
        return { ok: true, ms: Date.now() - started };
      } catch (err) {
        return { ok: false, ms: Date.now() - started, error: errorMessage(err) };
      }
    };
    const [paypal, ...gemini] = await Promise.all([check(getAccessToken), ...MODELS.map((id) => check(() => pingModel(id)))]);
    health = { at: Date.now(), body: { paypal, gemini: MODELS.map((model, i) => ({ model, ...gemini[i] })) } };
  }
  res.json(health.body);
});

app.get('/api/jobs', (req, res) => {
  const workspace = workspaceOf(req.get('x-workspace'));
  res.json(workspace ? listJobs(workspace).map(toPublic) : []);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Job not found.' });
  res.json(toPublic(job));
});

const newJobSchema = z.object({
  clientName: z.string().trim().min(1).max(80),
  clientEmail: z.string().trim().email().max(120),
  request: z.string().trim().min(10).max(1500),
});

// Step 1: client describes what they want. The Scoper prices it. Nothing is billed yet.
app.post('/api/jobs', async (req, res) => {
  if (!geminiConfigured) {
    return void res.status(503).json({ error: 'Set GOOGLE_GENERATIVE_AI_API_KEY in .env first.' });
  }
  const workspace = workspaceOf(req.get('x-workspace'));
  if (!workspace) return void res.status(400).json({ error: 'Missing workspace. Reload the page.' });
  const parsed = newJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: 'Please fill in your name, a valid email, and at least 10 characters of request.' });
  }

  const job = await quote(parsed.data, workspace, 'dashboard', req.ip ?? 'unknown');
  if (!job) return void res.status(429).json({ error: 'Quote limit reached for now. Try again in a while.' });
  res.status(201).json(toPublic(job));
});

/** Create a job and run the Scoper. Shared by the dashboard and the MCP server. Null = rate limited. */
async function quote(
  input: { clientName: string; clientEmail: string; request: string },
  owner: string,
  source: Job['source'],
  ip: string,
): Promise<Job | null> {
  if (!quoteAllowed(ip)) return null;
  const job = createJob(input, owner, source);
  if (source === 'agent') addLog(job, 'System', 'Request received from an AI agent over MCP.');
  try {
    job.quote = await runScoper(job);
    saveJob(job);
  } catch (err) {
    job.status = 'failed';
    job.error = errorMessage(err);
    console.error(`Job ${job.id}:`, job.error);
    addLog(job, 'System', `Scoping failed: ${job.error}`);
    return job;
  }
  // The spending mandate: a limit a human set in advance, enforced in code.
  const limit = config.autoApproveUnderUsd;
  if (limit > 0 && paypalConfigured && job.quote.total <= limit) await approve(job, false, `Policy (auto-approve up to ${usd(limit)})`);
  return job;
}

// If the Scoper failed (rate limit, network), try the same request again.
app.post('/api/jobs/:id/requote', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'failed') return void res.status(409).json({ error: `Job is "${job.status}", not failed.` });
  if (!quoteAllowed(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'Quote limit reached for now.' });

  const ran = await exclusive(job, async () => {
    try {
      job.quote = await runScoper(job);
      job.status = 'quoted';
      job.error = undefined;
    } catch (err) {
      job.error = errorMessage(err);
      console.error(`Job ${job.id}:`, job.error);
    console.error(`Job ${job.id}:`, job.error);
      addLog(job, 'System', `Scoping failed again: ${job.error}`);
    }
  });
  if (!ran) return void res.status(409).json({ error: 'Already working on this job.' });
  res.json(toPublic(job));
});

const approveSchema = z.object({ deposit: z.boolean().optional() });

// Step 2: a human approves the quote, and picks the payment plan. Only then does the Biller touch PayPal.
app.post('/api/jobs/:id/approve', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'quoted' || !job.quote) {
    return void res.status(409).json({ error: `Job is "${job.status}", not waiting for approval.` });
  }
  if (!paypalConfigured) {
    return void res.status(503).json({ error: 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.' });
  }
  const deposit = approveSchema.safeParse(req.body ?? {}).data?.deposit ?? false;
  if (!(await approve(job, deposit, 'You'))) return void res.status(409).json({ error: 'Already working on this job.' });
  res.json(toPublic(job));
});

/** Approval, by a person or by the spending policy, then the Biller invoices through PayPal. */
function approve(job: Job, deposit: boolean, by: string): Promise<boolean> {
  const quote = job.quote!;
  return exclusive(job, async () => {
    job.status = 'invoicing';
    job.deposit = deposit ? depositFor(quote.total) : undefined;
    addLog(
      job,
      by,
      `Approved the ${usd(quote.total)} quote` + (job.deposit ? ` with a ${usd(job.deposit)} deposit first.` : ', billed in full.'),
    );
    try {
      const { invoiceId, balanceInvoiceId } = await runBiller(job);
      job.invoice = { id: invoiceId, status: 'SENT' };
      job.balanceInvoice = balanceInvoiceId ? { id: balanceInvoiceId } : undefined;
      const inv = await readInvoice(job);
      Object.assign(job.invoice, { status: inv.status, url: inv.recipientViewUrl, paid: inv.paidAmount, due: inv.dueAmount });
      job.invoicedAt = job.dueSince = now();
      job.status = 'invoiced';
      job.error = undefined;
      addLog(job, 'System', `Invoice is ${inv.status}. Waiting for payment...`);
    } catch (err) {
      // Safe to retry: nothing is charged until the client pays the invoice.
      job.status = 'quoted';
      job.deposit = undefined;
      job.error = errorMessage(err);
      console.error(`Job ${job.id}:`, job.error);
    console.error(`Job ${job.id}:`, job.error);
      addLog(job, 'System', `Billing failed: ${job.error}`);
    }
  });
}

// Demo only: record a payment in the sandbox so you can see the whole loop without a buyer login.
// On a deposit plan the first click pays the deposit, the second pays the balance.
app.post('/api/jobs/:id/sandbox-pay', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.invoice || !job.quote) return void res.status(404).json({ error: 'No invoice for this job.' });
  if (!waitingForPayment(job)) return void res.status(409).json({ error: `Job is "${job.status}", not waiting for payment.` });

  const { invoice, quote } = job;
  const ran = await exclusive(job, async () => {
    const inv = await readInvoice(job);
    const due = inv.dueAmount || quote.total - inv.paidAmount;
    const payDeposit = job.status === 'invoiced' && job.deposit !== undefined && inv.paidAmount < job.deposit;
    const amount = Math.round((payDeposit ? job.deposit! - inv.paidAmount : due) * 100) / 100;
    if (amount <= 0) return;
    // With a deposit + balance pair, pay whichever invoice is next.
    const target = job.balanceInvoice && !payDeposit ? job.balanceInvoice.id : invoice.id;
    await recordPayment(target, amount, quote.currency);
    const what = payDeposit ? 'deposit' : job.status === 'preview' ? 'balance' : 'full';
    addLog(job, 'System', `Demo shortcut: recorded a ${usd(amount)} sandbox payment (${what}).`);
  });
  if (!ran) return void res.status(409).json({ error: 'Already working on this job.' });
  await checkPayment(job);
  res.json(toPublic(job));
});

// Check PayPal right now instead of waiting for the next poll.
app.post('/api/jobs/:id/refresh', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Job not found.' });
  await checkPayment(job);
  res.json(toPublic(job));
});

// Collections: the Collector agent writes a reminder and PayPal emails it to the client.
app.post('/api/jobs/:id/remind', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.invoice) return void res.status(404).json({ error: 'No invoice for this job.' });
  if (!waitingForPayment(job)) return void res.status(409).json({ error: `Job is "${job.status}", not waiting for payment.` });
  if (!geminiConfigured) return void res.status(503).json({ error: 'Set GOOGLE_GENERATIVE_AI_API_KEY in .env first.' });
  // A hard limit in code, so the client is never spammed.
  if ((job.reminders ?? 0) >= config.maxReminders) {
    return void res.status(429).json({ error: `Already sent ${config.maxReminders} reminders for this payment.` });
  }

  const ran = await exclusive(job, () => remind(job));
  if (!ran) return void res.status(409).json({ error: 'Already working on this job.' });
  res.json(toPublic(job));
});

// Cancel an unpaid invoice. PayPal notifies the client; the deliverable is never built.
app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.invoice) return void res.status(404).json({ error: 'No invoice for this job.' });
  if (job.status !== 'invoiced') return void res.status(409).json({ error: `Job is "${job.status}", not waiting for payment.` });

  const invoice = job.invoice;
  const ran = await exclusive(job, async () => {
    for (const id of invoiceIds(job)) await cancelInvoice(id, 'This invoice was cancelled. No payment is due.');
    invoice.status = 'CANCELLED';
    job.status = 'cancelled';
    addLog(job, 'You', `Cancelled invoice ${invoice.id}.`);
  });
  if (!ran) return void res.status(409).json({ error: 'Already working on this job.' });
  res.json(toPublic(job));
});

// Refund everything the client paid. A human-only action: no agent can call this.
// Money back means access back: the deliverable answers 402 again.
app.post('/api/jobs/:id/refund', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.invoice) return void res.status(404).json({ error: 'No invoice for this job.' });
  if (!['paid', 'preview', 'delivered'].includes(job.status)) {
    return void res.status(409).json({ error: `Job is "${job.status}", nothing to refund.` });
  }

  const invoice = job.invoice;
  const ran = await exclusive(job, async () => {
    const wasPreview = job.status === 'preview';
    let amount = 0;
    for (const id of invoiceIds(job)) amount += await refundInvoice(id);
    const unpaid = invoiceToChase(job);
    job.status = 'refunded';
    job.refundedAt = now();
    job.error = undefined;
    addLog(job, 'You', `Refunded ${usd(amount)} to ${job.clientEmail}. The deliverable is locked again.`);
    if (wasPreview) {
      // The balance is no longer wanted. Best effort: PayPal may not allow cancelling a partly paid invoice.
      await cancelInvoice(unpaid!, 'This project was refunded. No further payment is due.').catch((err) =>
        addLog(job, 'System', `Could not cancel the remaining balance: ${errorMessage(err)}`),
      );
    }
    const inv = await readInvoice(job).catch(() => undefined);
    if (inv) Object.assign(invoice, { status: inv.status, paid: inv.paidAmount, due: inv.dueAmount });
  });
  if (!ran) return void res.status(409).json({ error: 'Already working on this job.' });
  res.json(toPublic(job));
});

// If delivery failed after payment, try again.
app.post('/api/jobs/:id/deliver', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'paid') return void res.status(409).json({ error: `Job is "${job.status}", not paid.` });
  if (!(await deliver(job))) return void res.status(409).json({ error: 'Already working on this job.' });
  res.json(toPublic(job));
});

// PayPal webhooks. A webhook is only a nudge: the payment status is always re-read from the
// Invoicing API, so even a forged event cannot unlock a deliverable.
app.post('/api/paypal/webhook', async (req, res) => {
  const event = req.body as { event_type?: string; resource?: { id?: string; invoice?: { id?: string } } };
  if (config.paypal.webhookId && !(await verifyWebhook(req.headers, event))) {
    return void res.status(400).json({ error: 'Webhook signature did not verify.' });
  }
  res.sendStatus(200); // Answer fast; PayPal retries anything that is not 2xx.

  const invoiceId = event.resource?.invoice?.id ?? event.resource?.id;
  const job = invoiceId ? findJobByInvoice(invoiceId) : undefined;
  if (!job) return;
  addLog(job, 'System', `PayPal webhook received: ${event.event_type ?? 'unknown event'}.`);
  checkPayment(job).catch((err) => console.error(`Webhook check for ${job.id} failed:`, errorMessage(err)));
});

// MCP endpoint for buyers' AI agents. Each workspace has its own URL.
app.all('/mcp/:workspace', async (req, res) => {
  const workspace = workspaceOf(req.params.workspace);
  if (!workspace) return void res.status(404).json({ error: 'Unknown workspace.' });
  await handleMcp(req, res, workspace, {
    quote: (input, owner, ip) => (geminiConfigured ? quote(input, owner, 'agent', ip) : Promise.reject(new Error('The agency has no AI key configured.'))),
  });
});

// The deliverable is locked behind payment. HTTP 402 means "Payment Required".
// Deposit paid = watermarked preview. Paid in full = final files, downloadable.
app.get('/api/jobs/:id/deliverable', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Job not found.' });
  const html = job.deliverableHtml;
  if (!html || (job.status !== 'delivered' && job.status !== 'preview')) {
    const error = job.status === 'refunded' ? 'Refunded. Access was revoked.' : 'Payment required.';
    // Machine-readable, so a buyer's AI agent knows what to pay and where (in the spirit of x402,
    // but settled through a PayPal invoice that a human pays).
    const inv = job.invoice;
    if (inv?.url) res.setHeader('Link', `<${inv.url}>; rel="payment"`);
    return void res.status(402).json({
      error,
      payment:
        inv && job.quote && waitingForPayment(job)
          ? { provider: 'paypal', invoiceId: inv.id, status: inv.status, currency: job.quote.currency, amountDue: inv.due ?? job.quote.total, payUrl: inv.url ?? null }
          : null,
    });
  }
  // The HTML was written by an AI, so lock it down: no scripts, no network.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  if (job.status === 'preview') return void res.type('html').send(watermark(html));
  if (req.query.download !== undefined) res.attachment(`${slug(job.quote?.title ?? '')}.html`);
  res.type('html').send(html);
});

// ponytail: the preview is only watermarked, so the HTML is still in view-source.
// A server-rendered screenshot would make the preview truly non-copyable.
const PREVIEW_OVERLAY =
  '<div style="position:fixed;inset:0;pointer-events:none;z-index:2147483646;background:repeating-linear-gradient(-30deg,transparent 0 140px,rgba(0,48,135,.07) 140px 280px)"></div>' +
  '<div style="position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;background:#003087;color:#fff;font:600 14px system-ui,sans-serif;padding:10px 18px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.25);white-space:nowrap">PREVIEW &middot; Pay the balance to unlock the final files</div>';

const watermark = (html: string) =>
  /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${PREVIEW_OVERLAY}</body>`) : html + PREVIEW_OVERLAY;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deliverable';

// ---------------------------------------------------------------------------
// Payment detection, delivery, and collections
// ---------------------------------------------------------------------------

// Jobs whose invoice is being read right now, so a slow PayPal response can't overlap the next poll.
const checking = new Set<string>();

async function checkPayment(job: Job): Promise<void> {
  if (!job.invoice || !waitingForPayment(job) || busy.has(job.id) || checking.has(job.id)) return;

  checking.add(job.id);
  let inv;
  try {
    inv = await readInvoice(job);
  } finally {
    checking.delete(job.id);
  }
  if (!waitingForPayment(job)) return; // Something else moved the job on while we waited.

  if (inv.status !== job.invoice.status) addLog(job, 'System', `Invoice status changed to ${inv.status}.`);
  Object.assign(job.invoice, {
    status: inv.status,
    paid: inv.paidAmount,
    due: inv.dueAmount,
    url: inv.recipientViewUrl ?? job.invoice.url,
  });

  const event = paymentEvent(job, inv);
  // An agent is mid-step (a reminder, say). Leave the job alone; the next poll picks the payment up.
  if (!event || busy.has(job.id)) return void saveJob(job);

  switch (event) {
    case 'cancelled':
      job.status = 'cancelled';
      addLog(job, 'System', 'The invoice was cancelled in PayPal.');
      return;
    case 'paid_in_full':
      job.status = 'paid';
      job.paidAt = now();
      addLog(job, 'System', 'PayPal reports the invoice as paid in full.');
      await deliver(job);
      return;
    case 'deposit_paid':
      job.status = 'paid';
      job.reminders = 0; // The balance gets its own reminders.
      job.remindedAt = undefined;
      addLog(job, 'System', `Deposit of ${usd(inv.paidAmount)} received. Building a preview.`);
      await deliver(job);
      return;
    case 'balance_paid':
      job.status = 'delivered';
      job.paidAt = now();
      addLog(job, 'System', 'Balance paid. The final files are unlocked.');
      return;
  }
}

/** Builder runs. Fully paid jobs are delivered; deposit-only jobs get a watermarked preview. */
function deliver(job: Job): Promise<boolean> {
  return exclusive(job, async () => {
    job.status = 'delivering';
    saveJob(job);
    try {
      job.deliverableHtml = await runBuilder(job);
      job.error = undefined;
      if (job.paidAt) {
        job.status = 'delivered';
      } else {
        job.status = 'preview';
        job.dueSince = now();
        addLog(job, 'System', `Preview unlocked. Waiting for the ${usd(job.invoice?.due ?? 0)} balance...`);
      }
    } catch (err) {
      job.status = 'paid'; // The client already paid, so keep that fact and allow a retry.
      job.error = errorMessage(err);
      console.error(`Job ${job.id}:`, job.error);
    console.error(`Job ${job.id}:`, job.error);
      addLog(job, 'System', `Delivery failed, you can retry: ${job.error}`);
    }
  });
}

async function remind(job: Job): Promise<void> {
  try {
    await runCollector(job);
    job.error = undefined;
  } catch (err) {
    job.error = errorMessage(err);
    console.error(`Job ${job.id}:`, job.error);
    // Count the attempt so a broken reminder can't retry forever on the auto-schedule.
    job.remindedAt = now();
    addLog(job, 'System', `Reminder failed: ${job.error}`);
  }
}

/** One pass over a waiting job: read PayPal, then let the Collector chase it if it is overdue. */
async function tick(job: Job): Promise<void> {
  await checkPayment(job);
  if (geminiConfigured && reminderDue(job, Date.now(), config.autoRemindMinutes, config.maxReminders)) {
    await exclusive(job, () => remind(job));
  }
}

if (paypalConfigured) {
  setInterval(() => {
    for (const job of listJobs()) {
      if (waitingForPayment(job)) {
        tick(job).catch((err) => console.error(`Polling ${job.id} failed:`, errorMessage(err)));
      }
    }
  }, config.pollMs);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: errorMessage(err) });
});

app.listen(config.port, () => {
  console.log(`Branch Pay running at http://localhost:${config.port}`);
  if (!paypalConfigured) console.log('  ! PayPal sandbox keys missing (see .env.example)');
  if (!geminiConfigured) console.log('  ! Gemini API key missing (see .env.example)');
  console.log(`  Payment detection: ${config.paypal.webhookId ? 'webhooks + polling' : 'polling (set PAYPAL_WEBHOOK_ID for webhooks)'}`);
  console.log(`  Auto-reminders: ${config.autoRemindMinutes ? `every ${config.autoRemindMinutes} min, max ${config.maxReminders}` : 'off'}`);
});
