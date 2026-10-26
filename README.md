# Branch Pay

**Four AI agents that quote a job, bill it through PayPal, chase the payment, and release the work only when PayPal says it's paid. Your clients' AI assistants can hire you too.**

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). Sandbox only. No real money moves.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shrestha-droid/branch-pay)

## The problem

Freelancers and small agencies don't lose money on the work. They lose it on the loop around the work: writing the quote, sending the invoice, chasing late payments, and deciding when it's safe to hand over the files. Hand over too early and you might never get paid; hold on too long and the client walks.

Branch Pay hands that loop to a crew of AI agents, and keeps a human on every decision that moves money.

## How it works

```
 Client (a person in the dashboard, or their AI assistant over MCP)
     |
     v
 [Scoper agent]    --> fixed-price quote. Price cap enforced in code; injected instructions reported and ignored
     |
  APPROVE          <-- a human (bill in full, or 50% deposit first), or a spending limit the human set
     |
     v
 [Biller agent]    --> creates + sends a PayPal invoice (tool calling; it cannot choose amounts or recipient)
     |
     |   not paid yet? [Collector agent] --> writes a reminder, PayPal emails it (on its own, max 3)
     v
 PayPal            --> client pays (webhook INVOICING.INVOICE.PAID, polling as a fallback)
     |
     |-- deposit paid --> [Builder agent] builds the site; client gets a WATERMARKED preview
     |                    balance paid --> final files unlocked + downloadable
     '-- paid in full --> [Builder agent] builds and unlocks the site

  REFUND (human only) --> money back through PayPal, the deliverable locks again
```

Until PayPal confirms payment, the deliverable answers **HTTP 402 Payment Required** with a machine-readable PayPal payment link.

## What's inside

| | What it does here |
|---|---|
| **PayPal Invoicing API v2** | Create, send, remind, cancel, read status, record payments and refunds. **Native partial payments** (`allow_partial_payment` + `minimum_amount_due`) power the deposit plan. Hand-written REST in `src/paypal.ts`, so every call is visible. |
| **PayPal Payments API v2** | Refunds money the client paid through PayPal (`/v2/payments/captures/{id}/refund`). |
| **PayPal Webhooks** | `INVOICING.INVOICE.PAID` / `CANCELLED` trigger an instant check. Signatures verified with `verify-webhook-signature` when `PAYPAL_WEBHOOK_ID` is set. |
| **PayPal OAuth 2.0** | Client-credentials token, cached until near expiry. |
| **Gemini** (Vercel AI SDK) | **Scoper**: structured quote + a list of injection attempts it ignored. **Biller**: tool calling. **Collector**: reminders whose tone fits how long the client has waited and what payment unlocks. **Builder**: the HTML deliverable. |
| **Model Context Protocol** | `/mcp/<workspace>` is an MCP server (Streamable HTTP). A client's AI assistant can `request_quote`, `get_job` and `list_jobs`. It cannot approve, pay or refund. |
| **AG Grid** | The **Ledger**: every quote, invoice and payment with filters, sorting, quick search, a totals row and CSV export. |
| **Render** | One-click deploy from `render.yaml`. |

## Agentic commerce: let your clients' AI agents hire you

Open **Connect an AI agent** in the app to get your workspace's MCP URL, then:

