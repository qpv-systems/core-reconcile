import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readExcelRows, ExcelInputError } from '../dist/adapters/excel.js';
import { readDatabaseRows, readDatabaseBatches, reconcileSorted } from '../dist/index.js';

const collect = async (iterable) => {
  const result = [];
  for await (const row of iterable) result.push(row);
  return result;
};
async function workspace(run) {
  const parent = resolve(tmpdir()),
    folder = await mkdtemp(join(parent, 'reconciliation-test-'));
  try {
    await run(folder);
  } finally {
    assert.equal(dirname(resolve(folder)), parent);
    assert.ok(basename(folder).startsWith('reconciliation-test-'));
    await rm(folder, { recursive: true, force: true });
  }
}
async function workbook(folder, configure) {
  const book = new ExcelJS.Workbook();
  configure(book);
  const file = join(folder, 'input.xlsx');
  await book.xlsx.writeFile(file);
  return file;
}
const config = {
  version: '1',
  keys: [{ name: 'id', internal: [(r) => r.id], partner: [(r) => r.id] }],
  comparisons: [
    {
      name: 'amount',
      kind: 'decimal',
      internal: (r) => r.amount,
      partner: (r) => r.amount,
      mismatchStatus: 'AMOUNT_MISMATCH',
    },
  ],
};

test('XLSX shared strings, Unicode, numeric values, empty cells and physical row references', async () =>
  workspace(async (folder) => {
    const file = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Giao dịch');
      sheet.addRow(['id', 'amount', 'note', 'active', 'optional']);
      sheet.addRow(['001', '9007199254740993.01', 'hoa hồng, tiếng Việt', true, null]);
      sheet.addRow(['002', 123.45, 'numeric cell', false, null]);
      sheet.addRow([]);
      sheet.addRow(['003', '-0.50', { richText: [{ text: 'rich ' }, { text: 'text' }] }]);
    });
    const rows = await collect(
      readExcelRows(file, {
        sourceId: 'snapshot',
        tempDirectory: folder,
        requiredColumns: ['id', 'amount'],
      }),
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].data.amount, '9007199254740993.01');
    assert.equal(rows[0].data.active, true);
    assert.equal(rows[0].data.optional, null);
    assert.equal(rows[1].data.amount, '123.45');
    assert.equal(rows[2].line, 5);
    assert.equal(rows[2].data.note, 'rich text');
    assert.equal(rows[0].id, JSON.stringify(['snapshot', 'Giao dịch', 2]));
    assert.deepEqual(await readdir(folder), ['input.xlsx']);
  }));

test('XLSX selects sheet by name/index, custom header and maps rows/IDs', async () =>
  workspace(async (folder) => {
    const file = await workbook(folder, (book) => {
      book.addWorksheet('Ignore').addRow(['wrong']);
      const sheet = book.addWorksheet('Commissions');
      sheet.addRow(['title']);
      sheet.addRow([]);
      sheet.getRow(3).values = ['code', 'value'];
      sheet.getRow(4).values = ['a', '10.50'];
    });
    const options = {
      sourceId: 's',
      sheet: 'Commissions',
      headerRow: 3,
      tempDirectory: folder,
      getId: (row) => `db/${row.code}`,
      map: (row, context) => ({ id: row.code, amount: row.value, sheet: context.sheetName }),
    };
    const rows = await collect(readExcelRows(file, options));
    assert.deepEqual(rows[0], {
      id: 'db/a',
      line: 4,
      data: { id: 'a', amount: '10.50', sheet: 'Commissions' },
    });
    assert.equal((await collect(readExcelRows(file, { ...options, sheet: 2 })))[0].data.id, 'a');
    await assert.rejects(
      collect(readExcelRows(file, { ...options, sheet: 'unknown' })),
      /not found/,
    );
  }));

