import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcile,
  createReconciler,
  reconcilePartitions,
  ReconciliationInputError,
} from '../dist/index.js';

const config = {
  version: 'v1',
  keys: [
    { name: 'transaction', internal: [(r) => r.tx], partner: [(r) => r.tx] },
    { name: 'reference', internal: [(r) => r.ref], partner: [(r) => r.ref] },
  ],
  comparisons: [
    {
      name: 'amount',
      internal: (r) => r.amount,
      partner: (r) => r.amount,
      kind: 'decimal',
      mismatchStatus: 'AMOUNT_MISMATCH',
    },
    {
      name: 'fee',
      internal: (r) => r.fee,
      partner: (r) => r.fee,
      kind: 'decimal',
      mismatchStatus: 'FEE_MISMATCH',
    },
    {
      name: 'status',
      internal: (r) => r.status,
      partner: (r) => r.status,
      kind: 'exact',
      mismatchStatus: 'STATUS_MISMATCH',
    },
    {
      name: 'currency',
      internal: (r) => r.currency,
      partner: (r) => r.currency,
      kind: 'exact',
      mismatchStatus: 'CURRENCY_MISMATCH',
    },
    {
      name: 'type',
      internal: (r) => r.type,
      partner: (r) => r.type,
      kind: 'exact',
      mismatchStatus: 'TYPE_MISMATCH',
    },
  ],
};
const record = (tx, overrides = {}) => ({
  tx,
  amount: '100.00',
  fee: '1.00',
  status: 'SUCCESS',
  currency: 'VND',
  type: 'PAYMENT',
  ...overrides,
});
const rows = (records) => records.map((data, i) => ({ id: `row-${i}`, line: i + 2, data }));
const input = (left, right, overrides = {}) => ({
  batchId: 'batch-1',
  runId: 'attempt-1',
  processedAt: '2026-10-09T00:00:00Z',
  config,
  internal: { sourceId: 'internal', complete: true, rows: rows(left) },
  partner: { sourceId: 'partner', complete: true, rows: rows(right) },
  ...overrides,
});

test('matched pairs retain source line/ID, full original data and do not mutate input', () => {
  const value = input([record('a')], [record('a')]);
  const before = structuredClone(value.internal);
  const result = reconcile(value);
  assert.equal(result.summary.matchedPairs, 1);
  assert.equal(result.matchedRows.internal[0].line, 2);
  assert.deepEqual(result.entries[0].matchedBy, ['transaction']);
  assert.deepEqual(value.internal, before);
});

test('reports simultaneous discrepancies and signed exact decimal differences', () => {
  const result = reconcile(
    input(
      [record('a')],
      [
        record('a', {
          amount: '99.5',
          fee: '2',
          status: 'FAILED',
          currency: 'USD',
          type: 'REFUND',
        }),
      ],
    ),
  );
  assert.deepEqual(
    new Set(result.entries[0].statuses),
    new Set([
      'AMOUNT_MISMATCH',
      'FEE_MISMATCH',
      'STATUS_MISMATCH',
      'CURRENCY_MISMATCH',
      'TYPE_MISMATCH',
    ]),
  );
  assert.equal(result.entries[0].issues[0].difference, '0.5');
  assert.equal(result.errorRows.length, 1);
});

test('decimal tolerance handles huge and negative values without floating point', () => {
  const rules = { ...config, comparisons: [{ ...config.comparisons[0], tolerance: '0.01' }] };
  const result = reconcile(
    input(
      [record('a', { amount: '-9007199254740993.01' })],
      [record('a', { amount: '-9007199254740993.00' })],
      { config: rules },
    ),
  );
  assert.equal(result.entries[0].status, 'MATCHED');
  assert.equal(
    reconcile(input([record('a', { amount: '-0.00' })], [record('a', { amount: '0' })])).entries[0]
      .status,
    'MATCHED',
  );
});

test('equal amount/time alone cannot match different identifiers', () => {
  const result = reconcile(input([record('a')], [record('b')]));
  assert.deepEqual(
    result.entries.map((e) => e.status),
    ['MISSING_PARTNER', 'MISSING_INTERNAL'],
  );
});

test('incomplete counterpart sources defer missing conclusions in either direction', () => {
  const value = input([record('a')], [record('b')]);
  value.internal.complete = value.partner.complete = false;
  const result = reconcile(value);
  assert.equal(result.summary.pendingEntries, 2);
  assert.equal(result.summary.byStatus.MISSING_INTERNAL, undefined);
});

test('duplicate stable identifiers never arbitrarily select a match', () => {
  const result = reconcile(input([record('a'), record('a')], [record('a')]));
  assert.equal(result.summary.matchedPairs, 0);
  assert.equal(result.entries.length, 3);
  assert.ok(result.entries.every((e) => e.status === 'MANUAL_REVIEW'));
  assert.ok(result.entries[0].issues.some((i) => i.code === 'DUPLICATE_KEY'));
});

test('conflicting alternative keys defer the whole ambiguous matching graph', () => {
  const result = reconcile(
    input(
      [record('a', { ref: 'r2' }), record('b', { ref: 'r1' })],
      [record('a', { ref: 'r1' }), record('b', { ref: 'r2' })],
    ),
  );
  assert.equal(result.summary.matchedPairs, 0);
  assert.equal(result.summary.manualReviewEntries, 4);
});

