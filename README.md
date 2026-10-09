# Core Reconcile

**Compare two sources. Explain every outcome. Keep business decisions in your application.**

`@qpv-systems/core-reconcile` · **v0.1.0** · TypeScript · ESM · Node.js >= 22.18 · [MIT](LICENSE)

[Source](https://github.com/qpv-systems/core-reconcile) · [Issues](https://github.com/qpv-systems/core-reconcile/issues) · [Changelog](CHANGELOG.md) · [Input adapters](docs/adapters.md)

A configurable reconciliation core for comparing records from two sources. Use it for bank transactions, commissions, orders, inventory, or another domain with stable identifiers and explicit comparison rules.

The core returns structured results. Your application decides where to store them, how to display them, and which business actions to take. It does not connect to databases, update source records, move money, or automatically retry a run. A separate Node-only adapter reads `.xlsx`; database helpers adapt caller-owned cursors or batches.

**Current scope:** deterministic one-to-one matching, exact/decimal comparisons, traceable exceptions, optional aggregates, and sorted streaming. One-to-many matching, fuzzy matching, currency conversion, and refund accounting are not implemented.

## Contents

- [Getting started](#getting-started)
- [Public API](#public-api)
- [Use cases and boundaries](#use-cases-and-boundaries)
- [Commission example](#commission-example)
- [Terminology and workflow](#terminology-and-workflow)
- [Reconciliation statuses](#reconciliation-statuses)
- [Pending recheck versus manual review](#pending-recheck-versus-manual-review)
- [Rules and options](#rules-and-options)
- [Output reference](#output-reference)
- [Issue codes](#issue-codes)
- [Streaming large sources](#streaming-large-sources)
- [Excel and database adapters](#excel-and-database-adapters)
- [Persistence, failures, and retries](#persistence-failures-and-retries)
- [Development and verification](#development-and-verification)
- [Release notes](#release-notes)

## Getting started

Requires Node.js **22.18 or newer**. The repository uses TypeScript 5.9 to build. Core imports have no runtime library dependencies; the optional `/excel` entry uses `unzipper`, `saxes`, and Node SQLite. The build is ESM; no CommonJS export is provided.

Version `0.1.0` is prepared as an npm package; this repository does not imply that it has been published to the registry. Build and install a local tarball today:

```sh
git clone https://github.com/qpv-systems/core-reconcile.git
cd core-reconcile
# If this change has not been merged yet:
git checkout feat/package-release
npm ci
npm run build
npm pack
# In your consuming application, install the resulting tarball:
npm install /path/to/qpv-systems-core-reconcile-0.1.0.tgz
```

After a registry release, installation will be `npm install @qpv-systems/core-reconcile`. The TypeScript examples below assume the package is installed. JavaScript callers use the same functions without type annotations.

```ts
import {
  reconcile,
  type ReconciliationConfig,
  type ReconciliationInput,
} from '@qpv-systems/core-reconcile';

interface RecordData {
  reference: string;
  amount?: string;
  status: string;
}

const config: ReconciliationConfig<RecordData, RecordData> = {
  version: 'rules-v1',
  keys: [{
    name: 'reference',
    internal: [record => record.reference],
    partner: [record => record.reference],
  }],
  comparisons: [
    {
      name: 'amount', kind: 'decimal',
      internal: record => record.amount,
      partner: record => record.amount,
      tolerance: '0.01', missing: 'pending',
      mismatchStatus: 'AMOUNT_MISMATCH',
    },
    {
      name: 'sourceStatus', kind: 'exact',
      internal: record => record.status,
      partner: record => record.status,
      mismatchStatus: 'STATUS_MISMATCH',
    },
  ],
};

const input: ReconciliationInput<RecordData, RecordData> = {
  batchId: 'batch-001', runId: 'attempt-001',
  processedAt: '2026-10-09T03:00:00Z', config,
  internal: {
    sourceId: 'left-snapshot-001', complete: true,
    rows: [{ id: 'left-row-1', data: {
      reference: 'REF-001', amount: '100.00', status: 'APPROVED',
    } }],
  },
  partner: {
    sourceId: 'right-snapshot-001', complete: true,
    rows: [{ id: 'right-row-1', line: 2, data: {
      reference: 'REF-001', amount: '100.00', status: 'APPROVED',
    } }],
  },
};

const result = reconcile(input);
console.log(result.entries[0]?.status); // MATCHED
console.log(result.summary.matchedPairs); // 1
console.log(result.matchedRows); // Original source rows for matched pairs
```

Select any fields appropriate to your domain: `amount`, `commissionAmount`, `quantity`, `fee`, or `approvalStatus` are application concepts, not mandatory input column names. Selectors can differ between sources.

## Public API

The package exposes functions and a reusable factory. It does not require an HTTP server or a framework.

| Export | Call | Return value |
|---|---|---|
| `reconcile` | `reconcile(input)` | Synchronous `ReconciliationResult<L, R>` for bounded arrays. |
| `createReconciler` | `createReconciler(config)` | Object exposing `reconcile(inputWithoutConfig)` with reusable rules. |
| `reconcileSorted` | `reconcileSorted(streamingInput)` | Async generator of `StreamingEvent<L, R>`. |
| `createSortKey` | `createSortKey({ name, selectors, normalize? })` | Function mapping a domain record to its encoded canonical key. |
| `reconcilePartitions` | `reconcilePartitions(partitions)` | Async generator of `{ partitionId, result }`. |
| `readDatabaseRows` | `readDatabaseRows(rows, options)` | Async generator of `SourceRow<T>`. |
| `readDatabaseBatches` | `readDatabaseBatches(batches, options)` | Async generator of `SourceRow<T>`, flattening bounded pages. |
| `ReconciliationInputError` | `error instanceof ReconciliationInputError` | Error class for core validation failures. |
| `readExcelRows` from `/excel` | `readExcelRows(filePath, options)` | Async generator of `SourceRow<T>`; Node only. |
| `ExcelInputError` from `/excel` | `error instanceof ExcelInputError` | Error class for workbook validation failures. |

Root type exports: `ReconciliationStatus`, `SourceRow`, `Source`, `Selector`, `MatchKey`, `Comparison`, `AggregateFields`, `ReconciliationConfig`, `ReconciliationInput`, `Issue`, `ReconciliationEntry`, `Aggregate`, `ReconciliationResult`, `StreamingSource`, `StreamingInput`, `StreamingEvent`, `DatabaseRowsOptions`, and `DatabaseBatchOptions`. The `/excel` subpath exports `ExcelValue`, `ExcelRecord`, `ExcelRowContext`, and `ExcelRowsOptions`.

### Reuse a rule configuration

This example continues the getting-started example:

```ts
import { createReconciler } from '@qpv-systems/core-reconcile';

const engine = createReconciler(config);
const { config: originalConfig, ...runInput } = input;
const nextResult = engine.reconcile({ ...runInput, runId: 'attempt-002' });
console.log(nextResult.summary);
```

### Process safe partitions

```ts
import { reconcilePartitions } from '@qpv-systems/core-reconcile';

// A single partition is safe for this bounded example.
const partitions = [{ partitionId: 'scope-001', input }];
for await (const { partitionId, result } of reconcilePartitions(partitions)) {
  console.log(partitionId, result.summary.matchedPairs);
}
```

For production, supply an async generator of bounded, correctly grouped partitions and persist/checkpoint each result atomically. Partition by a scope that keeps every possible matching relationship together, such as tenant plus account. Splitting each side into arbitrary 1,000-row chunks is unsafe.

## Use cases and boundaries

The following are configurable applications of the engine, not built-in accounting policies. You supply stable event identity, field mappings, signs, units, tolerances, and source completeness. Different schemas on the two sides are supported through independent selectors.

| Domain | Typical stable key | Values to compare | Business rules supplied by the caller |
|---|---|---|---|
| Bank statements versus ledger | Bank reference / journal event ID | Amount, fee, currency, posting status | Posting dates, booking cutoffs, debit/credit signs. |
| Payment gateway versus merchant records | Gateway transaction ID / partner reference | Gross/net amount, fee, status, type, currency | Status equivalence, gross/net basis, fee basis. |
| Commissions and affiliate payouts | Commission event ID or order + beneficiary + event ID | Commission amount, adjustment, rate, approval state | Entitlement, commission formula, clawback rules. |
| Refunds and partial refunds | Refund ID, or payment + refund event ID | Refund amount, currency, status, fee | Sign convention and event identity; cumulative limits remain external. |
| Reversals and chargebacks | Reversal/dispute event ID | Amount, adjustment, status, event type | Liability, original-event linkage, deadlines. |
| Settlements and disbursements | Settlement/payout event ID | Payout amount, fee, currency, confirmation | Settlement closure; batch netting and allocations remain external. |
| Invoices, receivables, and payables | Invoice ID + line/event ID | Billed/paid amount, tax, currency, status | Partial allocation and balances remain external. |
| Orders and fulfillment | Order + line + fulfillment event ID | Quantity, price, state, SKU | Units, partial shipments, equivalent lifecycle states. |
| Inventory and stock movements | Warehouse + SKU + movement ID | Quantity, movement type, state | Unit conversion and physical stock calculations. |
| Payroll and reimbursements | Employee + period + earning/expense event ID | Gross/net pay, deductions, reimbursement | Tax calculation and payroll policy remain external. |
| Insurance premiums and claims | Policy/claim + installment/payment event ID | Premium, claim payment, status | Coverage and adjudication rules remain external. |
| Subscriptions and utility billing | Account + billing period + charge event ID | Charge, usage, tax, state | Proration, tiering, and meter calculations. |
| Data migration and system synchronization | Stable entity ID + version/event ID | Any supported primitive or decimal fields | Version selection, deletion semantics, conflict policy. |

Operational use cases:

- Database versus database, database versus file, or file versus file; either side may use any adapter.
- Already-loaded small datasets using `reconcile()` without sorting.
- Large sorted cursors/files using `reconcileSorted()` and an awaited output sink.
- Large unsorted datasets after caller-provided external sorting/indexed staging, or correct partitioning with `reconcilePartitions()`.
- Exact or tolerance-based amount, fee, commission, quantity, and rate comparison; tolerances are absolute, not percentage-based.
- Composite identifiers, alternate identifiers in the in-memory API, and duplicate/conflict investigation.
- Missing counterparts in confirmed-complete inputs; inconclusive absence in incomplete inputs.
- Required-field pending/review policies; explicitly ignored optional fields.
- Domain status normalization, field-name mapping, and explicit deferral of unconfirmed pairs.
- Successful-row extraction, discrepancy queues, per-status counts, source-line tracing, and signed grouped totals.
- Safe reruns over immutable snapshots with stable result identity and caller-managed history.
- Caller-generated JSON, NDJSON, CSV, Excel, PDF, database, or UI reports from returned results/events.

Current boundaries: matching is one-to-one. Many-to-one allocation, one-to-many settlement matching, fuzzy/amount/time-only matching, FX conversion, automatic refund/netting calculations, custom async comparisons, arbitrary comparator callbacks, external sorting, checkpoint storage, distributed locks, database writes, scheduled retries, and format exporters are not included. Map/aggregate externally under explicit rules before feeding records to the engine when your business requires these features. A match does not authorize a financial action.

## Commission example

This standalone example uses different column names on each side. The rate and payout policy have already been computed by the consuming system. Status mapping is explicit and local to this example.

```ts
import { reconcile, type ReconciliationConfig } from '@qpv-systems/core-reconcile';

type Commission = { eventId: string; commission: string; currency: string; state: string };
type Payout = { reference: string; payable: string; currencyCode: string; state: string };
const commissionRules: ReconciliationConfig<Commission, Payout> = {
  version: 'commission-policy-1',
  keys: [{
    name: 'commission-event',
    internal: [row => row.eventId],
    partner: [row => row.reference],
  }],
  comparisons: [
    {
      name: 'commission', kind: 'decimal', tolerance: '0.01',
      internal: row => row.commission, partner: row => row.payable,
      mismatchStatus: 'AMOUNT_MISMATCH',
    },
    {
      name: 'currency', kind: 'exact',
      internal: row => row.currency, partner: row => row.currencyCode,
      mismatchStatus: 'CURRENCY_MISMATCH',
    },
    {
      name: 'approval', kind: 'exact',
      internal: row => row.state, partner: row => row.state,
      normalize: (value, side) =>
        side === 'partner' && value === 'CONFIRMED' ? 'APPROVED' : value,
      mismatchStatus: 'STATUS_MISMATCH',
    },
  ],
  aggregates: {
    internal: { amount: row => row.commission, currency: row => row.currency },
    partner: { amount: row => row.payable, currency: row => row.currencyCode },
  },
};

const commissions = reconcile({
  batchId: 'commissions-2026-09', runId: 'commission-attempt-1',
  processedAt: '2026-10-09T03:00:00Z', config: commissionRules,
  internal: {
    sourceId: 'commission-snapshot-1', complete: true,
    rows: [{ id: 'commission-db-row-1', data: {
      eventId: 'COM-001', commission: '25.00', currency: 'USD', state: 'APPROVED',
    } }],
  },
  partner: {
    sourceId: 'payout-file-checksum-1', complete: true,
    rows: [{ id: 'payout-row-2', line: 2, data: {
      reference: 'COM-001', payable: '25.01', currencyCode: 'USD', state: 'CONFIRMED',
    } }],
  },
});

console.log(commissions.entries[0]?.status); // MATCHED: difference equals tolerance.
console.log(commissions.aggregates); // Independent source totals: 25 and 25.01.
```

Tolerance can allow a matched pair while source totals differ. The engine does not infer a batch failure from aggregate differences. Compare grouped totals under a separate, explicit business policy. For refunds or reversals, select stable event IDs (or a composite payment/event key) and compare the signed amounts supplied by your business mapping; no sign conversion occurs automatically.

## Terminology and workflow

| Term | Meaning |
|---|---|
| Record | One source item wrapped in `{ id, line?, data }`. |
| Source row ID (`id`) | Unique row identity within a snapshot; separate from the matching key. |
| Matching key | Stable business identifier or composite identifier used to find counterparts. |
| Batch (`batchId`) | The business scope being reconciled. |
| Run (`runId`) | One processing attempt; use a new ID for each retry or recheck. |
| Source (`sourceId`) | Immutable input snapshot, such as a database extraction or file checksum. Change its identity when contents change. |
| Entry | A reconciliation outcome containing a pair, or one row without a safely established counterpart. |
| Issue | A specific reason a record differs or cannot be processed safely. |

The in-memory API names the sides `internal` and `partner`. Streaming input names them `left` and `right`; streaming output still uses `internal` and `partner`. **Either side can come from a database or file.** These names do not determine which source is authoritative.

```text
Read sources → locate records by stable identifiers → reject ambiguous matching
             → compare uniquely paired rows → return entries and statistics
```

The package does not compare line 1 to line 1. A row on line 2 can match a row on line 50 through its identifier. Duplicate keys are examined before choosing a counterpart; the engine never selects the first duplicate arbitrarily.

## Reconciliation statuses

`entry.status` is the **reconciliation outcome**, not the original transaction status. Values such as `SUCCESS`, `APPROVED`, or `REFUNDED` remain unchanged inside source `data`.

| Status | Trigger | Suggested application response |
|---|---|---|
| `MATCHED` | A unique pair passes configured comparisons, has no identifier conflict, and is not deferred. Ignored optional fields need not be present. | Record success. Eligibility for payment/update is a separate decision. |
| `MISSING_INTERNAL` | A partner/right row has no counterpart and internal/left is confirmed complete. | Investigate the missing left record. |
| `MISSING_PARTNER` | An internal/left row has no counterpart and partner/right is confirmed complete. | Investigate the missing right record. |
| `AMOUNT_MISMATCH` | A comparison explicitly configured with this `mismatchStatus` fails. | Inspect amount/unit/tolerance rules. |
| `STATUS_MISMATCH` | A comparison explicitly configured with this `mismatchStatus` fails. | Inspect source statuses and their mapping. |
| `FEE_MISMATCH` | A comparison explicitly configured with this `mismatchStatus` fails. | Inspect fee or adjustment rules. |
| `TYPE_MISMATCH` | A comparison explicitly configured with this `mismatchStatus` fails. | Inspect record/event categories. |
| `CURRENCY_MISMATCH` | A comparison explicitly configured with this `mismatchStatus` fails. | Check currency; no conversion occurs. |
| `FIELD_MISMATCH` | A comparison fails with no other configured mismatch label, or explicitly uses this status. | Inspect the named field. |
| `PENDING_RECHECK` | Required comparison data is missing under pending policy, the opposite source is incomplete, or a business rule defers the pair. | Obtain data/confirmation and initiate a new run. |
| `MANUAL_REVIEW` | Matching is unsafe, values are invalid, identifiers conflict, missing data has review policy, or a business callback fails. | Resolve the data/ambiguity/rule problem before accepting results. |

Mismatch statuses are **configuration labels**. Naming a field `amount` does not automatically assign `AMOUNT_MISMATCH`; set `mismatchStatus` explicitly.

### Multiple statuses and precedence

`entry.statuses` preserves all distinct outcomes. `entry.status` chooses the first applicable value in this order:

```text
MANUAL_REVIEW → PENDING_RECHECK → CURRENCY_MISMATCH → TYPE_MISMATCH
→ AMOUNT_MISMATCH → FEE_MISMATCH → STATUS_MISMATCH → FIELD_MISMATCH
→ MISSING_INTERNAL → MISSING_PARTNER → MATCHED
```

For example, an amount mismatch plus a missing fee can produce this excerpt:

```json
{
  "status": "PENDING_RECHECK",
  "statuses": ["AMOUNT_MISMATCH", "PENDING_RECHECK"]
}
```

Inspect `statuses` and `issues`, not just the primary status. The `statuses` array is not guaranteed to be sorted by precedence.

## Pending recheck versus manual review

**`PENDING_RECHECK`: required information or business confirmation is missing, so the decision cannot be finalized.** It does not promise a future match. The package does not schedule a retry.

| Situation | Rule and issue |
|---|---|
| Same ID on both sides; amount is missing on either or both sides | Default `missing: 'pending'` → `MISSING_VALUE`. |
| Left row has no counterpart, but right has `complete: false` | Right may still receive data → `INCOMPLETE_SOURCE`, not `MISSING_PARTNER`. |
| `defer(left, right)` returns a reason | Application-defined condition is not satisfied → `BUSINESS_DEFERRED`. |

**`MANUAL_REVIEW`: a safe decision cannot be established with the current identifiers, values, or rules.** Human review is a suggested workflow; an application may repair data automatically under an explicit policy and start a new run.

| Situation | Rule and issue |
|---|---|
| Two left rows share the same matching identifier | `DUPLICATE_KEY`; no arbitrary row selection. |
| Alternative identifiers lead to different counterparts | `AMBIGUOUS_MATCH`. |
| One identifier matches, another available identifier disagrees | `IDENTIFIER_CONFLICT`. |
| Paired amount is `"invalid"` or numeric `100` instead of decimal string `"100"` | `INVALID_VALUE` during comparison. |
| A selector/normalizer throws | `INVALID_VALUE`. |
| The business deferral callback throws | `BUSINESS_RULE_ERROR`. |
| A comparison field is missing with `missing: 'review'` | `MISSING_VALUE` under the explicit review policy. |

Missing/invalid matching keys produce review entries in `reconcile()`. In **sorted streaming**, an unusable canonical key fails the run instead: the engine cannot safely locate that row in sorted order.

### Missing-value options

| `missing` | Behavior |
|---|---|
| `'pending'` | Default; add `PENDING_RECHECK` and a missing-value issue. |
| `'review'` | Add `MANUAL_REVIEW` and a missing-value issue. |
| `'ignore'` | Skip the comparison when either value is missing. |

Missing means `undefined`, `null`, or `''` **after normalization**. Zero and `false` are not missing. Whitespace is not automatically missing in comparisons; normalize it explicitly if required.

`ignore` can make a pair `MATCHED` with that field absent. Use it only for optional fields.

### Source completeness is an application assertion

`source.complete` means the application has confirmed that no further records are expected for this snapshot/business scope. Reaching the end of a file or cursor alone does not prove this. The core trusts this flag and does not verify a partner's batch completion.

| Record present only on | Opposite source flag | Outcome |
|---|---|---|
| Internal / left | Right `complete: true` | `MISSING_PARTNER` |
| Internal / left | Right `complete: false` | `PENDING_RECHECK` |
| Partner / right | Left `complete: true` | `MISSING_INTERNAL` |
| Partner / right | Left `complete: false` | `PENDING_RECHECK` |

Existing unique pairs are compared even when a source is incomplete. Use `defer` if your application also needs to wait before accepting paired records.

### Reading a pending or review result

These are output excerpts; full entries also include source rows and a result key:

```json
{
  "status": "PENDING_RECHECK",
  "statuses": ["PENDING_RECHECK"],
  "matchedBy": ["reference"],
  "issues": [{
    "code": "MISSING_VALUE",
    "message": "Required comparison value is missing",
    "field": "amount",
    "internalValue": "100.00",
    "partnerValue": null
  }]
}
```

The key matched, but the partner amount is `null`. Supply/confirm the missing amount and rerun; matching by identifier alone is not enough to mark this pair as matched.

```json
{
  "status": "MANUAL_REVIEW",
  "statuses": ["MANUAL_REVIEW"],
  "matchedBy": ["reference"],
  "issues": [{
    "code": "INVALID_VALUE",
    "message": "Selector, normalizer or value validation failed",
    "field": "amount"
  }]
}
```

This can occur when the paired amount is `"invalid"`. Investigate/correct the data or callback; simply waiting for source completeness does not fix an invalid decimal value.

### Explicit business deferral

Example callback for records containing an application-defined `settlementClosed` field:

```ts
defer: (left, right) =>
  left.settlementClosed && right.settlementClosed
    ? undefined
    : 'Settlement confirmation is not available yet'
```

This is not a built-in settlement rule. `undefined` adds no deferral; any returned string, including an empty string, adds pending. A thrown callback adds review. The callback runs for uniquely paired rows, not unmatched/ambiguous rows.

## Rules and options

### Input metadata and source rows

| Input field | Requirement | Meaning |
|---|---|---|
| `batchId` | Nonempty string | Business reconciliation scope; stable across attempts. |
| `runId` | Nonempty string | Attempt identity; assign a new value for each retry/recheck. |
| `processedAt` | Parseable date string | Caller-supplied processing time; use an explicit ISO timestamp with timezone. |
| `config` | Required | Rule configuration below. |
| `internal`, `partner` | Required in `reconcile()` | Left and right `Source<T>`; each has `sourceId`, `complete`, `rows`. |
| `left`, `right` | Required in `reconcileSorted()` | Left and right streaming sources; rows may be iterable or async iterable. |
| `sourceId` | Nonempty string | Immutable snapshot identity, not merely a database/table name. |
| `complete` | Explicit boolean | Whether the application confirms no more records are expected for this scope. |
| `rows` | Required | Arrays for in-memory; iterable/async iterable for streaming. |
| Row `id` | Nonempty string, unique per source snapshot | Traceable source identity distinct from a business key. |
| Row `line` | Optional positive safe integer | Physical file row or caller-defined extraction position. |
| Row `data` | Domain record | Original payload passed to selectors and returned with entries. |

No fixed input schema or financial column names are required. Validate your domain payload in your adapter. The engine does not infer missing amounts, currencies, dates, or IDs.

### Configuration

| Option | Requirement | Behavior |
|---|---|---|
| `version` | Required | Immutable rule version included in result identity. |
| `keys` | At least one | Unique named match-key definitions with equal-length selectors for both sides. |
| `comparisons` | At least one | Unique named field comparisons. |
| `aggregates` | Optional | Independent aggregate selectors for each side. |
| `defer` | Optional | Synchronous callback returning a pending reason or `undefined`. |

Rule callbacks must be synchronous and pure: no I/O, record mutation, randomness, current-time dependence, or promises. Adapter `map` callbacks may be asynchronous as documented in the adapter guide. Input/output records are not deep-cloned; treat them as immutable.

### Matching keys

Components must be nonempty strings. Convert numeric IDs accurately in the adapter; preserve leading zeros and precision. No default trimming/case folding is applied. Optional key `normalize(value)` must return a nonempty string.

Multiple keys in `reconcile()` are alternative identifiers. A missing component makes that key unavailable; another valid key may still match. A malformed key creates an issue and prevents automatic matching even if another key is usable. Composite components use JSON tuple encoding to avoid delimiter collisions.

Your application must choose stable identifiers. The core cannot determine a selector's business meaning: do not configure amount/time alone as a transaction identifier.

### Comparison options

| Option | Default | Behavior |
|---|---|---|
| `name` | Required | Field name reported in issues. |
| `internal`, `partner` | Required | Select comparison values from each source. |
| `kind` | Required | `'exact'` or `'decimal'`. |
| `mismatchStatus` | `'FIELD_MISMATCH'` | Label emitted when values differ. |
| `tolerance` | `'0'` | Nonnegative absolute decimal tolerance; only valid for decimal comparisons. |
| `normalize(value, side)` | None | Maps values before missing checks/comparison; side is `'internal'` or `'partner'`. |
| `missing` | `'pending'` | Policy explained above. |

`exact` uses strict equality for primitive strings, finite numbers, booleans, or bigints. Types matter: `"1"` differs from `1`. Objects/dates require normalization to supported primitives.

`decimal` accepts strings such as `"100.00"`, `"-25.5"`, and `"+1"`. It rejects JS numbers, thousands separators, scientific notation, whitespace, and values over 1000 characters. Arithmetic uses bigint coefficients and decimal scales. `difference` is **internal/left minus partner/right**. A difference exactly equal to tolerance is accepted. No automatic rounding/currency conversion occurs.

Configure currency and record-type comparisons alongside amounts when required. Gross/net amounts, fee basis, refund signs, and equivalent statuses are not inferred.

Refunds, partial refunds, reversals, and settlements can be compared as explicitly identified events. If events share a payment ID, use a stable composite key containing event identity/sequence. Event linkage, fee allocation, netting, and cumulative-refund validation remain application responsibilities.

## Output reference

### In-memory result: `reconcile(input)`

| Field | Meaning |
|---|---|
| `batchId`, `runId`, `ruleVersion`, `processedAt` | Caller-provided audit context. |
| `sources`, `completeness` | Snapshot IDs and completeness assertions. |
| `entries` | All reconciliation outcomes for the inputs. |
| `matchedRows.internal`, `matchedRows.partner` | Original rows from matched pairs. |
| `errorRows` | All non-matched entries, including pending/review. |
| `summary` | Counts described below. |
| `aggregates`, `aggregateIssues` | Optional totals and aggregation problems. |

### Entry

| Field | Meaning |
|---|---|
| `resultKey` | JSON tuple of batch ID, both source IDs, rule version, and participating row IDs. Stable across retries; not a content hash. |
| `status`, `statuses` | Primary and all distinct outcomes. |
| `internal`, `partner` | Original source rows with `id`, optional `line`, and `data`. Either side may be absent. |
| `matchedBy` | Key names for an established pair; empty when no safe pair exists. |
| `issues` | Reasons, field values, and differences when available. |

`line` is supplied by the adapter, not calculated by the core. Original callback exceptions are replaced by safe issue messages. Original data remains unchanged.

### Summary

| Field | Counts |
|---|---|
| `internalRows`, `partnerRows` | Source row counts; represent left/right in streaming too. |
| `entries` | Result entries: a pair counts once, ambiguous rows may be emitted separately. |
| `matchedPairs` | Entries with primary status `MATCHED`. |
| `nonMatchedEntries` | `entries - matchedPairs`, including pending/review. |
| `pendingEntries` | Entries whose `statuses` includes pending. |
| `manualReviewEntries` | Entries whose `statuses` includes review. |
| `byStatus` | Counts every status on each entry; absent statuses have no property. |

Pending/review counts may overlap and are not additional rows to add to non-matched counts. The sum of `byStatus` can exceed `entries` when a pair has multiple discrepancies.

### Aggregates

Configure `amount` and `currency`, plus optional `transactionType`/`businessDate` selectors for both sides. Output includes `side`, dimensions, `rowCount`, `validAmountCount`, `invalidAmountCount`, and signed exact `totalAmount`.

Totals include all source rows, including duplicates/review rows; no deduplication/netting occurs. Invalid amounts are excluded from the sum and reported. Invalid grouping dimensions exclude rows from grouping and produce issues. Unconfigured optional dimensions are `null`. Totals do not automatically create batch mismatch statuses. Normalize dates/timezones in your adapter.

Raw records may contain sensitive information or bigints. Decide access/redaction and JSON serialization in your application. CSV/XLSX/PDF exporters are not part of the core.

### Inspect matched rows and discrepancy details

```ts
// Reuses `result` from the getting-started example.
const successfulLeftRowIds = result.matchedRows.internal.map(row => row.id);
const successfulRightLineNumbers = result.matchedRows.partner
  .flatMap(row => row.line === undefined ? [] : [row.line]);
const failures = result.errorRows.map(entry => ({
  resultKey: entry.resultKey,
  status: entry.status,
  statuses: entry.statuses,
  leftRowId: entry.internal?.id,
  rightRowId: entry.partner?.id,
  leftLine: entry.internal?.line,
  rightLine: entry.partner?.line,
  reasons: entry.issues,
}));
console.log({ successfulLeftRowIds, successfulRightLineNumbers, failures });
```

These identities let an application build an insert/update plan under its own policy. The engine returns rows; it never executes that plan. Preserve both IDs when updating corresponding systems. A database row need not have `line`, so use its stable `id` for tracing.

For an amount comparison of left `"100.00"` and right `"110.00"`, the issue includes the compared values and an exact signed difference. For example, this is an entry excerpt:

```json
{
  "status": "AMOUNT_MISMATCH",
  "statuses": ["AMOUNT_MISMATCH"],
  "matchedBy": ["reference"],
  "issues": [{
    "code": "VALUE_MISMATCH",
    "field": "amount",
    "internalValue": "100.00",
    "partnerValue": "110.00",
    "difference": "-10"
  }]
}
```

The full issue also contains `message`. Values may be omitted when extraction failed; JSON serialization omits `undefined` properties. Zero matches and absent status keys are valid: read `summary.byStatus.AMOUNT_MISMATCH ?? 0`.

## Issue codes

Issues contain `code`, `message`, and optional `field`, `internalValue`, `partnerValue`, and `difference`.

| Code | Meaning |
|---|---|
| `MISSING_VALUE` | A paired comparison value is missing under pending/review policy. |
| `VALUE_MISMATCH` | Values differ beyond the configured tolerance. |
| `INVALID_VALUE` | Comparison selector, normalizer, or value validation failed. |
| `INVALID_KEY` | A key selector/normalizer failed or returned an invalid identifier. |
| `MISSING_KEY` | No configured matching key is usable. |
| `DUPLICATE_KEY` | Multiple rows within a source share a matching identifier. |
| `AMBIGUOUS_MATCH` | No unique valid counterpart can be established. Also accompanies unsafe/missing keys; it does not always mean multiple candidates exist. |
| `IDENTIFIER_CONFLICT` | One identifier matched but another available identifier disagreed. |
| `MISSING_COUNTERPART` | No counterpart by configured identifiers in a confirmed-complete opposite source. |
| `INCOMPLETE_SOURCE` | The opposite source is incomplete, so absence is inconclusive. |
| `BUSINESS_DEFERRED` | The business callback returned a pending reason. |
| `BUSINESS_RULE_ERROR` | The business callback threw. |
| `INVALID_AGGREGATE_AMOUNT` | An amount could not be added to a total. |
| `INVALID_AGGREGATE_GROUP` | Aggregate dimension extraction/validation failed. |

Aggregate issues are separate: an aggregate-selector problem does not automatically change an entry's status.

## Streaming large sources

`reconcileSorted()` is an async generator accepting `Iterable`/`AsyncIterable` rows from file parsers, database cursors, or other adapters. Both inputs must be sorted by **exactly one canonical key**, possibly composite. The package does not sort inputs.

```ts
import { reconcileSorted } from '@qpv-systems/core-reconcile';

// Reuses the sorted one-row input from the getting-started example.
for await (const event of reconcileSorted({
  batchId: input.batchId, runId: input.runId,
  processedAt: input.processedAt, config: input.config,
  left: input.internal, right: input.partner,
  maxGroupRows: 1000,
})) {
  if (event.type === 'entry') console.log(event.entry);
  if (event.type === 'complete') console.log(event.summary);
}
```

For production, await writes to external sinks instead of collecting arrays or logging every row. Awaiting each write provides backpressure.

### Event types: `type` is not a status

| `event.type` | Payload | Meaning |
|---|---|---|
| `'entry'` | `entry` | One reconciliation outcome; inspect `entry.status` and `entry.issues`. |
| `'aggregate'` | `aggregate` | Partial aggregate for a processed key group; combine repeated dimensions externally. |
| `'aggregateIssue'` | `issue` | An aggregation problem. |
| `'complete'` | `batchId`, `runId`, `summary` | Both input iterators were consumed successfully and processing completed. |

**`type: 'complete'` does not mean all records matched.** A completed run may contain pending, review, and mismatches. It does not assert business completeness of sources: `source.complete` is a separate caller assertion.

If reading/validation/cancellation fails, the generator throws without successful completion. Earlier entries belong to an incomplete attempt.

### Sorting and memory contract

Produce canonical keys with `createSortKey({ name, selectors, normalize? })`, then sort by JavaScript string `<` ordering, not locale collation. Ordinary database `ORDER BY id` may differ; use compatible ordering for stored canonical keys or external sorting.

For a bounded dataset, the following demonstrates the exact ordering contract. Use external sorting for large inputs instead of these array copies:

```ts
import { createSortKey } from '@qpv-systems/core-reconcile';

const key = config.keys[0]!;
const leftKey = createSortKey({ name: key.name, selectors: key.internal });
const rightKey = createSortKey({ name: key.name, selectors: key.partner });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sortedLeft = [...input.internal.rows]
  .sort((a, b) => compare(leftKey(a.data), leftKey(b.data)));
const sortedRight = [...input.partner.rows]
  .sort((a, b) => compare(rightKey(a.data), rightKey(b.data)));
```

When a key has `normalize`, pass the same function to both sort-key builders. The encoded key includes its name and a JSON array of components; numeric-looking identifiers use encoded string order, not numeric order.

- `maxGroupRows` defaults to `1000`, a positive safe integer limiting combined rows for one key. A pair uses two slots.
- Memory holds one bounded group, its index/results, and up to two lookahead rows. Row sizes and adapter/sink buffers still matter; this is not a byte-budget or unconditional OOM guarantee.
- Complete groups are read before matching, so duplicate keys cannot accidentally match as a first pair.
- Unsorted input, unusable canonical keys, and oversized groups fail rather than silently producing unsafe matches.
- Global source row ID uniqueness must be enforced in staging/import. Streaming detects duplicate row IDs only within its current group.
- Optional `signal: AbortSignal` enables cancellation checks. Iterators receive cleanup via `return()`. Pass the signal into I/O adapters too: the core cannot interrupt a hung `next()` itself.
- Keep configuration immutable while streaming.

Unsorted large files need indexed staging or external merge sorting before reconciliation. Those sorting/storage engines are not included. Alternative-key matching requires appropriate external indexing/partitioning, rather than this single-key merge strategy.

### Other execution APIs

`createReconciler(config)` snapshots configuration arrays and returns `{ reconcile(inputWithoutConfig) }`. Each call validates its input; the factory is not a result store and does not deep-copy callback closures.

`reconcilePartitions(partitions)` yields `{ partitionId, result }`. All rows connected by **any** key must share a partition, including duplicates/conflicts. Arbitrary fixed-size chunks are unsafe. Repeated/empty partition IDs are rejected within an invocation. Memory depends on the largest partition and the set of partition IDs; cross-partition duplicate keys/row IDs are not detected.

`reconcile()` keeps input arrays, indexes, results, and aggregates in memory. Reserve it for bounded input.

## Excel and database adapters

See the [adapter guide](docs/adapters.md) for options, value semantics, examples, disk budgets, and lifecycle details.

| Input | API | Integration boundary |
|---|---|---|
| Loaded records | `reconcile()` | Bounded arrays of `SourceRow<T>`. |
| Database cursor/row stream | `readDatabaseRows()` | Caller-owned `AsyncIterable<Raw>` or iterable; ID selection, optional mapping/cleanup/cancellation. |
| Database batches | `readDatabaseBatches()` | Iterable/async iterable of bounded arrays; default maximum 1,000 rows per batch. |
| Excel `.xlsx` | `readExcelRows()` from `/excel` | Local path; sheet/header selection, mapping, disk-backed shared strings, exact numeric strings. |
| CSV / NDJSON / other formats | Caller-provided adapter | Yield `{ id, line?, data }`; use a streaming parser and explicit schema validation. |

For large database integration, prefer `AsyncIterable<SourceRow<T>>`, not a driver-specific object or a whole query-result array. Helpers do not open connections, issue queries, or sort records. Configure cursor/page buffers, immutable snapshots, and canonical ordering in the application.

Excel parsing stages workbook parts/shared strings to disk before yielding rows. It preserves numeric XML as strings, does not apply display/date formats, and rejects formulas unless cached values are explicitly enabled. `.xls`/`.xlsb` are unsupported.

### Database cursor input

This integration fragment assumes your database driver exposes an async iterable cursor whose fields are typed. Preserve DECIMAL/NUMERIC and large IDs as strings at the driver boundary:

```ts
import { readDatabaseRows } from '@qpv-systems/core-reconcile';

const databaseRows = readDatabaseRows(cursor, {
  getId: row => row.id,
  map: row => ({
    reference: row.reference,
    amount: row.amount, // Exact decimal string from the driver.
    status: row.status,
  }),
  // Only needed when iterator cleanup does not already close the cursor.
  close: () => cursor.close(),
});
```

### Excel input

```ts
import { readExcelRows } from '@qpv-systems/core-reconcile/excel';

const workbookRows = readExcelRows('./statement.xlsx', {
  sourceId: 'statement-content-checksum',
  sheet: 'Transactions',
  headerRow: 1,
  requiredColumns: ['reference', 'amount', 'status'],
  map: row => ({ reference: row.reference, amount: row.amount, status: row.status }),
});
```

Pass these iterators as `left.rows` or `right.rows` in `reconcileSorted()`, with a matching config and confirmed completeness flags. Both must already satisfy canonical ordering. Do not collect large iterators into arrays. For small workbooks that fit your memory budget, collect rows and call `reconcile()` instead. See the [adapter guide](docs/adapters.md) for all options, errors, cleanup, and resource limits.

## Persistence, failures, and retries

**The package does not store results.** In-memory callers receive an object; streaming callers receive events and choose where to persist them.

| Failure | Behavior |
|---|---|
| Invalid configuration/metadata/source row IDs | Validation rejects input, generally with `ReconciliationInputError`. Arbitrary malformed JavaScript objects outside exported contracts may also cause native errors. |
| Paired comparison/key problems in in-memory processing | Structured entries/issues according to the rules above. |
| Streaming source error, unsorted input, invalid canonical key, cancellation, group overflow | Run throws; earlier events are provisional. |
| Aggregation errors | Separate aggregate issues. |

Stable identities support retries but do not provide exactly-once writes. Your integration should:

1. Preserve immutable source snapshots, checksums, row IDs, and extraction cutoffs.
2. Store runs/rule versions separately; retain recheck history instead of overwriting it.
3. Protect imports/results/checkpoints with transactions and unique constraints. For history, `(run_id, result_key)` can prevent duplicate writes within an attempt.
4. Claim work using database locks or leases with fencing tokens. The core has no worker lock.
5. Store provisional entries and promote a run only after successful completion. Mark failures and checkpoint only atomically committed work.
6. Retry unchanged snapshots/rules with a new run ID. Changed content requires a new source ID; changed logic requires a new rule version.

Your application schedules rechecks and decides whether financial actions are permitted. A matched pair is not authorization to transfer money; a mismatch must not automatically trigger a refund.

Output is not saved to a hidden directory or retained by a service. For `reconcile()`, it lives in the returned object. For `reconcileSorted()`, each event is yielded to your consumer. You can await a database insert or report writer per event. Capture batch/run/rule/source metadata in your sink because individual entry events do not carry every audit field. Aggregate events are partials and must be combined exactly, not with floating-point addition. Streaming does not expose a separate `matchedRows` array; filter `entry.status === 'MATCHED'` as events arrive.

Checkpointed partition processing can resume from application-managed committed partition IDs. Sorted streaming has no built-in resume cursor: rerun a failed attempt from immutable snapshots, or implement a proven group-boundary checkpoint strategy externally. Finalize reports only after a `complete` event and successful sink commits. Processing completion and durable persistence are separate responsibilities.

## Development and verification

```sh
npm ci
npm run check
npm test
npm run test:memory
npm run test:excel-memory
npm pack --dry-run
```

Tests cover matches, multiple discrepancies, duplicate identities/keys, alternative identifier conflicts, explicit refund events, tolerance boundaries, incomplete inputs, rerun identity, partition rules, streaming failures/cancellation, cursor backpressure/cleanup, and workbook validation/precision. They do not establish database transaction or worker-lock correctness; those belong to your integration.

For a million-pair core smoke test:

```sh
npm run build
node --max-old-space-size=32 test/streaming-memory.mjs 1000000
```

The workload creates sorted records lazily and consumes output without accumulation or persistence. The flag limits old-generation space, not total heap or RSS. Results depend on row width, key-group size, adapters, sink buffers, and available disk. It is not a throughput or memory guarantee for every workload. The Excel memory test generates an isolated workbook under ignored `.test-output/` and reads it in a separate process.

## Release notes

`0.1.0` is the initial package version. Releases follow [Semantic Versioning](https://semver.org/); during `0.x`, minor updates may change the API, while patch updates contain compatible fixes. Pin the version and review the [changelog](CHANGELOG.md) before upgrading production integrations. Package version and `config.version` are separate: one versions the library, the other versions your business rules.

Before adopting a domain configuration, confirm identifier uniqueness, status mappings, amount units/signs, tolerances, source completeness, timezones, snapshot consistency, and persistence contracts with the business owner.

Licensed under the [MIT License](LICENSE). Maintained under the **QPV Systems / Core Reconcile** brand.
