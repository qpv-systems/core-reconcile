import { addDecimal, formatDecimal, parseDecimal } from './decimal.js';
import type { Aggregate, AggregateFields, Issue, SourceRow } from './types.js';

export function aggregateRows<T>(
  rows: readonly SourceRow<T>[],
  fields: AggregateFields<T>,
  side: 'internal' | 'partner',
): { aggregates: Aggregate[]; issues: Issue[] } {
  const groups = new Map<string, { report: Aggregate; total: ReturnType<typeof parseDecimal> }>();
  const issues: Issue[] = [];
  for (const row of rows) {
    try {
      const currency = fields.currency(row.data);
      const transactionType = fields.transactionType ? fields.transactionType(row.data) : null;
      const businessDate = fields.businessDate ? fields.businessDate(row.data) : null;
      if (
        typeof currency !== 'string' ||
        !currency.trim() ||
        (fields.transactionType &&
          (typeof transactionType !== 'string' || !transactionType.trim())) ||
        (fields.businessDate && (typeof businessDate !== 'string' || !businessDate.trim()))
      )
        throw new TypeError();
      const key = JSON.stringify([currency, transactionType, businessDate]);
      let group = groups.get(key);
      if (!group) {
        group = {
          report: {
            side,
            currency,
            transactionType: transactionType as string | null,
            businessDate: businessDate as string | null,
            rowCount: 0,
            validAmountCount: 0,
            invalidAmountCount: 0,
            totalAmount: '0',
          },
          total: parseDecimal('0'),
        };
        groups.set(key, group);
      }
      group.report.rowCount++;
      try {
        group.total = addDecimal(group.total, parseDecimal(fields.amount(row.data)));
        group.report.validAmountCount++;
      } catch {
        group.report.invalidAmountCount++;
        issues.push({
          code: 'INVALID_AGGREGATE_AMOUNT',
          message: `${side} row ${row.id}: invalid aggregate amount`,
        });
      }
    } catch {
      issues.push({
        code: 'INVALID_AGGREGATE_GROUP',
        message: `${side} row ${row.id}: invalid aggregate dimensions`,
      });
    }
  }
  return {
    aggregates: [...groups.values()].map((group) => ({
      ...group.report,
      totalAmount: formatDecimal(group.total),
    })),
    issues,
  };
}
