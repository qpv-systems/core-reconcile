// Standalone constrained-heap smoke test: no input/output arrays.
import assert from 'node:assert/strict';
import { reconcileSorted } from '../dist/index.js';
const count = Number(process.argv[2] ?? 100000);
assert.ok(
  Number.isSafeInteger(count) && count > 0 && count < 1000000000,
  'Count must be a positive integer below one billion',
);
const started = performance.now();
let sampledMaxHeap = 0,
  sampledMaxRss = 0;
function sampleMemory() {
  const { heapUsed, rss } = process.memoryUsage();
  sampledMaxHeap = Math.max(sampledMaxHeap, heapUsed);
  sampledMaxRss = Math.max(sampledMaxRss, rss);
}
sampleMemory();
async function* rows() {
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(9, '0');
    yield { id, data: { id, amount: '123.45' } };
  }
}
let matched = 0;
for await (const event of reconcileSorted({
  batchId: 'memory-check',
  runId: '1',
  processedAt: '2026-10-09T00:00:00Z',
  left: { sourceId: 'left', complete: true, rows: rows() },
  right: { sourceId: 'right', complete: true, rows: rows() },
  maxGroupRows: 2,
  config: {
    version: '1',
    keys: [{ name: 'id', internal: [(r) => r.id], partner: [(r) => r.id] }],
    comparisons: [
      { name: 'amount', kind: 'decimal', internal: (r) => r.amount, partner: (r) => r.amount },
    ],
  },
})) {
  if (event.type === 'entry') {
    assert.equal(event.entry.status, 'MATCHED');
    matched++;
    if (matched % 10000 === 0) sampleMemory();
  }
  if (event.type === 'complete') assert.equal(event.summary.matchedPairs, count);
}
assert.equal(matched, count);
sampleMemory();
console.log(
  JSON.stringify(
    {
      matchedPairs: matched,
      inputRows: count * 2,
      seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
      sampledMaxHeapMiB: Number((sampledMaxHeap / 1024 ** 2).toFixed(2)),
      sampledMaxRssMiB: Number((sampledMaxRss / 1024 ** 2).toFixed(2)),
      workload:
        'lazy sorted records, one amount comparison, unique IDs, output consumed without persistence',
      memorySamplingEveryPairs: 10000,
    },
    null,
    2,
  ),
);