- **Claude**: Settings → Connectors → Add custom connector, paste the URL (needs the hosted site).
- **Claude Code**: `claude mcp add --transport http branch-pay <your MCP URL>`
- **MCP Inspector** (no AI account needed): `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, paste the URL.

Then ask: *"Use Branch Pay to get me a quote for a one-page website for my bakery. Bill Jane Doe at &lt;sandbox buyer email&gt;."* The job appears in your pipeline. You approve; the agent can then fetch the PayPal pay link for its human, and the deliverable link once PayPal reports payment.

People stay in charge on both sides: the agency approves, the buyer's human pays. Optionally set `AUTO_APPROVE_UNDER_USD` to let small jobs run end to end within a limit you chose in advance (a spending mandate, enforced in code).

## Safety design: the AI proposes, the code enforces, a human approves

| Guardrail | How |
|---|---|
| The AI never chooses who is billed or how much | The Biller's tools accept only a note and payment terms. Amounts, deposit and recipient come from the approved quote on the server. |
| Hard price cap | Any quote is scaled under `MAX_QUOTE_USD` in code, rounding included (`npm test`). |
| Humans own the money moves | Nothing is invoiced until a person (or their pre-set limit) approves. Refund and cancel have no AI tool at all. |
| Prompt injection can't reach an action | The client text is untrusted data. The Scoper reports injected instructions, but safety never depends on that: the text can only influence a quote that code clamps and a human approves. Try **Try a prompt injection** in the app. |
| Webhooks are a nudge, not the truth | A webhook only makes the server re-read the invoice from PayPal, so a forged event can't unlock anything. |
| No reminder spam | The Collector writes; code decides when, max 3 per payment. |
| Idempotency | The job id is the `PayPal-Request-Id`, so a retry never creates a second invoice. Refunds use one key per payment. |
| AI-written HTML is sandboxed | Served with `Content-Security-Policy: default-src 'none'` in a sandboxed iframe. Everything in the UI is HTML-escaped. |
| Public-demo hygiene | Each browser gets its own workspace; quotes are rate limited per visitor and per day; sandbox only (the server refuses the live PayPal API). |
| Crash-safe | A job interrupted mid-step goes back to a retryable state on restart. |

### Research this design follows

- **Beurer-Kellner et al., [*Design Patterns for Securing LLM Agents against Prompt Injections*](https://arxiv.org/abs/2506.08837) (2025).** Core principle: once an agent has read untrusted input, that input must not be able to trigger consequential actions. Branch Pay applies their **plan-then-execute** and **action-selector** patterns to the Biller (a fixed tool sequence whose money parameters are not exposed), and **context minimization** to the Builder (sees the request, has no tools, output sandboxed).
- **Debenedetti et al., [*Defeating Prompt Injections by Design*](https://arxiv.org/abs/2503.18813) (CaMeL, Google DeepMind, 2025).** Separate control flow from data flow, and attach capabilities to data. Here the amount and recipient flow only from the approved quote (server state) into PayPal calls; nothing the model reads can redirect them.
- **x402 (Coinbase, 2025)** revived HTTP 402 as a machine-readable payment signal for agents. Branch Pay's 402 responses carry a PayPal payment requirement in the same spirit, settled by a person paying a PayPal invoice instead of a stablecoin transfer.

## Run it locally

You need Node 20+.

1. **PayPal sandbox keys.** At <https://developer.paypal.com> open *Apps & Credentials* (Sandbox), create an app, copy its Client ID and Secret.
2. **Sandbox accounts.** Under *Sandbox > Accounts* use the **personal** account's email as the client email, and its password to pay at `https://www.sandbox.paypal.com`.
3. **Gemini key.** <https://aistudio.google.com/apikey>.

```bash
git clone https://github.com/shrestha-droid/branch-pay
cd branch-pay
npm install
cp .env.example .env     # then fill in the keys
npm start
```

Open <http://localhost:3000>. Run `npm test` for the payment-rule tests.

## Deploy

Click **Deploy to Render** above, paste your PayPal sandbox and Gemini keys when asked, and you get a public URL. Then, optionally, add a sandbox webhook in the PayPal developer dashboard pointing at `https://<your-app>.onrender.com/api/paypal/webhook` with `INVOICING.INVOICE.PAID` and `INVOICING.INVOICE.CANCELLED`, and set its id as `PAYPAL_WEBHOOK_ID`.

On Render's free plan the instance sleeps after 15 minutes idle and its disk is not persistent, so demo jobs are cleared on restart.

## Demo walkthrough (about 3 minutes)

1. Click **Fill example**, enter your sandbox personal email, **Get a quote**.
2. **Approve · 50% deposit first.** The Biller creates the invoice with a partial-payment minimum and sends it.
3. The Collector chases on its own (`AUTO_REMIND_MINUTES=2`), or click **Send reminder now**.
4. Pay the deposit (in PayPal as the sandbox buyer, or **Demo: pay deposit**). The Builder runs; a watermarked preview appears.
5. Pay the balance. The watermark goes and **Download** unlocks.
6. **Refund**: money back, deliverable locked again.
7. **Try a prompt injection**: watch the Scoper ignore it and the cap hold.
8. **Connect an AI agent**: request a quote from Claude or the MCP Inspector and watch it land in the pipeline.
9. **Ledger**: the whole book in AG Grid; export it as CSV.

## Project layout

```
src/config.ts         settings, price cap, limits, sandbox-only guard
src/paypal.ts         PayPal OAuth, Invoicing, Payments (refunds), webhook verification
src/agents.ts         Scoper, Biller, Collector, Builder
src/mcp.ts            MCP server for buyers' AI agents
src/store.ts          jobs in data/jobs.json, plus the pure payment rules
src/server.ts         HTTP routes, webhooks + polling, auto-reminders, rate limits, the 402 gate
src/*.test.ts         npm test: price cap, deposit, payment transitions, reminder schedule
public/index.html     the web UI (plain HTML + AG Grid from a CDN, no build step)
render.yaml           Render Blueprint
```

## Known limits

- Prototype: jobs live in a local JSON file, and rate limits are per process.
- The "Demo: pay" buttons are a sandbox shortcut (the merchant recording a payment), not a customer payment.
- The preview is watermarked, not hidden: its HTML is visible in view-source.
- Refunds of real PayPal payments use the invoice's PayPal transaction id as the capture id.

## License

MIT. See [LICENSE](LICENSE).
