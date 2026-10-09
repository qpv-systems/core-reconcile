import { parseDecimal } from './decimal.js';
import type { ReconciliationConfig, ReconciliationInput } from './types.js';

export class ReconciliationInputError extends Error {
  override name = 'ReconciliationInputError';
}
export function validateConfig<L, R>(config: ReconciliationConfig<L, R>): void {
  if (!config.version?.trim() || !config.keys?.length || !config.comparisons?.length) {
    throw new ReconciliationInputError(
      'Rule version, stable match keys and comparisons are required',
    );
  }
  for (const list of [config.keys, config.comparisons]) {
    const names = new Set<string>();
    for (const item of list) {
      if (!item.name?.trim() || names.has(item.name))
        throw new ReconciliationInputError('Rule names must be nonempty and unique');
      names.add(item.name);
    }
  }
  for (const key of config.keys) {
    if (
      !key.internal.length ||
      key.internal.length !== key.partner.length ||
      [...key.internal, ...key.partner].some((selector) => typeof selector !== 'function')
    ) {
      throw new ReconciliationInputError(`Invalid matching key: ${key.name}`);
    }
  }
  const mismatchStatuses = new Set([
    'AMOUNT_MISMATCH',
    'STATUS_MISMATCH',
    'FEE_MISMATCH',
    'TYPE_MISMATCH',
    'CURRENCY_MISMATCH',
    'FIELD_MISMATCH',
  ]);
  for (const rule of config.comparisons) {
    if (
      !['exact', 'decimal'].includes(rule.kind) ||
      typeof rule.internal !== 'function' ||
      typeof rule.partner !== 'function' ||
      (rule.missing !== undefined && !['pending', 'review', 'ignore'].includes(rule.missing)) ||
      (rule.mismatchStatus !== undefined && !mismatchStatuses.has(rule.mismatchStatus))
    ) {
      throw new ReconciliationInputError(`Invalid comparison: ${rule.name}`);
    }
    if (rule.tolerance !== undefined) {
      if (rule.kind !== 'decimal')
        throw new ReconciliationInputError('Tolerance is only supported for decimal comparisons');
      try {
        if (parseDecimal(rule.tolerance).coefficient < 0n) throw new Error();
      } catch {
        throw new ReconciliationInputError(`Invalid tolerance: ${rule.name}`);
      }
    }
  }
}
export function validateInput<L, R>(input: ReconciliationInput<L, R>): void {
  validateConfig(input.config);
  if (
    !input.batchId?.trim() ||
    !input.runId?.trim() ||
    !input.processedAt ||
    Number.isNaN(Date.parse(input.processedAt))
  ) {
    throw new ReconciliationInputError(
      'Batch ID, run ID and valid processing timestamp are required',
    );
  }
  for (const source of [input.internal, input.partner]) {
    if (
      !source.sourceId?.trim() ||
      typeof source.complete !== 'boolean' ||
      !Array.isArray(source.rows)
    ) {
      throw new ReconciliationInputError('Source ID, explicit completeness and rows are required');
    }
    const ids = new Set<string>();
    for (const row of source.rows) {
      if (typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) {
        throw new ReconciliationInputError(
          'Source row IDs must be nonempty and unique; duplicate imports must be rejected before reconciliation',
        );
      }
      if (row.line !== undefined && (!Number.isSafeInteger(row.line) || row.line < 1)) {
        throw new ReconciliationInputError('Source line must be a positive safe integer');
      }
      ids.add(row.id);
    }
  }
}
