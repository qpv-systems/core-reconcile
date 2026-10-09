import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../dist/index.js';
const config = {
  version: '1',
  keys: [{ name: 'id', internal: [(r) => r.id], partner: [(r) => r.id] }],
  comparisons: [
    {
      name: 'amount',
      internal: (r) => r.amount,
      partner: (r) => r.amount,
      kind: 'decimal',
      mismatchStatus: 'AMOUNT_MISMATCH',
    },
  ],
};
function run(a, b, rules = config) {
  return reconcile({
    batchId: 'b',
    runId: 'r',
    processedAt: '2026-10-09T00:00:00Z',
    config: rules,
    internal: {
      sourceId: 'i',
      complete: true,
      rows: a.map((data, i) => ({ id: String(i), data })),
    },
    partner: { sourceId: 'p', complete: true, rows: b.map((data, i) => ({ id: String(i), data })) },
  });
}
test('different secondary identifiers require review even when primary ID matches', () => {
  const rules = {
    ...config,
    keys: [...config.keys, { name: 'ref', internal: [(r) => r.ref], partner: [(r) => r.ref] }],
  };
  const result = run(
    [{ id: 'a', ref: 'x', amount: '1' }],
    [{ id: 'a', ref: 'y', amount: '1' }],
    rules,
  );
  assert.equal(result.entries[0].status, 'MANUAL_REVIEW');
  assert.equal(result.entries[0].issues[0].code, 'IDENTIFIER_CONFLICT');
});
test('composite keys do not collide at separators', () => {
  const rules = {
    ...config,
    keys: [
      {
        name: 'composite',
        internal: [(r) => r.id, (r) => r.ref],
        partner: [(r) => r.id, (r) => r.ref],
      },
    ],
  };
  const result = run(
    [{ id: 'a|b', ref: 'c', amount: '1' }],
    [{ id: 'a', ref: 'b|c', amount: '1' }],
    rules,
  );
  assert.equal(result.summary.matchedPairs, 0);
});
test('duplicate-heavy input remains ambiguous with each source row represented once', () => {
  const a = Array.from({ length: 2000 }, () => ({ id: 'a', amount: '1' }));
  const result = run(a, a);
  assert.equal(result.summary.manualReviewEntries, 4000);
  assert.equal(result.entries.length, 4000);
});
test('explicit normalization can map partner transaction statuses', () => {
  const rules = {
    ...config,
    comparisons: [
      {
        name: 'status',
        kind: 'exact',
        internal: (r) => r.status,
        partner: (r) => r.status,
        normalize: (v, side) => (side === 'partner' && v === '00' ? 'SUCCESS' : v),
      },
    ],
  };
  assert.equal(
    run([{ id: 'a', status: 'SUCCESS' }], [{ id: 'a', status: '00' }], rules).entries[0].status,
    'MATCHED',
  );
});
test('missing value behavior is explicitly configurable', () => {
  const a = [{ id: 'a' }];
  assert.equal(run(a, a).entries[0].status, 'PENDING_RECHECK');
  assert.equal(
    run(a, a, { ...config, comparisons: [{ ...config.comparisons[0], missing: 'review' }] })
      .entries[0].status,
    'MANUAL_REVIEW',
  );
  assert.equal(
    run(a, a, { ...config, comparisons: [{ ...config.comparisons[0], missing: 'ignore' }] })
      .entries[0].status,
    'MATCHED',
  );
});
test('negative and fractional totals retain decimal zeros correctly', () => {
  const fields = { amount: (r) => r.amount, currency: () => 'USD' };
  const rules = { ...config, aggregates: { internal: fields, partner: fields } };
  const a = [
    { id: 'a', amount: '-100.10' },
    { id: 'b', amount: '0.10' },
  ];
  assert.equal(run(a, a, rules).aggregates[0].totalAmount, '-100');
  assert.equal(run([{ id: 'a', amount: '0.00100' }], [], rules).aggregates[0].totalAmount, '0.001');
});
