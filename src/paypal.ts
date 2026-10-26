import { config } from './config.js';

/**
 * A small PayPal REST client, written by hand on purpose so every call is visible.
 * It uses the Invoicing API v2:
 *   POST /v1/oauth2/token                       -> get an access token
 *   POST /v2/invoicing/invoices                 -> create a DRAFT invoice
 *   POST /v2/invoicing/invoices/{id}/send       -> send it (DRAFT -> UNPAID / SENT)
 *   GET  /v2/invoicing/invoices/{id}            -> read status (UNPAID ... PAID)
 *   POST /v2/invoicing/invoices/{id}/remind     -> email the client a payment reminder
 *   POST /v2/invoicing/invoices/{id}/cancel     -> cancel an unpaid invoice
 *   POST /v2/invoicing/invoices/{id}/payments   -> record a payment (sandbox demo shortcut)
 *   POST /v2/invoicing/invoices/{id}/refunds    -> record a refund of an external payment
 *   POST /v2/payments/captures/{id}/refund      -> refund money the client paid through PayPal
 *   POST /v1/notifications/verify-webhook-signature -> prove a webhook really came from PayPal
 */

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;

  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (!clientId || !clientSecret) {
    throw new PayPalError('PayPal credentials are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.', 0);
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) {
    throw new PayPalError(`PayPal login failed (${res.status}). Check your sandbox Client ID and Secret.`, res.status, data);
  }

  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
  return cachedToken.value;
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Lets PayPal treat a retried request as the same request, so we never double-create an invoice.
  if (requestId) headers['PayPal-Request-Id'] = requestId;

  const res = await fetch(`${config.paypal.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const parsed = text ? safeJson(text) : {};
  if (!res.ok) {
    const msg = (parsed as { message?: string }).message ?? res.statusText;
    throw new PayPalError(`PayPal ${method} ${path} failed (${res.status}): ${msg}`, res.status, parsed);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ---------- Public functions ----------

export type PaymentTerm = 'DUE_ON_RECEIPT' | 'NET_10' | 'NET_30';

export interface InvoiceInput {
  jobId: string;
  recipientEmail: string;
  recipientName: string;
  currency: string;
  items: { name: string; description: string; amount: number }[];
  note: string;
  paymentTerm: PaymentTerm;
  /** Deposit plan: PayPal lets the client pay this much first (native partial payments). */
  minimumDue?: number;
}

const money = (currency: string, amount: number) => ({
  currency_code: currency,
  value: amount.toFixed(2),
});

/** Step 1: create a DRAFT invoice. Returns the invoice id (looks like INV2-XXXX-XXXX-XXXX-XXXX). */
export async function createInvoice(input: InvoiceInput): Promise<{ id: string }> {
  const [givenName, ...rest] = input.recipientName.trim().split(/\s+/);
  const body: Record<string, unknown> = {
    detail: {
      currency_code: input.currency,
      note: input.note,
      payment_term: { term_type: input.paymentTerm },
    },
    primary_recipients: [
      {
        billing_info: {
          email_address: input.recipientEmail,
          name: { given_name: givenName || input.recipientName, surname: rest.join(' ') || '-' },
        },
      },
    ],
    items: input.items.map((item) => ({
      name: item.name,
      description: item.description,
      quantity: '1',
      unit_amount: money(input.currency, item.amount),
    })),
  };

  if (input.minimumDue) {
    body.configuration = {
      partial_payment: { allow_partial_payment: true, minimum_amount_due: money(input.currency, input.minimumDue) },
    };
  }

  const invoicer: Record<string, unknown> = { name: { business_name: config.paypal.businessName } };
  if (config.paypal.merchantEmail) invoicer.email_address = config.paypal.merchantEmail;
  body.invoicer = invoicer;

  // PayPal answers 201 with a link whose last path segment is the new invoice id.
  const created = await api<{ href?: string }>('POST', '/v2/invoicing/invoices', body, input.jobId);
  const id = created.href?.split('/').pop();
  if (!id) throw new PayPalError('PayPal created the invoice but did not return its id.', 201, created);
  return { id };
}

/** Step 2: send the draft. PayPal emails the recipient a payment link. */
export async function sendInvoice(id: string): Promise<void> {
  await api('POST', `/v2/invoicing/invoices/${id}/send`, {
    send_to_recipient: true,
    send_to_invoicer: false,
  });
}

interface Transaction {
  payment_id?: string;
  type?: 'PAYPAL' | 'EXTERNAL';
  amount?: { currency_code: string; value: string };
}

export interface InvoiceSummary {
  id: string;
  status: string;
  paid: boolean;
  cancelled: boolean;
  paidAmount: number;
  dueAmount: number;
  recipientViewUrl?: string;
  transactions: Transaction[];
}

const PAID = new Set(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL']);
const CANCELLED = new Set(['CANCELLED', 'AUTO_CANCELLED']);

/** Step 3: read the invoice. The server polls this until the status says PAID. */
export async function getInvoice(id: string): Promise<InvoiceSummary> {
  const inv = await api<{
    id?: string;
    status?: string;
    detail?: { metadata?: { recipient_view_url?: string } };
    due_amount?: { value?: string };
    payments?: { paid_amount?: { value?: string }; transactions?: Transaction[] };
  }>('GET', `/v2/invoicing/invoices/${id}`);

  const status = inv.status ?? 'UNKNOWN';
  return {
    id: inv.id ?? id,
    status,
    paid: PAID.has(status),
    cancelled: CANCELLED.has(status),
    paidAmount: Number(inv.payments?.paid_amount?.value ?? 0),
    dueAmount: Number(inv.due_amount?.value ?? 0),
    recipientViewUrl: inv.detail?.metadata?.recipient_view_url,
    transactions: inv.payments?.transactions ?? [],
  };
}

/**
 * Give back everything the client paid on an invoice.
 * Money paid through PayPal is refunded with the Payments API (the invoice transaction id is the capture id);
 * payments recorded by the merchant (like the sandbox demo shortcut) get a recorded refund.
 */
export async function refundInvoice(id: string): Promise<number> {
  const inv = await getInvoice(id);
  let refunded = 0;
  for (const t of inv.transactions) {
    if (!t.amount) continue;
    if (t.type === 'PAYPAL' && t.payment_id) {
      await api('POST', `/v2/payments/captures/${t.payment_id}/refund`, { amount: t.amount }, `refund-${t.payment_id}`);
    } else {
      await api('POST', `/v2/invoicing/invoices/${id}/refunds`, {
        method: 'OTHER',
        refund_date: new Date().toISOString().slice(0, 10),
        amount: t.amount,
      });
    }
    refunded += Number(t.amount.value);
  }
  return Math.round(refunded * 100) / 100;
}

/**
 * Demo shortcut (sandbox only): the merchant records a payment against the invoice.
 * A real customer would instead pay through the recipient link.
 */
export async function recordPayment(id: string, amount: number, currency: string): Promise<void> {
  await api('POST', `/v2/invoicing/invoices/${id}/payments`, {
    method: 'OTHER',
    payment_date: new Date().toISOString().slice(0, 10),
    amount: money(currency, amount),
    note: 'Recorded by Branch Pay demo (sandbox)',
  });
}

/** Collections: PayPal emails the client a reminder with the same payment link. */
export async function remindInvoice(id: string, subject: string, note: string): Promise<void> {
  await api('POST', `/v2/invoicing/invoices/${id}/remind`, {
    subject,
    note,
    send_to_invoicer: false,
    send_to_recipient: true,
  });
}

/** Cancel an unpaid invoice. PayPal tells the client it is no longer due. */
export async function cancelInvoice(id: string, note: string): Promise<void> {
  await api('POST', `/v2/invoicing/invoices/${id}/cancel`, {
    subject: 'Invoice cancelled',
    note,
    send_to_invoicer: false,
    send_to_recipient: true,
  });
}

/** Ask PayPal whether a webhook delivery is genuine. Needs the webhook id from the developer dashboard. */
export async function verifyWebhook(headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
  const h = (name: string) => String(headers[name] ?? '');
  const result = await api<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: config.paypal.webhookId,
    webhook_event: event,
  });
  return result.verification_status === 'SUCCESS';
}