test('XLSX raw numeric precision, exponent notation and inline strings are preserved', async () =>
  workspace(async (folder) => {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>001</t></is></c><c r="B2"><v>9007199254740993.01</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>002</t></is></c><c r="B3"><v>1.25E-6</v></c></row></sheetData></worksheet>',
    );
    const file = join(folder, 'raw.xlsx');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const rows = await collect(readExcelRows(file, { sourceId: 's', tempDirectory: folder }));
    assert.equal(rows[0].data.amount, '9007199254740993.01');
    assert.equal(rows[1].data.amount, '0.00000125');
    assert.equal(rows[0].data.id, '001');
  }));

test('XLSX corrupted XML, error cells and callback failures clean staging', async () =>
  workspace(async (folder) => {
    const options = { sourceId: 's', tempDirectory: folder };
    const file = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'amount']);
      sheet.addRow(['a', { error: '#VALUE!' }]);
    });
    await assert.rejects(collect(readExcelRows(file, options)), /error cell/);
    await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'amount']);
      sheet.addRow(['a', '1']);
    });
    await assert.rejects(
      collect(
        readExcelRows(file, {
          ...options,
          map: () => {
            throw Error('mapping failed');
          },
        }),
      ),
      /mapping failed/,
    );
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook><sheets>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships/>');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(collect(readExcelRows(file, options)));
    assert.deepEqual(await readdir(folder), ['input.xlsx']);
  }));

test('XLSX formula policy rejects by default and cached values require opt-in', async () =>
  workspace(async (folder) => {
    const file = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'amount']);
      sheet.addRow(['a', { formula: '1+2', result: 3 }]);
    });
    const options = { sourceId: 's', tempDirectory: folder };
    await assert.rejects(collect(readExcelRows(file, options)), /Formula rejected/);
    assert.equal(
      (await collect(readExcelRows(file, { ...options, formulas: 'cached' })))[0].data.amount,
      '3',
    );
    assert.deepEqual(await readdir(folder), ['input.xlsx']);
  }));

test('XLSX rejects duplicate headers, missing columns, input/expansion/cell/column budgets', async () =>
  workspace(async (folder) => {
    const file = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'amount']);
      sheet.addRow(['a', '123456789']);
    });
    const options = { sourceId: 's', tempDirectory: folder };
    await assert.rejects(
      collect(readExcelRows(file, { ...options, requiredColumns: ['missing'] })),
      /Required Excel columns/,
    );
    await assert.rejects(
      collect(readExcelRows(file, { ...options, maxInputBytes: 1 })),
      /maxInputBytes/,
    );
    await assert.rejects(
      collect(readExcelRows(file, { ...options, maxExpandedBytes: 1 })),
      /maxExpandedBytes/,
    );
    await assert.rejects(collect(readExcelRows(file, { ...options, maxColumns: 1 })), /maxColumns/);
    await assert.rejects(
      collect(readExcelRows(file, { ...options, maxCellChars: 8 })),
      /budget|maxCellChars/,
    );
    await assert.rejects(collect(readExcelRows('legacy.xls', options)), ExcelInputError);
    const duplicate = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'id']);
      sheet.addRow(['a', 'b']);
    });
    await assert.rejects(collect(readExcelRows(duplicate, options)), /headers/);
    assert.deepEqual(await readdir(folder), ['input.xlsx']);
  }));

test('XLSX cleans disk staging on early consumer return and cancellation', async () =>
  workspace(async (folder) => {
    const file = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'amount']);
      for (const id of ['a', 'b', 'c']) sheet.addRow([id, '1']);
    });
    const iterator = readExcelRows(file, { sourceId: 's', tempDirectory: folder });
    await iterator.next();
    await iterator.return();
    assert.deepEqual(await readdir(folder), ['input.xlsx']);
    const controller = new AbortController();
    const canceled = readExcelRows(file, {
      sourceId: 's',
      tempDirectory: folder,
      signal: controller.signal,
    });
    await canceled.next();
    controller.abort();
    await assert.rejects(canceled.next(), { name: 'AbortError' });
    assert.deepEqual(await readdir(folder), ['input.xlsx']);
  }));

