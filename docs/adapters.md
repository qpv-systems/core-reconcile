# Excel and database inputs

The reconciliation core consumes `SourceRow<T>` records. Adapters normalize external input into that contract; they do not change matching rules or sort records automatically.

```ts
interface SourceRow<T> {
  id: string;     // Stable identity within one immutable source snapshot
  line?: number; // Physical file row or optional extraction reference
  data: T;       // Your typed domain record
}
```

## Database: prefer async iterables

`AsyncIterable<SourceRow<T>>` is the recommended integration boundary for large database inputs. The core does not depend on a SQL dialect, ORM, connection, or driver. Use a cursor/stream or keyset-paginated query, select only needed columns, and preserve an immutable snapshot/cutoff for retries.

| Option | Default | Contract |
|---|---|---|
| `getId(rawRow)` | Required | Synchronously returns a nonempty stable string ID. |
| `map(rawRow)` | Raw row unchanged | Returns your domain record or a promise of it. |
| `getLine(rawRow)` | Omitted | Returns a positive safe integer or `undefined`. |
| `close()` | None | Optional synchronous/async resource cleanup after an entered iteration. |
| `signal` | None | `AbortSignal` for adapter cancellation checks. |
| `maxBatchRows` | `1000` | Positive safe integer; applies only to `readDatabaseBatches`. |

### Cursor or row stream

The following example assumes `cursor` is an async iterable of database records and owns its driver-specific resources:

```ts
import { readDatabaseRows } from '@qpv-systems/core-reconcile';

const leftRows = readDatabaseRows(cursor, {
  getId: row => String(row.primaryKey),
  map: row => ({
    reference: row.reference,
    amount: row.amount, // Request DECIMAL/NUMERIC as a string in your driver.
    currency: row.currency,
  }),
  // Use this only for resources not already released by iterator.return().
  close: async () => { await cursor.close(); },
  signal: abortController.signal,
});
```

Mapping may be synchronous or asynchronous, but is awaited sequentially. There is no prefetch by the adapter. The driver may buffer records internally: configure its fetch/high-water-mark separately. Preserve large primary keys as strings before precision is lost; converting an already-rounded JS number cannot restore it.

`getId` is mandatory. Do not use array positions or a non-unique business matching key as source row IDs. `map` defaults to passing the raw row through. Optional `getLine(row)` supplies a positive safe-integer line/extraction reference.

The source iterator receives normal `return()` cleanup through `for await`. Optional `close()` is awaited once when the adapter is entered and then finishes, fails, is canceled, or the consumer stops. Do not provide a second non-idempotent close operation for a cursor whose iterator already closes itself. Connections created outside the generator remain caller-owned if iteration never begins. Close failures are propagated and may supersede an earlier processing error.

The adapter checks nonempty row IDs, not global uniqueness. Enforce snapshot-level uniqueness in your import/staging layer. Pass cancellation into the driver as well; the adapter cannot cancel a database request already awaiting a response by itself.

### Drivers returning batches/pages

Provide an iterable of bounded row arrays:

```ts
import { readDatabaseBatches } from '@qpv-systems/core-reconcile';

async function* pages() {
  // Illustrative driver API; adapt it to your database.
  while (true) {
    const batch = await cursor.read(500);
    if (batch.length === 0) return;
    yield batch;
  }
}

const rows = readDatabaseBatches(pages(), {
  getId: row => row.id,
  maxBatchRows: 500,
  close: () => cursor.close(),
});
```

Default `maxBatchRows` is `1000`. An oversized/non-array page fails rather than silently retaining it. The next page is requested only after the current page has been consumed. An array is already allocated by the caller before validation, so configure the database page size too. The adapter does not implement OFFSET/keyset pagination, open a transaction, or claim a worker job.

## Excel: streaming `.xlsx` adapter

Import the Node-only adapter from its separate subpath so browser/core imports do not load filesystem/SQLite modules:

```ts
import { readExcelRows } from '@qpv-systems/core-reconcile/excel';

const rightRows = readExcelRows('./partner.xlsx', {
  sourceId: 'partner-file-sha256',
  sheet: 'Transactions', // Name or 1-based workbook position; default 1
  headerRow: 1,
  requiredColumns: ['reference', 'amount', 'currency'],
  map: record => ({
    reference: record.reference,
    amount: record.amount,
    currency: record.currency,
  }),
});
```

| Option | Default | Contract |
|---|---|---|
| `sourceId` | Required | Nonempty immutable workbook snapshot identity. |
| `sheet` | `1` | Exact sheet name or positive 1-based workbook index. |
| `headerRow` | `1` | Positive physical worksheet row number containing headers. |
| `requiredColumns` | None | Required exact header names; additional columns are allowed. |
| `map(record, context)` | Parsed record unchanged | Domain record or promise; numeric cells are already strings. |
| `getId(record, context)` | JSON tuple of source, sheet, row | Nonempty stable string row identity. Runs before mapping. |
| `formulas` | `'reject'` | `'reject'` fails formula cells; `'cached'` accepts existing results without recalculation. |
| `tempDirectory` | OS temporary directory | Writable parent for owned temporary staging files. |
| `signal` | None | `AbortSignal` for cancellation. |

Context is `{ sheetName: string, sheetIndex: number, rowNumber: number }`; indexes and physical row numbers are 1-based. Parsed cell values are `string | boolean | null`. Resource budget options are listed below.

