import { reconcile } from './reconcile.js';
import { validateInput, ReconciliationInputError } from './validation.js';
import type { ReconciliationEntry, ReconciliationInput, ReconciliationResult, SourceRow, Selector, Aggregate, Issue } from './types.js';

export interface StreamingSource<T> {
  sourceId: string;
  complete: boolean;
  /** Must be globally sorted by the canonical matching key, not by source row ID. */
  rows: AsyncIterable<SourceRow<T>> | Iterable<SourceRow<T>>;
}

export interface StreamingInput<L, R> extends Omit<ReconciliationInput<L, R>, 'internal' | 'partner'> {
  left: StreamingSource<L>;
  right: StreamingSource<R>;
  /** Combined left/right rows for one key; throws before exceeding this bound. */
  maxGroupRows?: number;
  signal?: AbortSignal;
}

export type StreamingEvent<L, R> =
  | { type: 'entry'; entry: ReconciliationEntry<L, R> }
  | { type: 'aggregate'; aggregate: Aggregate }
  | { type: 'aggregateIssue'; issue: Issue }
  | { type: 'complete'; batchId: string; runId: string; summary: ReconciliationResult<L, R>['summary'] };

/** Use this same encoding in upstream sorting/staging. No locale collation. */
export function createSortKey<T>(key: { name: string; selectors: readonly Selector<T>[]; normalize?: (value: string) => string }): (record: T) => string {
  return record => {
    try {
      const values = key.selectors.map(selector => {
        const raw = selector(record);
        if (typeof raw !== 'string' || !raw.trim()) throw new Error();
        const value = key.normalize ? key.normalize(raw) : raw;
        if (typeof value !== 'string' || !value.trim()) throw new Error();
        return value;
      });
      if (!values.length) throw new Error();
      return JSON.stringify([key.name, values]);
    } catch {
      throw new ReconciliationInputError(`Streaming requires a valid canonical key: ${key.name}`);
    }
  };
}

async function* asAsync<T>(rows: AsyncIterable<T> | Iterable<T>): AsyncGenerator<T> {
  yield* rows;
}

/**
 * Sorted merge join: at most maxGroupRows + two lookahead records in the core.
 * One canonical key (possibly composite) is required; alternative-key graph
 * matching needs external indexed staging, not this merge strategy.
 */
export async function* reconcileSorted<L, R>(input: StreamingInput<L, R>): AsyncGenerator<StreamingEvent<L, R>> {
  const bound = input.maxGroupRows ?? 1000;
  if (!Number.isSafeInteger(bound) || bound < 1) throw new ReconciliationInputError('maxGroupRows must be a positive safe integer');
  if (input.config.keys.length !== 1) throw new ReconciliationInputError('Sorted streaming requires exactly one canonical matching key');
  const metadata = {
    batchId: input.batchId, runId: input.runId, processedAt: input.processedAt, config: input.config,
    internal: { sourceId: input.left.sourceId, complete: input.left.complete, rows: [] as SourceRow<L>[] },
    partner: { sourceId: input.right.sourceId, complete: input.right.complete, rows: [] as SourceRow<R>[] },
  };
  validateInput(metadata);
  const key = input.config.keys[0]!;
  // Each side uses its own selectors but exactly the same encoding.
  const leftKey = createSortKey({ name: key.name, selectors: key.internal, ...(key.normalize ? { normalize: key.normalize } : {}) });
  const rightKey = createSortKey({ name: key.name, selectors: key.partner, ...(key.normalize ? { normalize: key.normalize } : {}) });
  const left = asAsync(input.left.rows), right = asAsync(input.right.rows);
  const summary: ReconciliationResult<L, R>['summary'] = {
    internalRows: 0, partnerRows: 0, entries: 0, matchedPairs: 0,
    nonMatchedEntries: 0, pendingEntries: 0, manualReviewEntries: 0, byStatus: {},
  };
  function checkAbort(): void { input.signal?.throwIfAborted(); }
  let previousLeft: string | undefined, previousRight: string | undefined;
  async function next<T>(iterator: AsyncGenerator<SourceRow<T>>, encode: (record: T) => string, side: 'left' | 'right') {
    checkAbort();
    const item = await iterator.next();
    checkAbort();
    if (item.done) return undefined;
    const encoded = encode(item.value.data);
    const previous = side === 'left' ? previousLeft : previousRight;
    if (previous !== undefined && encoded < previous) throw new ReconciliationInputError(`${side} source is not sorted by canonical matching key`);
    if (side === 'left') previousLeft = encoded; else previousRight = encoded;
    return { row: item.value, key: encoded };
  }
  try {
    let a = await next(left, leftKey, 'left');
    let b = await next(right, rightKey, 'right');
    while (a || b) {
      checkAbort();
      const current = a && b ? (a.key < b.key ? a.key : b.key) : (a?.key ?? b!.key);
      const leftRows: SourceRow<L>[] = [], rightRows: SourceRow<R>[] = [];
      function guard(): void {
        if (leftRows.length + rightRows.length >= bound) {
          throw new ReconciliationInputError('Matching group exceeds maxGroupRows; use indexed external staging or increase the explicit budget');
        }
      }
      while (a?.key === current) {
        guard(); leftRows.push(a.row); a = await next(left, leftKey, 'left');
      }
      while (b?.key === current) {
        guard(); rightRows.push(b.row); b = await next(right, rightKey, 'right');
      }
      const result = reconcile({ ...metadata,
        internal: { ...metadata.internal, rows: leftRows }, partner: { ...metadata.partner, rows: rightRows },
      });
      summary.internalRows += result.summary.internalRows;
      summary.partnerRows += result.summary.partnerRows;
      summary.entries += result.summary.entries;
      summary.matchedPairs += result.summary.matchedPairs;
      summary.nonMatchedEntries += result.summary.nonMatchedEntries;
      summary.pendingEntries += result.summary.pendingEntries;
      summary.manualReviewEntries += result.summary.manualReviewEntries;
      for (const [status, count] of Object.entries(result.summary.byStatus)) {
        const typed = status as keyof typeof summary.byStatus;
        summary.byStatus[typed] = (summary.byStatus[typed] ?? 0) + count!;
      }
      for (const entry of result.entries) { checkAbort(); yield { type: 'entry', entry }; }
      // Emit aggregate partials; never build an unbounded dimension map in RAM.
      for (const aggregate of result.aggregates) { checkAbort(); yield { type: 'aggregate', aggregate }; }
      for (const issue of result.aggregateIssues) { checkAbort(); yield { type: 'aggregateIssue', issue }; }
    }
    checkAbort();
    yield { type: 'complete', batchId: input.batchId, runId: input.runId, summary };
  } finally {
    // Close both sources on success, cancellation, source failure or early return.
    await Promise.allSettled([left.return(undefined), right.return(undefined)]);
  }
}
