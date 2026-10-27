import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineInvoices, depositFor, invoiceToChase, paymentEvent, reminderDue } from './store.js';

const inv = (o: Partial<{ paid: boolean; cancelled: boolean; paidAmount: number }> = {}) => ({
  paid: false,
  cancelled: false,
  paidAmount: 0,
  ...o,
});

test('deposit is half the total, in cents', () => {
  assert.equal(depositFor(450), 225);
  assert.equal(depositFor(99.99), 50); // 49.995 rounds up
  assert.equal(depositFor(1), 0.5);
});

test('full-payment plan: only a full payment unlocks', () => {
  const job = { status: 'invoiced' as const };
  assert.equal(paymentEvent(job, inv()), null);
  assert.equal(paymentEvent(job, inv({ paidAmount: 200 })), null); // partial money is not enough without a deposit plan
  assert.equal(paymentEvent(job, inv({ paid: true, paidAmount: 450 })), 'paid_in_full');
});

test('deposit plan: deposit -> preview, balance -> delivered', () => {
  const job = { status: 'invoiced' as const, deposit: 225 };
  assert.equal(paymentEvent(job, inv({ paidAmount: 224.99 })), null);
  assert.equal(paymentEvent(job, inv({ paidAmount: 225 })), 'deposit_paid');
  assert.equal(paymentEvent(job, inv({ paid: true, paidAmount: 450 })), 'paid_in_full'); // paid everything at once
  assert.equal(paymentEvent({ status: 'preview', deposit: 225 }, inv({ paidAmount: 300 })), null);
  assert.equal(paymentEvent({ status: 'preview', deposit: 225 }, inv({ paid: true })), 'balance_paid');
});

test('cancellation and finished jobs', () => {
  assert.equal(paymentEvent({ status: 'invoiced' }, inv({ cancelled: true })), 'cancelled');
  for (const status of ['quoted', 'delivered', 'refunded', 'cancelled'] as const) {
    assert.equal(paymentEvent({ status }, inv({ paid: true })), null, status);
  }
});

test('auto-reminders respect the interval, the cap, and the status', () => {
  const t0 = Date.parse('2026-10-14T12:00:00Z');
  const job = { status: 'invoiced' as const, dueSince: '2026-10-14T12:00:00Z' };
  assert.equal(reminderDue(job, t0 + 59_000, 1, 3), false);
  assert.equal(reminderDue(job, t0 + 60_000, 1, 3), true);
  assert.equal(reminderDue({ ...job, remindedAt: '2026-10-14T12:01:00Z', reminders: 1 }, t0 + 90_000, 1, 3), false);
  assert.equal(reminderDue({ ...job, reminders: 3 }, t0 + 1e9, 1, 3), false);
  assert.equal(reminderDue(job, t0 + 1e9, 0, 3), false); // turned off
  assert.equal(reminderDue({ ...job, status: 'delivered' }, t0 + 1e9, 1, 3), false);
});

const summary = (id: string, total: number, paidAmount: number, url: string) => ({
  id, status: paidAmount >= total ? 'MARKED_AS_PAID' : 'SENT', paid: paidAmount >= total, cancelled: false,
  paidAmount, dueAmount: total - paidAmount, recipientViewUrl: url, transactions: [],
});

test('deposit + balance invoices read as one payment and follow the same rules', () => {
  const job = { status: 'invoiced' as const, deposit: 225 };
  const nothing = combineInvoices(summary('D', 225, 0, 'pay-deposit'), summary('B', 225, 0, 'pay-balance'));
  assert.equal(paymentEvent(job, nothing), null);
  assert.equal(nothing.recipientViewUrl, 'pay-deposit');

  const depositOnly = combineInvoices(summary('D', 225, 225, 'pay-deposit'), summary('B', 225, 0, 'pay-balance'));
  assert.equal(depositOnly.paidAmount, 225);
  assert.equal(paymentEvent(job, depositOnly), 'deposit_paid');
  assert.equal(depositOnly.recipientViewUrl, 'pay-balance'); // the client is sent to the balance next

  const both = combineInvoices(summary('D', 225, 225, ''), summary('B', 225, 225, ''));
  assert.equal(paymentEvent({ status: 'preview', deposit: 225 }, both), 'balance_paid');
  assert.equal(paymentEvent(job, both), 'paid_in_full');
});

test('reminders chase the right invoice', () => {
  const pair = { deposit: 225, balanceInvoice: { id: 'B' } };
  assert.equal(invoiceToChase({ ...pair, invoice: { id: 'D', status: 'SENT', paid: 0 } }), 'D');
  assert.equal(invoiceToChase({ ...pair, invoice: { id: 'D', status: 'SENT', paid: 225 } }), 'B');
  assert.equal(invoiceToChase({ deposit: 225, invoice: { id: 'ONE', status: 'PARTIALLY_PAID', paid: 225 } }), 'ONE');
  assert.equal(invoiceToChase({ invoice: { id: 'ONE', status: 'SENT', paid: 0 } }), 'ONE');
});
