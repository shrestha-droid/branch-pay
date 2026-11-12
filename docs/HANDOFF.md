# Branch Pay: project handoff

**Status as of November 12, 2026, 10:45 pm IST: submitted.** This document explains the whole project to a new teammate and to her AI assistant. Paste all of it into the assistant as context.

> **Note to the AI reading this:** Treat this as background on an existing project. The code in the repo is the source of truth, so read it before changing anything, and flag anything here that no longer matches. Do not claim something works unless it is listed as tested below. Never ask anyone to paste API keys or secrets into chat.

| | |
|---|---|
| **Live app** | <https://branch-pay.onrender.com> |
| **Code** | <https://github.com/shrestha-droid/branch-pay> (public, MIT license) |
| **Hackathon** | [PayPal AI Hackathon on Devpost](https://paypalaihackathon.devpost.com/) |
| **Deadline** | November 13, 2026, 1:30 am IST (November 12, 12:00 pm PT) |
| **Submission** | <https://devpost.com/software/branch-pay> (submitted November 12; editable until the deadline) |
| **Demo video** | <https://www.youtube.com/watch?v=xjuUCSi5NvY> (2:13) |

The live app is on Render's free plan. It sleeps when idle, so the first request can take about a minute (46 seconds on November 1).

---

## 1. What it is

Branch Pay runs the money side of a freelance or small-agency job. Four AI agents quote the work, bill it through PayPal, chase the payment, and release the work only when PayPal reports that it is paid. People approve every move that touches money.

**The problem:** freelancers and small agencies lose time and money on the loop around the work: writing quotes, sending invoices, chasing late payments, and deciding when it is safe to hand over the files.

**The audience:** freelancers and small agencies. The client can be a person in the dashboard or the client's own AI assistant, connected over MCP (Model Context Protocol, the standard way AI assistants connect to outside tools).

**The tagline on the site:** "The work ships when the invoice clears."

Everything runs in the PayPal sandbox. No real money moves, and the server refuses to start against the live PayPal API.

---

## 2. How a job moves through the system

1. **Request.** A client describes the work in the dashboard, or an AI assistant calls `request_quote`.
2. **Scoper agent** turns it into a fixed-price quote. The price cap is enforced in code ($500 by default). It also lists any instructions hidden in the request that it ignored.
3. **Human approval.** Someone approves the quote, billed in full or with a 50% deposit first. Nothing reaches PayPal before this step. An optional spending limit (`AUTO_APPROVE_UNDER_USD`, off by default) can approve small quotes automatically.
4. **Biller agent** creates and sends the PayPal invoice. Code fixes the tool order: create, then send. The model only writes the note and picks the payment terms. It cannot choose the amount or the recipient.
5. **Collector agent** writes payment reminders and PayPal sends them. It can run from a button or on a timer, with at most 3 reminders per payment.
6. **Payment detection.** The server polls PayPal every 5 seconds. PayPal webhooks are supported as an instant trigger, but they are not set up on the live site yet.
7. **Builder agent** generates a one-page website once payment is confirmed.
   - **Paid in full:** the final site is unlocked.
   - **Deposit paid:** the client sees a watermarked preview. Paying the balance unlocks the final, downloadable site.
8. **Refund (optional).** A person presses Refund, the money goes back, and the work locks again.

Until payment is confirmed, the work's URL answers **HTTP 402 Payment Required**, with a machine-readable PayPal payment link.

### Job statuses

`quoted`, `invoicing`, `invoiced`, `paid`, `delivering`, `preview`, `delivered`, plus the exits `refunded`, `cancelled` and `failed`.

### The two kinds of deposit plan

PayPal only offers partial payments on invoices in some merchant countries, and our sandbox merchant's country is not one of them. So the Biller tries both:

1. **Native partial payment:** one invoice with `allow_partial_payment` and `minimum_amount_due`.
2. **Fallback, used on the live site:** a deposit invoice and a balance invoice, both sent at approval.

The server reads the pair as one payment (`combineInvoices` in `src/store.ts`), so the rest of the payment logic is the same for both.

---

## 3. Tech stack

| Part | What we use |
|---|---|
| Server | TypeScript, Express 5, run with `tsx` (no build step) |
| Web UI | One file, `public/index.html`: plain HTML, CSS and JavaScript |
| AI | Google Gemini through the Vercel AI SDK |
| Payments | PayPal REST APIs, hand-written in `src/paypal.ts` so each call is visible |
| Agent access | MCP over Streamable HTTP, using the official TypeScript SDK |
| Ledger table | AG Grid Community 36.2.0, loaded from a CDN |
| Hosting | Render free plan. Pushing to `main` deploys automatically. |
| Storage | `data/jobs.json` on the server's disk. Jobs older than 14 days are dropped. |

### PayPal APIs used (10 endpoints)

- **OAuth 2.0:** get an access token.
- **Invoicing v2:** create, send, get, remind, cancel, record a payment, record a refund.
- **Payments v2:** refund a capture.
- **Webhooks:** verify a webhook signature.

### Gemini models

Models are tried in this order: `gemini-flash-latest`, then `gemini-flash-lite-latest`, then `gemini-3.8-flash`. A model that fails is skipped for 5 minutes. Every call has a hard timeout.

**Do not use Gemini 2.x.** Those models no longer work with our keys. Availability changes through the day, and `/api/health` shows the current state of each model.

---

## 4. Code map

| File | Lines | What it does |
|---|---|---|
| `src/server.ts` | 547 | HTTP routes, payment polling, webhooks, reminders, rate limits, the 402 gate |
| `src/agents.ts` | 357 | The four agents and the Gemini fallback chain |
| `src/paypal.ts` | 279 | PayPal client |
| `src/store.ts` | 208 | Job storage plus the pure payment rules |
| `src/mcp.ts` | 122 | MCP server for clients' AI assistants |
| `src/config.ts` | 50 | Settings, limits, the sandbox-only guard |
| `src/payments.test.ts`, `src/quote.test.ts` | 105 | The 9 automated tests |
| `public/index.html` | 854 | The entire web UI |
| `README.md` | | Public project documentation |
| `SUBMISSION.md` | | Devpost text, video script, judge Q&A |
| `render.yaml` | | Render deployment settings |
| `docs/cover.png` | | Devpost thumbnail, now out of date (see section 10) |

### HTTP routes

| Route | Purpose |
|---|---|
| `GET /api/config` | Public settings and whether keys are configured |
| `GET /api/health` | Live check of PayPal and each Gemini model, cached 30 seconds |
| `GET /api/jobs` | Jobs in this browser's workspace (needs an `X-Workspace` header) |
| `POST /api/jobs` | Create a job and run the Scoper |
| `GET /api/jobs/:id` | Read one job |
| `POST /api/jobs/:id/requote` | Retry a failed quote |
| `POST /api/jobs/:id/approve` | Approve, with `{"deposit": true}` for the deposit plan |
| `POST /api/jobs/:id/sandbox-pay` | Demo shortcut: record a payment without a buyer login |
| `POST /api/jobs/:id/refresh` | Check PayPal now |
| `POST /api/jobs/:id/remind` | Run the Collector now |
| `POST /api/jobs/:id/cancel` | Cancel an unpaid invoice |
| `POST /api/jobs/:id/refund` | Refund everything paid |
| `POST /api/jobs/:id/deliver` | Retry a failed build |
| `GET /api/jobs/:id/deliverable` | The work: 402, a watermarked preview, or the final site. Add `?download` for a file. |
| `POST /api/paypal/webhook` | PayPal webhook receiver |
| `POST /mcp/:workspace` | MCP endpoint |

### MCP tools

| Tool | What it does |
|---|---|
| `request_quote` | Ask for a quote. The job lands in that workspace's pipeline. |
| `get_job` | Read status, the PayPal pay link, and the deliverable link once unlocked |
| `list_jobs` | List the workspace's jobs |

A client's AI cannot approve, change a price, pay, cancel or refund. There is no tool for any of those.

### Workspaces

Each browser creates a random workspace id and keeps it in `localStorage`, so visitors only see their own jobs. The MCP URL (`/mcp/<workspace>`) is on the **AI agents** tab. Job ids are random UUIDs and act as access tokens for those jobs.

---

## 5. Safety design

The rule is: **the AI proposes, the code enforces, a person approves.**

- **Money never comes from the model.** Amounts, the deposit and the recipient come from the approved quote stored on the server. The Biller's tools have no input for them.
- **The price cap is enforced in code,** rounding included, and it is tested.
- **Prompt injection can't reach an action.** The client's text can only influence a quote, which code clamps and a person approves. The Scoper's "ignored instructions" list is for visibility only; safety does not depend on it.
- **Refund and cancel are human-only.** No agent has a tool for either.
- **Webhooks are a nudge.** A webhook only makes the server re-read the invoice from PayPal, so a forged event can't unlock anything.
- **Retries are safe.** The job id is the PayPal request id, so a retry can't create a second invoice.
- **AI-written HTML is locked down** with a strict Content-Security-Policy and a sandboxed iframe.
- **The public demo is limited:** 10 quotes per visitor per hour and 200 per day, and workspaces keep visitors apart.

This design follows two 2025 papers:

- [Design Patterns for Securing LLM Agents against Prompt Injections](https://arxiv.org/abs/2506.08837)
- [Defeating Prompt Injections by Design (CaMeL)](https://arxiv.org/abs/2503.18813)

The 402 response is inspired by [x402](https://www.spark.money/research/x402-protocol-ai-agent-payments). It is not an implementation of x402: payment happens when a person pays a PayPal invoice, not through a stablecoin transfer.

---

## 6. What has been tested

| Check | Result | How |
|---|---|---|
| Automated tests | 10 of 10 pass (rerun November 12) | `npm test` |
| Whole flow clicked through in the live UI, recorded for the demo video: quote, deposit invoices, reminder, deposit, watermarked preview, balance, download, prompt injection, an MCP `request_quote` approved and invoiced, ledger bulk reminder, refund | Passed, November 12 | Scripted browser (Chrome DevTools Protocol) on the live site |
| Automatic reminders on the live site | Fired every 2 minutes and stopped at 3, November 12 | Job log |
| Live PayPal and Gemini connection | Working (November 1). `gemini-3.8-flash` timed out on that check; the other two models answered. | `/api/health` |
| Pay-in-full flow: quote, invoice, reminder, 402, payment, build, download, refund, locked again | Passed on the live sandbox, October 27 | Scripted API calls |
| Deposit flow, two-invoice version: same steps plus the watermarked preview and balance | Passed on the live sandbox, October 27 | Scripted API calls |
| Prompt injection | Blocked on October 27: 4 hidden instructions listed and ignored, quote stayed at $400, client email unchanged | Scripted API call, stopped at the quote |
| MCP `request_quote` | Returned a real quote on October 27 | Raw JSON-RPC calls |
| Redesigned UI | Checked on desktop and phone width with sample jobs, and the live home page was screenshotted | Browser |

Payments in those tests used the demo shortcut, which records a payment as the merchant.

### Not tested yet

- A **real buyer payment** from the sandbox Personal account, and refunding it. This refund path uses the invoice's PayPal transaction id as the capture id, which is an assumption until it is run.
- Connecting a **real AI client** (Claude or similar) to the live MCP URL.
- **PayPal webhooks** on the live site. They are built but not configured (`PAYPAL_WEBHOOK_ID` is not set).
- **Native partial payments.** Our sandbox merchant's country doesn't allow them, so that path has only been rejected by PayPal, never completed.
- The **`AUTO_APPROVE_UNDER_USD`** spending limit.

---

## 7. Known limits

- On Render's free plan the app sleeps after 15 minutes idle. **Its disk resets, so jobs can disappear after a sleep, restart or deploy.** Keep this in mind while recording and during judging.
- Render's free hours are shared across the whole workspace, and it runs several other free services.
- Rate limits live in memory, per server process.
- The preview is watermarked, not hidden. Its HTML can still be read in view-source.
- The live merchant is sandbox-only, and the "Demo: pay" buttons are a shortcut, not a customer payment.

---

## 8. Run it locally

You need Node 20 or newer, your own PayPal sandbox app, and your own Gemini key.

1. At <https://developer.paypal.com>, open **Apps & Credentials**, switch to **Sandbox**, and create an app. Copy the Client ID and Secret.
2. Under **Testing Tools → Sandbox Accounts**, note the **Personal** account's email. Use it as the client email, and use its password to pay at <https://www.sandbox.paypal.com>.
3. Create a Gemini key at <https://aistudio.google.com/apikey>.

```bash
git clone https://github.com/shrestha-droid/branch-pay
cd branch-pay
npm install
cp .env.example .env
npm start
```

Fill in `.env` before `npm start`, then open <http://localhost:3000>.

```bash
npm test
npm run typecheck
```

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | none | Required for billing |
| `GOOGLE_GENERATIVE_AI_API_KEY` | none | Required for all agents |
| `PAYPAL_WEBHOOK_ID` | none | Turns on webhook signature checks |
| `PAYPAL_MERCHANT_EMAIL` | none | Optional invoice sender |
| `BUSINESS_NAME` | Branch Pay Demo Studio | Name on invoices |
| `GEMINI_MODEL` | `gemini-flash-latest` | Main model |
| `GEMINI_FALLBACK_MODELS` | `gemini-flash-lite-latest,gemini-3.8-flash` | Tried in order |
| `MAX_QUOTE_USD` | 500 | Hard price cap |
| `AUTO_REMIND_MINUTES` | 60 in code, 2 in `.env.example` and on Render | Reminder timer. 0 turns it off. |
| `AUTO_APPROVE_UNDER_USD` | 0 | Spending limit. 0 means a person approves every quote. |
| `QUOTES_PER_IP_HOUR`, `QUOTES_PER_DAY` | 10, 200 | Rate limits |

Never commit `.env`. Pushing to `main` deploys the live site.

---

## 9. Hackathon rules and how we score

**Required for submission:**

- A project that meaningfully uses both PayPal and AI, using the free sandbox.
- A text description of the features.
- A working demo: a hosted URL or complete setup instructions.
- A list of the AI tools used and how they were used.
- A public repo with a license visible at the top. This is done.
- A public YouTube video **under 3 minutes**, showing the project working. It must not use copyrighted music or third-party trademarks without permission.

**Judging criteria:** technological implementation, design, potential impact, innovation, and presentation.

**Prizes we are aiming for:**

| Prize | Why we fit |
|---|---|
| 1st to 3rd place ($12,000, $8,000, $5,000) | Overall strength |
| Best Use of PayPal + AI ($5,000) | 10 PayPal endpoints across the whole invoice lifecycle |
| Best Use of Agentic Commerce ($5,000) | Clients' AI assistants can hire the agency over MCP |
| Best Demo Delivery ($5,000) | Depends on the video |
| Most Impactful ($5,000) | Solves a specific problem for freelancers |
| Best Use of AG Grid ($5,000 top prize) | The Ledger view |
| Best Use of Render (credits) | Hosted on Render, with a one-click Blueprint |

Check Devpost for how category entry works and for any rule changes.

---

## 10. What's left

The entry is submitted. Until the deadline it can still be edited on Devpost.

- **Teammates:** add them from the project's "Manage team" page on Devpost (the submission is marked as a Team entry).
- **Gemini quota:** the key is on the free tier (20 requests a day on the main model, reset at 1:30 pm IST). The agents fall back to the lite model, which is slower. Turning on billing for the key removes the limit while judges test.
- **Render:** the free plan sleeps after 15 minutes idle and wipes jobs on restart. A paid plan during judging keeps it awake.
- **Night of November 12:** Gemini was overloaded. The Biller was cut to one AI step (the code sends the invoice), and a backup model now gets 90 seconds to build a site. Failed builds retry on their own, up to 5 times.

---

## 11. Design rules

The owner rejected an earlier design with glowing backgrounds, glass cards and gradient text because it looked AI-generated. Keep the current direction.

**Concept:** an accounts-receivable ledger book.

- **Colors:** ledger paper `#f1efe7`, ink `#121826`, pen blue `#1f3fa0`, margin red `#b3261e`, paid green `#1f6b45`.
- **Fonts:** Fraunces (headlines), Instrument Sans (body), DM Mono (labels and amounts).
- **Hero object:** a paper invoice whose rubber stamp moves from 402 to Deposit to Paid.
- **Style:** flat ruled panels, numbered mono labels, stamp-style statuses, accounting double rules under totals, and square ink buttons with a blue offset shadow.
- **Avoid:** glow, glass, gradient text, heavy animation, and rounded card grids.

---

## 12. Rules for working on this project

- The price, recipient and deposit must never come from model output.
- Do not give any agent a refund, cancel or approve tool.
- Use Gemini 3 or newer only.
- Keep the UI in `public/index.html` unless there's a strong reason to add a build step.
- Keep changes small, and add a test when you change money logic.
- Run `npm test` and `npm run typecheck` before pushing.
- Say what was actually tested. Don't describe the sandbox demo shortcut as a real customer payment.
- Check judge-facing claims against this document, especially section 6.
- Use your own keys. Never put keys or secrets in the repo or in chat.
