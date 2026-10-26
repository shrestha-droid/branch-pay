import 'dotenv/config';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID ?? '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
    // Sandbox by default. Real money lives at https://api-m.paypal.com
    baseUrl: (process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, ''),
    merchantEmail: process.env.PAYPAL_MERCHANT_EMAIL ?? '',
    businessName: process.env.BUSINESS_NAME ?? 'Branch Pay Demo Studio',
    // Optional. Set it to verify webhook signatures. Polling still works without webhooks.
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? '',
  },
  gemini: {
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
    // Tried in order when the main model is busy or unavailable. Lite first: fast and rarely overloaded.
    fallbacks: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-flash-lite-latest,gemini-3.8-flash')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },
  // Hard ceiling on any quote, enforced in code. The AI cannot talk its way past this.
  maxQuoteUsd: num(process.env.MAX_QUOTE_USD, 500),
  pollMs: 5000,
  maxReminders: 3,
  // Optional spending mandate: quotes at or under this are approved without a human. 0 = always ask.
  autoApproveUnderUsd: Number(process.env.AUTO_APPROVE_UNDER_USD ?? 0) || 0,
  // Public deployments: new quotes allowed per visitor IP per hour, and in total per day.
  quotesPerIpHour: num(process.env.QUOTES_PER_IP_HOUR, 10),
  quotesPerDay: num(process.env.QUOTES_PER_DAY, 200),
  // The Collector chases unpaid invoices on its own this often. 0 turns it off (button only).
  autoRemindMinutes: Number(process.env.AUTO_REMIND_MINUTES ?? 60) || 0,
};

// Safety: this project is a sandbox demo. Refuse to start against the live PayPal API.
if (config.paypal.baseUrl === 'https://api-m.paypal.com') {
  throw new Error(
    'PAYPAL_BASE_URL points at LIVE PayPal. This project is sandbox-only. Remove PAYPAL_BASE_URL from .env.',
  );
}

export const paypalConfigured = Boolean(config.paypal.clientId && config.paypal.clientSecret);
export const geminiConfigured = Boolean(config.gemini.apiKey);
