import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuote } from './agents.js';
import { config } from './config.js';

const quote = (...amounts: number[]) => ({
  title: ' Site ',
  summary: 'A site.',
  items: amounts.map((amount, i) => ({ name: `Item ${i}`, description: 'x', amount })),
  ignoredInstructions: [],
});

test('a quote under the cap is left alone', () => {
  const q = normalizeQuote(quote(100, 50.5));
  assert.deepEqual(q.items.map((i) => i.amount), [100, 50.5]);
  assert.equal(q.total, 150.5);
  assert.equal(q.title, 'Site');
});

test('an AI that ignores the cap is scaled under it, even after rounding', () => {
  for (const amounts of [[10_000], [333.33, 333.33, 333.34], [999.99, 1, 1, 1, 1, 1], [501, 0.01]]) {
    const q = normalizeQuote(quote(...amounts));
    assert.ok(q.total <= config.maxQuoteUsd, `${amounts} -> ${q.total}`);
    assert.ok(q.items.every((i) => i.amount >= 1));
  }
});