test('XLSX-to-cursor reconciliation uses the same core and preserves decimal precision', async () =>
  workspace(async (folder) => {
    const file = await workbook(folder, (book) => {
      const sheet = book.addWorksheet('Data');
      sheet.addRow(['id', 'amount']);
      sheet.addRow(['a', '9007199254740993.01']);
      sheet.addRow(['b', '2']);
    });
    async function* cursor() {
      yield { pk: 'db-1', id: 'a', amount: '9007199254740993.01' };
      yield { pk: 'db-2', id: 'b', amount: '3' };
    }
    const events = await collect(
      reconcileSorted({
        batchId: 'b',
        runId: 'r',
        processedAt: '2026-10-09T00:00:00Z',
        config,
        left: {
          sourceId: 'db',
          complete: true,
          rows: readDatabaseRows(cursor(), { getId: (row) => row.pk }),
        },
        right: {
          sourceId: 'xlsx',
          complete: true,
          rows: readExcelRows(file, { sourceId: 'xlsx', tempDirectory: folder }),
        },
      }),
    );
    assert.equal(events.at(-1).summary.matchedPairs, 1);
    assert.equal(events.at(-1).summary.nonMatchedEntries, 1);
    assert.equal(events[1].entry.issues[0].difference, '1');
  }));

test('database adapter is lazy, maps rows and closes on completion/early return/errors', async () => {
  let reads = 0,
    iteratorClosed = 0,
    resourceClosed = 0;
  async function* cursor() {
    try {
      for (const id of ['a', 'b', 'c']) {
        reads++;
        yield { id, value: '1' };
      }
    } finally {
      iteratorClosed++;
    }
  }
  const options = {
    getId: (row) => row.id,
    map: async (row) => ({ amount: row.value }),
    close: () => {
      resourceClosed++;
    },
  };
  const iterator = readDatabaseRows(cursor(), options);
  assert.equal(reads, 0);
  assert.deepEqual((await iterator.next()).value, { id: 'a', data: { amount: '1' } });
  assert.equal(reads, 1);
  await iterator.return();
  assert.equal(iteratorClosed, 1);
  assert.equal(resourceClosed, 1);
  await collect(readDatabaseRows(cursor(), options));
  assert.equal(resourceClosed, 2);
  await assert.rejects(
    collect(
      readDatabaseRows(cursor(), {
        ...options,
        map: () => {
          throw Error('mapper failed');
        },
      }),
    ),
    /mapper failed/,
  );
  assert.equal(iteratorClosed, 3);
  assert.equal(resourceClosed, 3);
});

test('database batches preserve backpressure, enforce size and cancel/close safely', async () => {
  let fetched = 0,
    closed = 0;
  async function* pages() {
    fetched++;
    yield [{ id: 'a' }, { id: 'b' }];
    fetched++;
    yield [{ id: 'c' }];
  }
  const iterator = readDatabaseBatches(pages(), {
    getId: (row) => row.id,
    maxBatchRows: 2,
    close: () => {
      closed++;
    },
  });
  await iterator.next();
  await iterator.next();
  assert.equal(fetched, 1);
  await iterator.return();
  assert.equal(closed, 1);
  await assert.rejects(
    collect(readDatabaseBatches(pages(), { getId: (row) => row.id, maxBatchRows: 1 })),
    /exceeds/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collect(
      readDatabaseRows([], {
        getId: (row) => row.id,
        signal: controller.signal,
        close: () => {
          closed++;
        },
      }),
    ),
    { name: 'AbortError' },
  );
  assert.equal(closed, 2);
  await assert.rejects(
    collect(readDatabaseRows([{ id: '' }], { getId: (row) => row.id })),
    /nonempty/,
  );
});
