import type { Issue, Selector, SourceRow } from './types.js';

export interface IndexedRow<T> {
  row: SourceRow<T>;
  tokens: string[];
  issues: Issue[];
  candidates: Set<number>;
}
export function indexRows<T>(
  rows: readonly SourceRow<T>[],
  keys: readonly {
    name: string;
    selectors: readonly Selector<T>[];
    normalize?: (value: string) => string;
  }[],
): {
  rows: IndexedRow<T>[];
  index: Map<string, number[]>;
} {
  const index = new Map<string, number[]>();
  const indexed = rows.map((row, position) => {
    const tokens: string[] = [],
      issues: Issue[] = [];
    for (const key of keys) {
      try {
        const values = key.selectors.map((selector) => selector(row.data));
        if (values.some((value) => value === undefined || value === null || value === '')) continue;
        if (values.some((value) => typeof value !== 'string' || !value.trim()))
          throw new TypeError();
        const normalized = values.map((value) =>
          key.normalize ? key.normalize(value as string) : (value as string),
        );
        if (normalized.some((value) => typeof value !== 'string' || !value.trim()))
          throw new TypeError();
        const token = JSON.stringify([key.name, normalized]);
        tokens.push(token);
        const positions = index.get(token) ?? [];
        positions.push(position);
        index.set(token, positions);
      } catch {
        issues.push({
          code: 'INVALID_KEY',
          field: key.name,
          message: 'Stable identifiers must be nonempty strings; key extraction failed',
        });
      }
    }
    if (!tokens.length)
      issues.push({ code: 'MISSING_KEY', message: 'No usable stable transaction identifier' });
    return { row, tokens, issues, candidates: new Set<number>() };
  });
  for (const positions of index.values()) {
    if (positions.length > 1) {
      for (const position of positions)
        indexed[position]!.issues.push({
          code: 'DUPLICATE_KEY',
          message: 'Matching identifier is shared by multiple source rows',
        });
    }
  }
  return { rows: indexed, index };
}
