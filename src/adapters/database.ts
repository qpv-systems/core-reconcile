import type { SourceRow } from '../types.js';
import { ReconciliationInputError } from '../validation.js';

export interface DatabaseRowsOptions<Raw, RecordData = Raw> {
  /** A stable database row identity, not an array offset or matching key. */
  getId: (row: Raw) => string;
  map?: (row: Raw) => RecordData | Promise<RecordData>;
  getLine?: (row: Raw) => number | undefined;
  /** Optional cleanup for resources not released by iterator.return(). */
  close?: () => void | Promise<void>;
  signal?: AbortSignal;
}

/** Driver-agnostic cursor adapter; reads only when the consumer requests a row. */
export async function* readDatabaseRows<Raw, RecordData = Raw>(
  rows: AsyncIterable<Raw> | Iterable<Raw>,
  options: DatabaseRowsOptions<Raw, RecordData>,
): AsyncGenerator<SourceRow<RecordData>> {
  try {
    options.signal?.throwIfAborted();
    for await (const row of rows) {
      options.signal?.throwIfAborted();
      const id = options.getId(row);
      const line = options.getLine?.(row);
      if (typeof id !== 'string' || !id.trim())
        throw new ReconciliationInputError('Database row ID must be a nonempty string');
      if (line !== undefined && (!Number.isSafeInteger(line) || line < 1))
        throw new ReconciliationInputError('Database row line must be a positive safe integer');
      const data = options.map ? await options.map(row) : (row as unknown as RecordData);
      options.signal?.throwIfAborted();
      yield { id, data, ...(line === undefined ? {} : { line }) };
    }
  } finally {
    await options.close?.();
  }
}

export interface DatabaseBatchOptions<Raw, RecordData = Raw> extends DatabaseRowsOptions<
  Raw,
  RecordData
> {
  /** Reject oversized pages rather than silently retaining larger batches. */
  maxBatchRows?: number;
}

/** Supports fetch/read/page APIs through a caller-owned async batch generator. */
export async function* readDatabaseBatches<Raw, RecordData = Raw>(
  batches: AsyncIterable<readonly Raw[]> | Iterable<readonly Raw[]>,
  options: DatabaseBatchOptions<Raw, RecordData>,
): AsyncGenerator<SourceRow<RecordData>> {
  const limit = options.maxBatchRows ?? 1000;
  async function* flatten(): AsyncGenerator<Raw> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ReconciliationInputError('maxBatchRows must be a positive safe integer');
    options.signal?.throwIfAborted();
    for await (const batch of batches) {
      options.signal?.throwIfAborted();
      if (!Array.isArray(batch) || batch.length > limit)
        throw new ReconciliationInputError(
          'Database batch exceeds maxBatchRows or is not an array',
        );
      for (const row of batch) yield row;
    }
  }
  yield* readDatabaseRows(flatten(), options);
}
