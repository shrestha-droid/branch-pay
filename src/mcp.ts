import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getJob, listJobs, type Job } from './store.js';

/**
 * Agentic commerce: an MCP server so a client's AI assistant (Claude, ChatGPT, any MCP client)
 * can hire the agency. The buyer's agent can ask for a quote and track the job.
 * It cannot approve, bill, refund or pay: the agency approves in the dashboard, and the
 * buyer's human pays through the PayPal link. People stay in charge on both sides.
 *
 * Each dashboard workspace has its own MCP URL (/mcp/<workspace>), so jobs an agent creates
 * show up in that workspace for approval.
 */

export interface McpDeps {
  /** Create a job and run the Scoper. Returns null when the caller is rate limited. */
  quote(input: { clientName: string; clientEmail: string; request: string }, owner: string, ip: string): Promise<Job | null>;
}

const baseUrl = (req: Request) => `${req.protocol}://${req.get('host')}`;
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** What a buyer's agent is allowed to know about a job. */
function summary(job: Job, base: string) {
  const unlocked = job.status === 'preview' || job.status === 'delivered';
  return {
    jobId: job.id,
    status: job.status,
    nextStep: NEXT[job.status],
    quote: job.quote && { title: job.quote.title, summary: job.quote.summary, items: job.quote.items, total: job.quote.total, currency: job.quote.currency },
    paymentPlan: job.deposit ? { deposit: job.deposit, unlocks: 'a watermarked preview; the balance unlocks the final files' } : 'pay in full',
    invoice: job.invoice && { id: job.invoice.id, status: job.invoice.status, paid: job.invoice.paid ?? 0, due: job.invoice.due, payUrl: job.invoice.url },
    deliverableUrl: unlocked ? `${base}/api/jobs/${job.id}/deliverable` : undefined,
    recentActivity: job.log.slice(-5).map((l) => `${l.agent}: ${l.message}`),
  };
}

const NEXT: Record<Job['status'], string> = {
  quoted: 'The agency is reviewing the quote. Check again in a minute.',
  invoicing: 'The agency approved. A PayPal invoice is being created.',
  invoiced: 'Ask your human to pay the PayPal invoice at invoice.payUrl. Agents cannot pay.',
  paid: 'Payment received. The work is being built.',
  delivering: 'Payment received. The work is being built.',
  preview: 'Deposit paid. A watermarked preview is at deliverableUrl. Paying the balance at invoice.payUrl unlocks the final files.',
  delivered: 'Paid in full. The final files are at deliverableUrl.',
  refunded: 'The agency refunded this job. Access was revoked.',
  cancelled: 'The agency cancelled this invoice. Nothing is due.',
  failed: 'The quote could not be produced. Try request_quote again.',
};

function buildServer(workspace: string, req: Request, deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'branch-pay', version: '1.0.0' });
  const base = baseUrl(req);

  server.registerTool(
    'request_quote',
    {
      title: 'Request a quote',
      description:
        'Ask the Branch Pay agency to quote a small web project (for example a one-page site). ' +
        'Returns a fixed-price quote. The agency approves it, then PayPal emails the client an invoice. ' +
        'Use a PayPal sandbox buyer email as clientEmail.',
      inputSchema: {
        clientName: z.string().trim().min(1).max(80).describe('Name of the person or business being billed'),
        clientEmail: z.string().trim().email().max(120).describe('Email that receives the PayPal invoice'),
        request: z.string().trim().min(10).max(1500).describe('What should be built, in plain words'),
      },
    },
    async (input) => {
      const job = await deps.quote(input, workspace, req.ip ?? 'unknown');
      if (!job) return fail('Rate limit reached. Try again later.');
      if (job.status === 'failed') return fail(`The agency could not produce a quote: ${job.error ?? 'unknown error'}`);
      return text(summary(job, base));
    },
  );

  server.registerTool(
    'get_job',
    {
      title: 'Check a job',
      description: 'See the status of a job: quote, PayPal invoice and pay link, what is paid, and the deliverable once unlocked.',
      inputSchema: { jobId: z.string().uuid().describe('The jobId returned by request_quote') },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job || job.owner !== workspace) return fail('No job with that id in this workspace.');
      return text(summary(job, base));
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'List the jobs in this workspace, newest first.',
      annotations: { readOnlyHint: true },
    },
    async () => text(listJobs(workspace).slice(0, 20).map((j) => summary(j, base))),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server per request, no session to keep. */
export async function handleMcp(req: Request, res: Response, workspace: string, deps: McpDeps): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this URL.' }, id: null });
    return;
  }
  const server = buildServer(workspace, req, deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
