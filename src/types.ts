export type ReconciliationStatus =
  | 'MATCHED' | 'MISSING_INTERNAL' | 'MISSING_PARTNER'
  | 'AMOUNT_MISMATCH' | 'STATUS_MISMATCH' | 'FEE_MISMATCH'
  | 'TYPE_MISMATCH' | 'CURRENCY_MISMATCH' | 'FIELD_MISMATCH'
  | 'PENDING_RECHECK' | 'MANUAL_REVIEW';

export interface SourceRow<T> {
  /** Stable source identifier; mandatory for traceability. */
  id: string;
  /** Physical file row or database extraction position, supplied by caller. */
  line?: number;
  data: T;
}

export interface Source<T> {
  sourceId: string;
  complete: boolean;
  rows: readonly SourceRow<T>[];
}

export type Selector<T> = (record: T) => unknown;
export interface MatchKey<L, R> {
  name: string;
  /** Composite components are encoded without delimiter collisions. */
  internal: readonly Selector<L>[];
  partner: readonly Selector<R>[];
  normalize?: (value: string) => string;
}

export interface Comparison<L, R> {
  name: string;
  internal: Selector<L>;
  partner: Selector<R>;
  kind: 'exact' | 'decimal';
  mismatchStatus?: Extract<ReconciliationStatus,
    'AMOUNT_MISMATCH' | 'STATUS_MISMATCH' | 'FEE_MISMATCH' |
    'TYPE_MISMATCH' | 'CURRENCY_MISMATCH' | 'FIELD_MISMATCH'>;
  /** Decimal strings only: no floating-point arithmetic. Default zero. */
  tolerance?: string;
  normalize?: (value: unknown, side: 'internal' | 'partner') => unknown;
  /** Missing values default to PENDING_RECHECK, including missing on both sides. */
  missing?: 'pending' | 'review' | 'ignore';
}

export interface AggregateFields<T> {
  amount: Selector<T>;
  currency: Selector<T>;
  transactionType?: Selector<T>;
  businessDate?: Selector<T>;
}

export interface ReconciliationConfig<L, R> {
  /** Immutable business-rule version, included in result identity. */
  version: string;
  /** Alternative identifiers; conflicts across keys require manual review. */
  keys: readonly MatchKey<L, R>[];
  comparisons: readonly Comparison<L, R>[];
  aggregates?: { internal: AggregateFields<L>; partner: AggregateFields<R> };
  /** Explicit business rules only; returned reason defers the pair. */
  defer?: (internal: L, partner: R) => string | undefined;
}

export interface ReconciliationInput<L, R> {
  batchId: string;
  /** New ID for each attempt; never reuse as a result database primary key. */
  runId: string;
  /** Caller supplied, so identical inputs can produce identical outputs. */
  processedAt: string;
  internal: Source<L>;
  partner: Source<R>;
  config: ReconciliationConfig<L, R>;
}

export interface Issue {
  code: string;
  message: string;
  field?: string;
  internalValue?: unknown;
  partnerValue?: unknown;
  difference?: string;
}

export interface ReconciliationEntry<L, R> {
  /** Stable across retries for the same batch, sources, rule version and row IDs. */
  resultKey: string;
  status: ReconciliationStatus;
  /** Includes all discrepancies, rather than only the primary status. */
  statuses: readonly ReconciliationStatus[];
  internal?: SourceRow<L>;
  partner?: SourceRow<R>;
  matchedBy: readonly string[];
  issues: readonly Issue[];
}

export interface Aggregate {
  side: 'internal' | 'partner';
  currency: string;
  transactionType: string | null;
  businessDate: string | null;
  rowCount: number;
  validAmountCount: number;
  invalidAmountCount: number;
  /** Signed source amounts, no inferred netting/refund conversion. */
  totalAmount: string;
}

export interface ReconciliationResult<L, R> {
  batchId: string;
  runId: string;
  ruleVersion: string;
  processedAt: string;
  sources: { internal: string; partner: string };
  completeness: { internal: boolean; partner: boolean };
  summary: {
    internalRows: number;
    partnerRows: number;
    entries: number;
    matchedPairs: number;
    nonMatchedEntries: number;
    pendingEntries: number;
    manualReviewEntries: number;
    /** Counts every status on an entry; sums may exceed entry count. */
    byStatus: Partial<Record<ReconciliationStatus, number>>;
  };
  entries: readonly ReconciliationEntry<L, R>[];
  matchedRows: { internal: readonly SourceRow<L>[]; partner: readonly SourceRow<R>[] };
  /** All non-MATCHED entries, including pending and manual review. */
  errorRows: readonly ReconciliationEntry<L, R>[];
  aggregates: readonly Aggregate[];
  aggregateIssues: readonly Issue[];
}
