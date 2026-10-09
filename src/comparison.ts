import { compareDecimal } from './decimal.js';
import type { Issue, ReconciliationConfig, ReconciliationStatus } from './types.js';

export function comparePair<L, R>(left: L, right: R, config: ReconciliationConfig<L, R>): { statuses: ReconciliationStatus[]; issues: Issue[] } {
  const statuses: ReconciliationStatus[] = [];
  const issues: Issue[] = [];
  for (const rule of config.comparisons) {
    try {
      let a = rule.internal(left), b = rule.partner(right);
      if (rule.normalize) { a = rule.normalize(a, 'internal'); b = rule.normalize(b, 'partner'); }
      if (a === undefined || a === null || a === '' || b === undefined || b === null || b === '') {
        if (rule.missing === 'ignore') continue;
        statuses.push(rule.missing === 'review' ? 'MANUAL_REVIEW' : 'PENDING_RECHECK');
        issues.push({ code: 'MISSING_VALUE', message: 'Required comparison value is missing', field: rule.name, internalValue: a, partnerValue: b });
        continue;
      }
      let equal: boolean;
      let difference: string | undefined;
      if (rule.kind === 'decimal') {
        ({ equal, difference } = compareDecimal(a, b, rule.tolerance ?? '0'));
      } else {
        if (!['string', 'number', 'boolean', 'bigint'].includes(typeof a) || !['string', 'number', 'boolean', 'bigint'].includes(typeof b) ||
          (typeof a === 'number' && !Number.isFinite(a)) || (typeof b === 'number' && !Number.isFinite(b))) {
          throw new TypeError('Exact comparison requires finite primitive values; normalize structured values explicitly');
        }
        equal = a === b;
      }
      if (!equal) {
        statuses.push(rule.mismatchStatus ?? 'FIELD_MISMATCH');
        issues.push({ code: 'VALUE_MISMATCH', message: 'Values differ beyond configured tolerance', field: rule.name, internalValue: a, partnerValue: b, ...(difference === undefined ? {} : { difference }) });
      }
    } catch {
      statuses.push('MANUAL_REVIEW');
      issues.push({ code: 'INVALID_VALUE', field: rule.name, message: 'Selector, normalizer or value validation failed' });
    }
  }
  if (config.defer) {
    try {
      const reason = config.defer(left, right);
      if (reason !== undefined) {
        statuses.push('PENDING_RECHECK');
        issues.push({ code: 'BUSINESS_DEFERRED', message: reason });
      }
    } catch {
      statuses.push('MANUAL_REVIEW');
      issues.push({ code: 'BUSINESS_RULE_ERROR', message: 'Business deferral rule failed' });
    }
  }
  return { statuses: [...new Set(statuses.length ? statuses : ['MATCHED'] as const)], issues };
}
