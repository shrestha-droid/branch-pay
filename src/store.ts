import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * quoted -> invoicing -> invoiced -> paid -> delivering -> delivered
 *                                       \-> (deposit plan) preview -> delivered
 * Side exits: cancelled (unpaid invoice cancelled), refunded (money returned, access revoked), failed (scoping failed).
 */
export type JobStatus =
  | 'quoted'
  | 'invoicing'
  | 'invoiced'
  | 'paid'
  | 'delivering'
  | 'preview'
  | 'delivered'
  | 'refunded'
  | 'cancelled'
  | 'failed';

export interface LineItem {
  name: string;
  description: string;
  amount: number;
}

export interface Quote {
  title: string;
  summary: string;
  currency: 'USD';
  items: LineItem[];
  total: number;
}

export interface LogEntry {
  at: string;
  agent: string;
  message: string;
}

export interface Job {
  id: string;
  createdAt: string;
  /** The browser workspace (or agent connection) that owns this job. Lists are scoped to it. */
  owner?: string;
  /** Who asked: a person in the dashboard, or an AI agent over MCP. */
  source?: 'dashboard' | 'agent';
  clientName: string;
  clientEmail: string;
  request: string;
  status: JobStatus;
  quote?: Quote;
  /** Set when the human approved a deposit plan: the amount that unlocks the preview. */
  deposit?: number;
  invoice?: { id: string; status: string; url?: string; paid?: number; due?: number };
  invoicedAt?: string;
  /** When the amount currently owed became due (invoice sent, or preview ready). Drives auto-reminders. */
  dueSince?: string;
  remindedAt?: string;
  reminders?: number;
  paidAt?: string;
  refundedAt?: string;
  deliverableHtml?: string;
  log: LogEntry[];
  error?: string;
}

// Simple JSON file storage. Good enough for a prototype; swap for a database later.
const FILE = join(process.cwd(), 'data', 'jobs.json');
const jobs = new Map<string, Job>();
// ponytail: the whole file is rewritten on every save, so old jobs are dropped to keep it small.
const KEEP_DAYS = 14;

function load(): void {
  if (!existsSync(FILE)) return;
  try {
    const list = JSON.parse(readFileSync(FILE, 'utf8')) as Job[];
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const job of list) {
      if (Date.parse(job.createdAt) < cutoff) continue;
      // A crash mid-step leaves a job "working" forever. Put it back where it can be retried.
      if (job.status === 'invoicing') job.status = 'quoted';
      if (job.status === 'delivering') job.status = 'paid';
      jobs.set(job.id, job);
    }
  } catch (err) {
    console.error('Could not read data/jobs.json, starting empty:', err);
  }
}

function persist(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify([...jobs.values()], null, 2));
}

load();

export function createJob(
  input: { clientName: string; clientEmail: string; request: string },
  owner: string,
  source: Job['source'] = 'dashboard',
): Job {
  const job: Job = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    owner,
    source,
    clientName: input.clientName,
    clientEmail: input.clientEmail,
    request: input.request,
    status: 'quoted',
    log: [],
  };
  jobs.set(job.id, job);
  persist();
  return job;
}

export const getJob = (id: string): Job | undefined => jobs.get(id);

export const findJobByInvoice = (invoiceId: string): Job | undefined =>
  [...jobs.values()].find((j) => j.invoice?.id === invoiceId);

/** All jobs, newest first. Pass an owner to get only that workspace's jobs. */
export const listJobs = (owner?: string): Job[] =>
  [...jobs.values()]
    .filter((j) => owner === undefined || j.owner === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function saveJob(job: Job): void {
  jobs.set(job.id, job);
  persist();
}

export function addLog(job: Job, agent: string, message: string): void {
  job.log.push({ at: new Date().toISOString(), agent, message });
  saveJob(job);
}

/** What the browser is allowed to see. The deliverable is never included here. */
export function toPublic(job: Job) {
  const { deliverableHtml, owner, ...rest } = job;
  return { ...rest, hasDeliverable: Boolean(deliverableHtml) };
}

// ---------------------------------------------------------------------------
// Payment rules. Pure functions, so they are easy to test (see payments.test.ts).
// ---------------------------------------------------------------------------

/** Half the total, rounded to cents. The code decides this, never the AI. */
export const depositFor = (total: number): number => Math.round(total * 50) / 100;

export type PaymentEvent = 'cancelled' | 'paid_in_full' | 'deposit_paid' | 'balance_paid' | null;

/** What a fresh invoice reading from PayPal means for this job. */
export function paymentEvent(
  job: Pick<Job, 'status' | 'deposit'>,
  inv: { paid: boolean; cancelled: boolean; paidAmount: number },
): PaymentEvent {
  if (inv.cancelled && job.status === 'invoiced') return 'cancelled';
  if (job.status === 'invoiced') {
    if (inv.paid) return 'paid_in_full';
    if (job.deposit && inv.paidAmount >= job.deposit) return 'deposit_paid';
  }
  if (job.status === 'preview' && inv.paid) return 'balance_paid';
  return null;
}

/** Whether the Collector should send a reminder on its own right now. */
export function reminderDue(
  job: Pick<Job, 'status' | 'reminders' | 'remindedAt' | 'dueSince'>,
  now: number,
  everyMinutes: number,
  maxReminders: number,
): boolean {
  if (everyMinutes <= 0 || (job.status !== 'invoiced' && job.status !== 'preview')) return false;
  if ((job.reminders ?? 0) >= maxReminders) return false;
  const last = job.remindedAt ?? job.dueSince;
  return Boolean(last) && now - Date.parse(last!) >= everyMinutes * 60_000;
}