test('missing/invalid keys and numeric money values are reviewable row errors', () => {
  assert.equal(reconcile(input([record(undefined)], [])).entries[0].status, 'MANUAL_REVIEW');
  assert.equal(
    reconcile(input([record('a', { amount: 100 })], [record('a')])).entries[0].status,
    'MANUAL_REVIEW',
  );
  assert.equal(
    reconcile(input([record('a', { amount: undefined })], [record('a')])).entries[0].status,
    'PENDING_RECHECK',
  );
});

test('duplicate source row IDs reject the import, not silently deduplicate', () => {
  const value = input([record('a'), record('b')], []);
  value.internal.rows[1].id = value.internal.rows[0].id;
  assert.throws(() => reconcile(value), ReconciliationInputError);
});

test('retry and concurrent invocations give stable result identities and no writes', async () => {
  const value = input([record('a')], [record('a')]);
  const first = reconcile(value);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() => reconcile({ ...value, runId: `retry-${i}` })),
    ),
  );
  for (const result of results) {
    assert.equal(result.entries[0].resultKey, first.entries[0].resultKey);
    assert.deepEqual(result.matchedRows, first.matchedRows);
  }
  assert.notEqual(
    reconcile({ ...value, config: { ...config, version: 'v2' } }).entries[0].resultKey,
    first.entries[0].resultKey,
  );
});

test('refund, partial refund, reversal and settlement are compared as explicit events', () => {
  const events = [
    record('payment'),
    record('refund', { type: 'REFUND', amount: '-100' }),
    record('partial', { type: 'PARTIAL_REFUND', amount: '-25' }),
    record('reversal', { type: 'REVERSAL', amount: '-100' }),
    record('settlement', { type: 'SETTLEMENT', amount: '99' }),
  ];
  const result = reconcile(input(events, structuredClone(events)));
  assert.equal(result.summary.matchedPairs, 5);
  const mixed = reconcile(input([events[1]], [record('refund')]));
  assert.ok(mixed.entries[0].statuses.includes('TYPE_MISMATCH'));
});

test('explicit pending business policy and failing callbacks are traceable', () => {
  const value = input([record('a')], [record('a')]);
  assert.equal(
    reconcile({ ...value, config: { ...config, defer: () => 'Settlement not closed' } }).entries[0]
      .status,
    'PENDING_RECHECK',
  );
  assert.equal(
    reconcile({
      ...value,
      config: {
        ...config,
        defer: () => {
          throw Error();
        },
      },
    }).entries[0].status,
    'MANUAL_REVIEW',
  );
  const broken = {
    ...config,
    comparisons: [
      {
        ...config.comparisons[0],
        internal: () => {
          throw Error();
        },
      },
    ],
  };
  assert.equal(reconcile({ ...value, config: broken }).entries[0].issues[0].code, 'INVALID_VALUE');
});

test('aggregates preserve currency/type/date and surface invalid values', () => {
  const fields = {
    amount: (r) => r.amount,
    currency: (r) => r.currency,
    transactionType: (r) => r.type,
    businessDate: (r) => r.date,
  };
  const events = [
    record('a', { amount: '0.1', date: '2026-10-09' }),
    record('b', { amount: '0.2', date: '2026-10-09' }),
    record('c', { amount: 'bad', date: '2026-10-09' }),
  ];
  const result = reconcile(
    input(events, [], { config: { ...config, aggregates: { internal: fields, partner: fields } } }),
  );
  assert.equal(result.aggregates[0].totalAmount, '0.3');
  assert.equal(result.aggregates[0].invalidAmountCount, 1);
  assert.equal(result.aggregateIssues.length, 1);
});

test('factory snapshots configuration arrays', () => {
  const rules = {
    ...config,
    keys: [...config.keys],
    comparisons: config.comparisons.map((r) => ({ ...r })),
  };
  const factory = createReconciler(rules);
  rules.comparisons[0].internal = () => '0';
  rules.keys.length = 0;
  const { config: ignored, ...value } = input([record('a')], [record('a')]);
  assert.equal(factory.reconcile(value).entries[0].status, 'MATCHED');
});

test('partition failure can resume at caller checkpoint without changing earlier identities', async () => {
  const good = { partitionId: 'p1', input: input([record('a')], [record('a')]) };
  const bad = { partitionId: 'p2', input: input([record('b')], [record('b')], { runId: '' }) };
  const iterator = reconcilePartitions([good, bad]);
  const first = (await iterator.next()).value;
  await assert.rejects(iterator.next(), ReconciliationInputError);
  const repaired = { ...bad, input: { ...bad.input, runId: 'retry' } };
  const recovered = [];
  for await (const result of reconcilePartitions([repaired])) recovered.push(result);
  assert.equal(recovered[0].result.summary.matchedPairs, 1);
  assert.equal(first.result.entries[0].resultKey, reconcile(good.input).entries[0].resultKey);
});

test('rejects invalid financial configuration and repeated partitions', async () => {
  assert.throws(
    () =>
      reconcile(
        input([], [], {
          config: { ...config, comparisons: [{ ...config.comparisons[0], tolerance: '-0.1' }] },
        }),
      ),
    ReconciliationInputError,
  );
  const partition = { partitionId: 'p', input: input([], []) };
  const iterator = reconcilePartitions([partition, partition]);
  await iterator.next();
  await assert.rejects(iterator.next(), /Partition IDs/);
});