Input is a local `.xlsx` file path. Downloads/uploads must be saved to a file first. Legacy `.xls`, `.xlsb`, encrypted workbooks, formatting-based transformations, and automatic formula calculation are not supported.

The adapter targets standard SpreadsheetML workbooks. XML parts with DOCTYPE or CDATA declarations are rejected rather than silently ignoring their values. Raw XML tokens are bounded as well as decoded cell text; heavily entity-escaped cells may hit the token budget before the decoded-text limit.

### Excel value semantics

- Strings, inline text, and rich-text runs become strings. Phonetic annotations are excluded.
- Numeric cells become **decimal strings from their XML representation**, preserving precision without converting through JS `Number`. Numeric scientific notation is expanded to ordinary decimal text within the cell budget. Text cells containing scientific notation remain text and may be rejected by a decimal comparison.
- Boolean cells become booleans; missing/empty cells become `null`.
- Date-style numeric cells remain numeric serial strings. ISO date cells remain strings. Dates/timezones and workbook date-system interpretation require an explicit domain mapping; display formats are not applied.
- A number already rounded by Excel cannot be recovered. Store long identifiers/exact money as text when creating financial workbooks. Leading zeros provided only by display formatting are not reconstructed.
- Excel error cells fail the adapter. Formula cells fail by default. `formulas: 'cached'` opts into existing cached values; missing cached results still fail, and stale formula caches are not validated.

The configured header must exist and contain unique nonempty string names without gaps. `requiredColumns` checks exact names. Empty data rows are skipped while physical worksheet row numbers are retained. Unexpected cells beyond the header, duplicate addresses, invalid row ordering, or budget violations fail the adapter. Whitespace/case in headers is not silently changed.

Default row IDs encode `[sourceId, sheetName, physicalRowNumber]` as JSON. Optional `getId(record, context)` overrides identity. `map(record, context)` can be async and receives `{ sheetName, sheetIndex, rowNumber }`; it is called sequentially. Both callbacks must preserve traceability and exact financial values.

### Disk staging and budgets

Rows are yielded lazily after ZIP parts and the shared-string table have been staged. The adapter first streams the ZIP archive into a generated temporary directory; it then resolves shared strings from an on-disk SQLite table and parses only the selected worksheet in 16 KiB chunks. It does not buffer the entire workbook or shared-string table in a JS array. It may use disk proportional to expanded workbook size, so the first row is not necessarily immediate.

| Option | Default | Purpose |
|---|---:|---|
| `maxInputBytes` | 512 MiB | Limit compressed input file size. |
| `maxExpandedBytes` | 2 GiB | Limit total streamed uncompressed ZIP bytes, including ignored parts. |
| `maxMetadataBytes` | 1 MiB per metadata part | Bound workbook/sheet relationship metadata. |
| `maxSheets` | 128 | Limit worksheet parts and metadata sheet count. |
| `maxColumns` | 256 | Limit cell-column indexes. |
| `maxCellChars` | 65,536 | Bound cell/shared-string text and serialized XML tokens. |
| `maxRowChars` | 1,048,576 | Bound text within one worksheet row. |
| `tempDirectory` | OS temporary directory | Location for owned staging files and SQLite table. |
| `signal` | None | Check/interrupt reading on cancellation. |

All numeric budgets are positive safe integers. They bound resources but are not an unconditional guarantee against OOM or running out of disk. Parsing queues are bounded to one chunk's emitted rows; caller buffering and record mapping can still increase memory. SQLite is provided by Node (`node:sqlite`) and its stability/experimental warnings depend on the Node version. The default SQLite page cache is configured around 2 MiB; this is not a process RSS cap.

Owned temporary files are removed on successful completion, exceptions, cancellation, and early consumer return. Abrupt process termination cannot run cleanup; operators should manage stale temporary directories. No external sort is performed. Missing/invalid canonical business keys still follow the reconciliation API's failure policy.

Optional npm dependencies `unzipper` and `saxes` are required for `/excel`; normal installs include them. If installing with `--omit=optional`, explicitly install those packages before using the Excel adapter. `exceljs` is a development dependency used only to generate test workbooks, not a production adapter dependency.

## Combine database and Excel

```ts
import { reconcileSorted, readDatabaseRows } from '@qpv-systems/core-reconcile';
import { readExcelRows } from '@qpv-systems/core-reconcile/excel';

for await (const event of reconcileSorted({
  batchId, runId, processedAt, config,
  left: {
    sourceId: databaseSnapshotId, complete: true,
    rows: readDatabaseRows(cursor, {
      getId: row => row.id,
      close: () => cursor.close(),
    }),
  },
  right: {
    sourceId: fileChecksum, complete: true,
    rows: readExcelRows('./partner.xlsx', {
      sourceId: fileChecksum,
      requiredColumns: ['reference', 'amount'],
    }),
  },
})) {
  await sink.write(event);
}
```

Integration fragments assume your typed cursor, configuration, IDs, and sink exist. Both sources must be sorted by the same canonical matching key; a database's default collation may differ from JavaScript ordering. Reading one side from Excel does not remove this requirement. `complete: true` is a business assertion, not inferred from EOF. Persist provisional results per run and finalize only after `type: 'complete'`.

For small workbooks, collecting rows into arrays and using `reconcile()` is possible, but the memory cost is then your application's responsibility. Unsorted large workbooks need indexed staging/external sorting before reconciliation.
