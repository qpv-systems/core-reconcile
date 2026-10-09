import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename, posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Parse } from 'unzipper';
import { SaxesParser } from 'saxes';
import type { SourceRow } from '../types.js';

export type ExcelValue = string | boolean | null;
export type ExcelRecord = Record<string, ExcelValue>;
export interface ExcelRowContext { sheetName: string; sheetIndex: number; rowNumber: number }
export interface ExcelRowsOptions<T = ExcelRecord> {
  sourceId: string;
  /** Sheet name or 1-based workbook position. Defaults to the first sheet. */
  sheet?: string | number;
  headerRow?: number;
  requiredColumns?: readonly string[];
  map?: (record: ExcelRecord, context: ExcelRowContext) => T | Promise<T>;
  getId?: (record: ExcelRecord, context: ExcelRowContext) => string;
  /** Formulas are never calculated. Cached values require explicit opt-in. */
  formulas?: 'reject' | 'cached';
  tempDirectory?: string;
  maxInputBytes?: number;
  maxExpandedBytes?: number;
  maxMetadataBytes?: number;
  maxSheets?: number;
  maxColumns?: number;
  maxCellChars?: number;
  maxRowChars?: number;
  signal?: AbortSignal;
}

export class ExcelInputError extends Error { override name = 'ExcelInputError'; }
const localName = (name: string): string => name.split(':').at(-1)!;
function numericText(raw: string, limit: number): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match || (!match[2] && !match[3])) throw new ExcelInputError('Invalid numeric Excel cell');
  const whole = match[2] || '0', fraction = match[3] ?? '';
  if (match[4] === undefined) return (match[1] ?? '') + whole + (fraction ? `.${fraction}` : '');
  const exponent = Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > limit) throw new ExcelInputError('Numeric exponent exceeds cell budget');
  const digits = whole + fraction, position = whole.length + exponent;
  if (digits.length + Math.max(0, -position, position - digits.length) + 3 > limit) throw new ExcelInputError('Expanded numeric cell exceeds maxCellChars');
  const value = position <= 0 ? `0.${'0'.repeat(-position)}${digits}` : position >= digits.length ? digits + '0'.repeat(position - digits.length) : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return (match[1] ?? '') + value;
}
function tokenBudget(maxChars: number): (chunk: string) => void {
  let length = 0, previous = '';
  return chunk => {
    const prefix = previous + chunk;
    if (prefix.includes('<![CDATA[') || prefix.includes('<!DOCTYPE')) throw new ExcelInputError('CDATA and DOCTYPE are not supported in XLSX parts');
    previous = prefix.slice(-8);
    for (const character of chunk) {
      if (character === '<') length = 0;
      else if (++length > maxChars) throw new ExcelInputError('XML token exceeds text budget');
    }
  };
}

/** Streaming UTF-8 XML parser; results are queued only for one 16 KiB chunk. */
async function parseXml(file: string, setup: (parser: SaxesParser) => void, signal?: AbortSignal, maxTextChars = 65536): Promise<void> {
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new ExcelInputError('DOCTYPE is not supported in XLSX parts'); });
  setup(parser);
  const decoder = new StringDecoder('utf8');
  const input = createReadStream(file, { highWaterMark: 16384 });
  const guard = tokenBudget(maxTextChars);
  try {
    for await (const chunk of input) {
      signal?.throwIfAborted(); const text = decoder.write(chunk); guard(text); parser.write(text);
    }
    parser.write(decoder.end()).close(); signal?.throwIfAborted();
  } finally { input.destroy(); }
}

/**
 * Node-only .xlsx adapter. ZIP parts and shared strings are staged on disk;
 * numeric cell XML is preserved as strings, never converted through Number.
 */
