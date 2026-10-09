import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, reconcileSorted, createSortKey } from '../dist/index.js';
const config = { version: 'v1', keys: [{ name: 'id', internal: [r => r.key], partner: [r => r.key] }],
  comparisons: [{ name: 'amount', internal: r => r.amount, partner: r => r.amount, kind: 'decimal', mismatchStatus: 'AMOUNT_MISMATCH' }] };
const metadata = { batchId: 'b', runId: 'r', processedAt: '2026-10-09T00:00:00Z', config };
const row = (key, amount = '1', id = key) => ({ id, data: { key, amount } });
const source = (sourceId, rows, complete = true) => ({ sourceId, rows, complete });
const collect = async generator => { const events = []; for await (const event of generator) events.push(event); return events; };

test('streaming agrees with in-memory matching, duplicates, missing and mismatch', async () => {
  const a = [row('a'), row('b'), row('c', '1', 'c1'), row('c', '1', 'c2'), row('e')];
  const b = [row('a'), row('b', '2'), row('c'), row('d')];
  const left = source('l', a), right = source('r', b, false);
  const expected = reconcile({ ...metadata, internal: left, partner: right });
  const events = await collect(reconcileSorted({ ...metadata, left, right, maxGroupRows: 3 }));
  const actual = events.filter(e => e.type === 'entry').map(e => e.entry);
  assert.deepEqual(actual.sort((a,b) => a.resultKey.localeCompare(b.resultKey)), [...expected.entries].sort((a,b) => a.resultKey.localeCompare(b.resultKey)));
  assert.deepEqual(events.at(-1).summary, expected.summary);
});

test('unsorted sources fail without a completion event', async () => {
  const events = [];
  await assert.rejects(async () => {
    for await (const event of reconcileSorted({ ...metadata, left: source('l', [row('b'), row('a')]), right: source('r', []) })) events.push(event);
  }, /not sorted/);
  assert.ok(events.every(event => event.type !== 'complete'));
});

test('oversized duplicate group stops at explicit budget and closes sources', async () => {
  let read = 0, closed = false;
  async function* rows() { try { while (true) { read++; yield row('a', '1', String(read)); } } finally { closed = true; } }
  await assert.rejects(collect(reconcileSorted({ ...metadata, left: source('l', rows()), right: source('r', []), maxGroupRows: 4 })), /exceeds maxGroupRows/);
  assert.equal(read, 5); // One bounded lookahead.
  assert.equal(closed, true);
});

test('large lazy sources use backpressure and emit output without accumulating arrays', async () => {
  let leftRead = 0, rightRead = 0, count = 0, summary;
  async function* rows(side) {
    for (let i = 0; i < 20000; i++) {
      if (side === 'l') leftRead++; else rightRead++;
      yield row(String(i).padStart(8, '0'));
    }
  }
  for await (const event of reconcileSorted({ ...metadata, left: source('l', rows('l')), right: source('r', rows('r')), maxGroupRows: 2 })) {
    if (event.type === 'entry') {
      count++;
      assert.ok(leftRead - count <= 1);
      assert.ok(rightRead - count <= 1);
    } else if (event.type === 'complete') summary = event.summary;
  }
  assert.equal(count, 20000);
  assert.equal(summary.matchedPairs, 20000);
});

test('cancellation and consumer early return close both input iterators', async () => {
  const closed = [];
  async function* rows(side) { try { for (const k of ['a','b','c']) yield row(k); } finally { closed.push(side); } }
  const controller = new AbortController();
  const stream = reconcileSorted({ ...metadata, left: source('l', rows('l')), right: source('r', rows('r')), signal: controller.signal });
  await stream.next(); controller.abort();
  await assert.rejects(stream.next(), { name: 'AbortError' });
  assert.deepEqual(closed.sort(), ['l','r']);
  closed.length = 0;
  const second = reconcileSorted({ ...metadata, left: source('l', rows('l')), right: source('r', rows('r')) });
  await second.next(); await second.return();
  assert.deepEqual(closed.sort(), ['l','r']);
});

test('source failure closes counterpart and never emits successful completion', async () => {
  let closed = false;
  async function* broken() { yield row('a'); throw Error('file read failed'); }
  async function* other() { try { yield row('a'); yield row('b'); } finally { closed = true; } }
  await assert.rejects(collect(reconcileSorted({ ...metadata, left: source('l', broken()), right: source('r', other()) })), /file read failed/);
  assert.equal(closed, true);
});

test('rejects alternative keys, invalid canonical keys and duplicate source IDs within group', async () => {
  const base = { ...metadata, left: source('l', []), right: source('r', []) };
  await assert.rejects(collect(reconcileSorted({ ...base, config: { ...config, keys: [...config.keys, { ...config.keys[0], name: 'other' }] } })), /exactly one/);
  await assert.rejects(collect(reconcileSorted({ ...base, left: source('l', [row('')]) })), /valid canonical key/);
  await assert.rejects(collect(reconcileSorted({ ...base, left: source('l', [row('a'), row('a')]) })), /row IDs/);
});

test('aggregates are emitted as bounded partials rather than accumulating dimension groups', async () => {
  const fields = { amount: r => r.amount, currency: () => 'USD' };
  const events = await collect(reconcileSorted({ ...metadata, config: { ...config, aggregates: { internal: fields, partner: fields } }, left: source('l', [row('a'), row('b')]), right: source('r', []) }));
  assert.equal(events.filter(e => e.type === 'aggregate').length, 2);
  assert.equal(events.at(-1).type, 'complete');
});

test('sort key preserves normalization and composite components', () => {
  const encode = createSortKey({ name: 'id', selectors: [r => r.a, r => r.b], normalize: v => v.trim() });
  assert.equal(encode({ a: ' x ', b: 'y' }), JSON.stringify(['id', ['x','y']]));
});
