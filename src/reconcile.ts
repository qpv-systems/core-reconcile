import { validateConfig, validateInput } from './validation.js';
import { indexRows } from './matching.js';
import { comparePair } from './comparison.js';
import { aggregateRows } from './aggregates.js';
import type { Issue, ReconciliationConfig, ReconciliationEntry, ReconciliationInput, ReconciliationResult, ReconciliationStatus, SourceRow } from './types.js';

const priority: readonly ReconciliationStatus[] = ['MANUAL_REVIEW', 'PENDING_RECHECK', 'CURRENCY_MISMATCH', 'TYPE_MISMATCH', 'AMOUNT_MISMATCH', 'FEE_MISMATCH', 'STATUS_MISMATCH', 'FIELD_MISMATCH', 'MISSING_INTERNAL', 'MISSING_PARTNER', 'MATCHED'];

/** Synchronous, deterministic and side-effect-free. Callbacks must also be pure. */
export function reconcile<L, R>(input: ReconciliationInput<L, R>): ReconciliationResult<L, R> {
  validateInput(input);
  const left = indexRows(input.internal.rows, input.config.keys.map(key => ({ name: key.name, selectors: key.internal, ...(key.normalize ? { normalize: key.normalize } : {}) })));
  const right = indexRows(input.partner.rows, input.config.keys.map(key => ({ name: key.name, selectors: key.partner, ...(key.normalize ? { normalize: key.normalize } : {}) })));
  for (let i = 0; i < left.rows.length; i++) {
    for (const token of left.rows[i]!.tokens) {
      // Two candidates suffice to prove ambiguity, avoiding a duplicate-key cross product.
      for (const j of (right.index.get(token) ?? []).slice(0, 2)) {
        left.rows[i]!.candidates.add(j);
        if (right.rows[j]!.candidates.size < 2) right.rows[j]!.candidates.add(i);
      }
    }
  }
  const entries: ReconciliationEntry<L, R>[] = [];
  const consumed = new Set<number>();
  function emit(internal: SourceRow<L> | undefined, partner: SourceRow<R> | undefined, statuses: ReconciliationStatus[], issues: Issue[], matchedBy: string[] = []): void {
    const status = priority.find(value => statuses.includes(value))!;
    entries.push({
      resultKey: JSON.stringify([input.batchId, input.internal.sourceId, input.partner.sourceId, input.config.version, internal?.id ?? null, partner?.id ?? null]),
      status, statuses, issues, matchedBy,
      ...(internal ? { internal } : {}), ...(partner ? { partner } : {}),
    });
  }
  for (const row of left.rows) {
    const candidateIndex = [...row.candidates][0];
    const candidate = candidateIndex === undefined ? undefined : right.rows[candidateIndex];
    if (row.issues.length || row.candidates.size > 1 || (candidate && (candidate.issues.length || candidate.candidates.size !== 1))) {
      emit(row.row, undefined, ['MANUAL_REVIEW'], [...row.issues, { code: 'AMBIGUOUS_MATCH', message: 'Cannot establish a unique valid counterpart; inspect identifiers on both sources' }]);
      continue;
    }
    if (!candidate) {
      const complete = input.partner.complete;
      emit(row.row, undefined, [complete ? 'MISSING_PARTNER' : 'PENDING_RECHECK'], [{ code: complete ? 'MISSING_COUNTERPART' : 'INCOMPLETE_SOURCE', message: complete ? 'No partner counterpart by configured identifiers' : 'Partner batch has not been confirmed complete' }]);
      continue;
    }
    consumed.add(candidateIndex!);
    const comparison = comparePair(row.row.data, candidate.row.data, input.config);
    for (const key of input.config.keys) {
      const a = row.tokens.find(token => JSON.parse(token)[0] === key.name);
      const b = candidate.tokens.find(token => JSON.parse(token)[0] === key.name);
      if (a && b && a !== b) {
        comparison.statuses = comparison.statuses.filter(status => status !== 'MATCHED');
        if (!comparison.statuses.includes('MANUAL_REVIEW')) comparison.statuses.push('MANUAL_REVIEW');
        comparison.issues.push({ code: 'IDENTIFIER_CONFLICT', field: key.name, message: 'One stable identifier matched but another available identifier disagrees' });
      }
    }
    const matchedBy = input.config.keys.filter(key => row.tokens.some(token => candidate.tokens.includes(token) && JSON.parse(token)[0] === key.name)).map(key => key.name);
    emit(row.row, candidate.row, comparison.statuses, comparison.issues, matchedBy);
  }
  for (let j = 0; j < right.rows.length; j++) {
    if (consumed.has(j)) continue;
    const row = right.rows[j]!;
    if (row.issues.length || row.candidates.size) {
      emit(undefined, row.row, ['MANUAL_REVIEW'], [...row.issues, { code: 'AMBIGUOUS_MATCH', message: 'Cannot establish a unique valid counterpart; inspect identifiers on both sources' }]);
    } else {
      const complete = input.internal.complete;
      emit(undefined, row.row, [complete ? 'MISSING_INTERNAL' : 'PENDING_RECHECK'], [{ code: complete ? 'MISSING_COUNTERPART' : 'INCOMPLETE_SOURCE', message: complete ? 'No internal counterpart by configured identifiers' : 'Internal batch has not been confirmed complete' }]);
    }
  }
  const byStatus: Partial<Record<ReconciliationStatus, number>> = {};
  for (const entry of entries) for (const status of entry.statuses) byStatus[status] = (byStatus[status] ?? 0) + 1;
  const matched = entries.filter(entry => entry.status === 'MATCHED');
  const internalAggregates = input.config.aggregates ? aggregateRows(input.internal.rows, input.config.aggregates.internal, 'internal') : { aggregates: [], issues: [] };
  const partnerAggregates = input.config.aggregates ? aggregateRows(input.partner.rows, input.config.aggregates.partner, 'partner') : { aggregates: [], issues: [] };
  return {
    batchId: input.batchId, runId: input.runId, ruleVersion: input.config.version, processedAt: input.processedAt,
    sources: { internal: input.internal.sourceId, partner: input.partner.sourceId },
    completeness: { internal: input.internal.complete, partner: input.partner.complete },
    summary: { internalRows: left.rows.length, partnerRows: right.rows.length, entries: entries.length, matchedPairs: matched.length,
      nonMatchedEntries: entries.length - matched.length, pendingEntries: byStatus.PENDING_RECHECK ?? 0, manualReviewEntries: byStatus.MANUAL_REVIEW ?? 0, byStatus },
    entries,
    matchedRows: { internal: matched.map(entry => entry.internal!), partner: matched.map(entry => entry.partner!) },
    errorRows: entries.filter(entry => entry.status !== 'MATCHED'),
    aggregates: [...internalAggregates.aggregates, ...partnerAggregates.aggregates],
    aggregateIssues: [...internalAggregates.issues, ...partnerAggregates.issues],
  };
}