export async function* readExcelRows<T = ExcelRecord>(filePath: string, options: ExcelRowsOptions<T>): AsyncGenerator<SourceRow<T>> {
  const limits = {
    maxInputBytes: options.maxInputBytes ?? 512 * 1024 ** 2,
    maxExpandedBytes: options.maxExpandedBytes ?? 2 * 1024 ** 3,
    maxMetadataBytes: options.maxMetadataBytes ?? 1024 ** 2,
    maxSheets: options.maxSheets ?? 128, maxColumns: options.maxColumns ?? 256,
    maxCellChars: options.maxCellChars ?? 65536, maxRowChars: options.maxRowChars ?? 1024 ** 2,
  };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new ExcelInputError(`${name} must be a positive safe integer`);
  const headerRow = options.headerRow ?? 1;
  if (!options.sourceId?.trim() || !Number.isSafeInteger(headerRow) || headerRow < 1 ||
    (typeof options.sheet === 'number' && (!Number.isSafeInteger(options.sheet) || options.sheet < 1)) ||
    (typeof options.sheet === 'string' && !options.sheet.trim()) ||
    (options.formulas !== undefined && !['reject', 'cached'].includes(options.formulas))) throw new ExcelInputError('Invalid Excel source, sheet, header, or formula options');
  if (!filePath.toLowerCase().endsWith('.xlsx')) throw new ExcelInputError('Only .xlsx files are supported; convert legacy .xls first');
  options.signal?.throwIfAborted();
  const info = await stat(filePath);
  if (info.size > limits.maxInputBytes) throw new ExcelInputError('XLSX file exceeds maxInputBytes');
  const parent = resolve(options.tempDirectory ?? tmpdir());
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'reconciliation-excel-'));
  let database: DatabaseSync | undefined;
  try {
    const parts = new Map<string, string>();
    let expanded = 0, sheetParts = 0;
    const input = createReadStream(filePath, { highWaterMark: 16384 });
    const zip = input.pipe(Parse({ forceStream: true }));
    input.on('error', error => zip.destroy(error));
    const abort = (): void => { input.destroy(); zip.destroy(new ExcelInputError('Excel reading aborted')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const entry of zip) {
        options.signal?.throwIfAborted();
        const path = entry.path as string;
        const keep = path === 'xl/workbook.xml' || path === 'xl/_rels/workbook.xml.rels' || path === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(path);
        if (keep && parts.has(path)) throw new ExcelInputError(`Duplicate XLSX part: ${path}`);
        if (/^xl\/worksheets\/[^/]+\.xml$/.test(path) && ++sheetParts > limits.maxSheets) throw new ExcelInputError('Workbook exceeds maxSheets');
        const target = keep ? join(directory, `part-${parts.size}.xml`) : undefined;
        if (target) parts.set(path, target);
        const output = target ? createWriteStream(target, { flags: 'wx' }) : undefined;
        // Register completion early to observe errors during writes/backpressure.
        const finished = output ? once(output, 'finish') : undefined;
        finished?.catch(() => {});
        let partBytes = 0;
        try {
          for await (const chunk of entry) {
            options.signal?.throwIfAborted();
            expanded += chunk.length; partBytes += chunk.length;
            if (expanded > limits.maxExpandedBytes) throw new ExcelInputError('Workbook exceeds maxExpandedBytes');
            if ((path === 'xl/workbook.xml' || path === 'xl/_rels/workbook.xml.rels') && partBytes > limits.maxMetadataBytes) throw new ExcelInputError('Workbook metadata exceeds budget');
            if (output && !output.write(chunk)) await once(output, 'drain');
          }
          if (output) { output.end(); await finished; }
        } finally { output?.destroy(); }
      }
    } finally {
      options.signal?.removeEventListener('abort', abort); input.destroy(); zip.destroy();
    }

    const workbook = parts.get('xl/workbook.xml'), relationships = parts.get('xl/_rels/workbook.xml.rels');
    if (!workbook || !relationships) throw new ExcelInputError('Missing workbook metadata');
    const sheets: { name: string; relationship: string }[] = [];
    const targets = new Map<string, string>();
    await parseXml(workbook, parser => parser.on('opentag', node => {
      if (localName(node.name) === 'sheet') {
        if (sheets.length >= limits.maxSheets) throw new ExcelInputError('Workbook exceeds maxSheets');
        sheets.push({ name: String(node.attributes.name ?? ''), relationship: String(node.attributes['r:id'] ?? '') });
      }
    }), options.signal);
    await parseXml(relationships, parser => parser.on('opentag', node => {
      if (localName(node.name) === 'Relationship' && node.attributes.TargetMode !== 'External') {
        const target = String(node.attributes.Target ?? '');
        const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join('xl', target));
        targets.set(String(node.attributes.Id ?? ''), path);
      }
    }), options.signal);
    const index = typeof options.sheet === 'string' ? sheets.findIndex(sheet => sheet.name === options.sheet) : (options.sheet ?? 1) - 1;
    const selected = sheets[index];
    if (!selected) throw new ExcelInputError('Selected worksheet was not found');
    const sheetFile = parts.get(targets.get(selected.relationship) ?? '');
    if (!sheetFile) throw new ExcelInputError('Selected worksheet part was not found');

    database = new DatabaseSync(join(directory, 'strings.sqlite'));
    database.exec('PRAGMA cache_size=-2048; CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = database.prepare('INSERT INTO strings (id, value) VALUES (?, ?)');
    const lookup = database.prepare('SELECT value FROM strings WHERE id = ?');
    const shared = parts.get('xl/sharedStrings.xml');
    if (shared) {
      let stringIndex = 0, value = '', inString = false, inText = false, phonetic = 0;
      database.exec('BEGIN');
      await parseXml(shared, parser => {
        parser.on('opentag', node => {
          const name = localName(node.name);
          if (name === 'si') { inString = true; value = ''; }
          if (name === 'rPh') phonetic++;
          if (name === 't' && inString && !phonetic) inText = true;
        });
        parser.on('text', text => { if (inText) { value += text; if (value.length > limits.maxCellChars) throw new ExcelInputError('Shared string exceeds maxCellChars'); } });
        parser.on('closetag', node => {
          const name = localName(node.name);
          if (name === 't') inText = false;
          if (name === 'rPh') phonetic--;
          if (name === 'si') {
            insert.run(stringIndex++, value); inString = false;
            if (stringIndex % 1000 === 0) database!.exec('COMMIT; BEGIN');
          }
        });
      }, options.signal, limits.maxCellChars);
      database.exec('COMMIT');
    }

    let rowNumber = 0, previousRow = 0, cells: ExcelValue[] = [], inRow = false;
    let cellColumn = 0, cellType = '', raw = '', formula = false, insideValue = false, insideText = false, phonetic = 0, rowChars = 0;
    let header: string[] | undefined;
    let ready: { rowNumber: number; cells: ExcelValue[] }[] = [];
    const parser = new SaxesParser();
    parser.on('doctype', () => { throw new ExcelInputError('DOCTYPE is not supported'); });
    function append(text: string): void {
      raw += text; rowChars += text.length;
      if (raw.length > limits.maxCellChars || rowChars > limits.maxRowChars) throw new ExcelInputError('Worksheet cell/row exceeds text budget');
    }
    parser.on('opentag', node => {
      const name = localName(node.name);
      if (name === 'row') {
        rowNumber = Number(node.attributes.r);
        if (!Number.isSafeInteger(rowNumber) || rowNumber <= previousRow) throw new ExcelInputError('Worksheet row numbers must be positive and increasing');
        previousRow = rowNumber; cells = []; inRow = true; rowChars = 0;
      } else if (name === 'c' && inRow) {
        const address = /^([A-Z]+)(\d+)$/.exec(String(node.attributes.r ?? ''));
        if (!address || Number(address[2]) !== rowNumber) throw new ExcelInputError('Invalid worksheet cell address');
        cellColumn = 0;
        for (const letter of address[1]!) cellColumn = cellColumn * 26 + letter.charCodeAt(0) - 64;
        if (cellColumn > limits.maxColumns) throw new ExcelInputError('Worksheet exceeds maxColumns');
        if (cells[cellColumn - 1] !== undefined) throw new ExcelInputError('Duplicate worksheet cell address');
        cellType = String(node.attributes.t ?? 'n'); raw = ''; formula = false; insideValue = false; insideText = false;
      } else if (name === 'f' && inRow) formula = true;
      else if (name === 'v' && inRow) insideValue = true;
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && inRow && cellType === 'inlineStr' && !phonetic) insideText = true;
    });
    parser.on('text', text => { if (insideValue || insideText) append(text); });
    parser.on('closetag', node => {
      const name = localName(node.name);
      if (name === 'v') insideValue = false;
      if (name === 't') insideText = false;
      if (name === 'rPh') phonetic--;
      if (name === 'c' && inRow) {
        if (formula && options.formulas !== 'cached') throw new ExcelInputError(`Formula rejected at worksheet row ${rowNumber}`);
        if (formula && raw === '') throw new ExcelInputError('Formula has no cached result');
        let value: ExcelValue = raw === '' ? null : raw;
        if (cellType === 's') {
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ExcelInputError('Invalid shared string index');
          const stored = lookup.get(Number(raw));
          if (!stored) throw new ExcelInputError('Shared string index was not found');
          value = String(stored.value);
          rowChars += value.length;
        } else if (cellType === 'b') {
          if (!['0', '1'].includes(raw)) throw new ExcelInputError('Invalid boolean cell');
          value = raw === '1';
        } else if (cellType === 'n' && raw !== '') value = numericText(raw, limits.maxCellChars);
        else if (cellType === 'e') throw new ExcelInputError(`Excel error cell at row ${rowNumber}: ${raw}`);
        else if (!['n', 'str', 'inlineStr', 'd'].includes(cellType)) throw new ExcelInputError(`Unsupported cell type: ${cellType}`);
        if (rowChars > limits.maxRowChars) throw new ExcelInputError('Worksheet row exceeds maxRowChars');
        cells[cellColumn - 1] = value;
      }
      if (name === 'row') { ready.push({ rowNumber, cells }); inRow = false; }
    });
    const inputSheet = createReadStream(sheetFile, { highWaterMark: 16384 });
    const decoder = new StringDecoder('utf8');
    async function* emitRows(): AsyncGenerator<SourceRow<T>> {
      const batch = ready; ready = [];
      for (const row of batch) {
        options.signal?.throwIfAborted();
        if (row.rowNumber < headerRow) continue;
        if (row.rowNumber === headerRow) {
          const names = Array.from({ length: row.cells.length }, (_, i) => row.cells[i]);
          if (!names.length || names.some(value => typeof value !== 'string' || !value.trim()) || new Set(names).size !== names.length) throw new ExcelInputError('Excel headers must be unique nonempty strings');
          header = names as string[];
          if (options.requiredColumns?.some(column => !header!.includes(column))) throw new ExcelInputError('Required Excel columns are missing');
          continue;
        }
        if (!header) throw new ExcelInputError('Configured headerRow was not found');
        if (row.cells.every(value => value === null || value === '')) continue;
        if (row.cells.length > header.length) throw new ExcelInputError('Worksheet row contains cells beyond the header');
        const record: ExcelRecord = Object.fromEntries(header.map((name, i) => [name, row.cells[i] ?? null]));
        const context = { sheetName: selected!.name, sheetIndex: index + 1, rowNumber: row.rowNumber };
        const id = options.getId ? options.getId(record, context) : JSON.stringify([options.sourceId, context.sheetName, context.rowNumber]);
        if (typeof id !== 'string' || !id.trim()) throw new ExcelInputError('Excel source row ID must be a nonempty string');
        const data = options.map ? await options.map(record, context) : record as unknown as T;
        options.signal?.throwIfAborted(); yield { id, line: row.rowNumber, data };
      }
    }
    try {
      const guard = tokenBudget(limits.maxCellChars);
      for await (const chunk of inputSheet) {
        options.signal?.throwIfAborted(); const text = decoder.write(chunk); guard(text); parser.write(text);
        yield* emitRows();
      }
      parser.write(decoder.end()).close(); yield* emitRows();
      if (!header) throw new ExcelInputError('Configured headerRow was not found');
    } finally { inputSheet.destroy(); }
  } finally {
    try { database?.close(); }
    finally {
      // Verify the absolute deletion target is the directory created by this call.
      if (dirname(resolve(directory)) !== parent || !basename(directory).startsWith('reconciliation-excel-')) throw new ExcelInputError('Unsafe temporary cleanup target');
      await rm(directory, { recursive: true, force: true });
    }
  }
}