/**
 * Bounded-memory adapter for caller-partitioned data. All rows connected by ANY
 * matching key must occur in the same partition. Arbitrary file chunks are unsafe.
 * Caller commits each result atomically and checkpoints its partition ID.
 */
export async function* reconcilePartitions<L, R>(
  partitions: AsyncIterable<{ partitionId: string; input: ReconciliationInput<L, R> }> | Iterable<{ partitionId: string; input: ReconciliationInput<L, R> }>,
): AsyncGenerator<{ partitionId: string; result: ReconciliationResult<L, R> }> {
  const seen = new Set<string>();
  for await (const partition of partitions) {
    if (!partition.partitionId.trim() || seen.has(partition.partitionId)) {
      throw new Error('Partition IDs must be nonempty and unique within an invocation');
    }
    seen.add(partition.partitionId);
    yield { partitionId: partition.partitionId, result: reconcile(partition.input) };
  }
}

export function createReconciler<L, R>(config: ReconciliationConfig<L, R>): {
  reconcile: (input: Omit<ReconciliationInput<L, R>, 'config'>) => ReconciliationResult<L, R>;
} {
  validateConfig(config);
  // Snapshot rule arrays so later caller edits do not change the factory's rules.
  const snapshot: ReconciliationConfig<L, R> = { ...config,
    keys: config.keys.map(key => ({ ...key, internal: [...key.internal], partner: [...key.partner] })),
    comparisons: config.comparisons.map(rule => ({ ...rule })),
    ...(config.aggregates ? { aggregates: { internal: { ...config.aggregates.internal }, partner: { ...config.aggregates.partner } } } : {}),
  };
  return { reconcile: input => reconcile({ ...input, config: snapshot }) };
}
