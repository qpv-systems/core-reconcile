import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const count = 100000;
const file = resolve('.test-output/excel-memory.xlsx');
await mkdir(resolve('.test-output'), { recursive: true });
if (process.argv[2] === 'generate') {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true });
  const sheet = workbook.addWorksheet('Records'); sheet.addRow(['id','amount']).commit();
  for (let i = 0; i < count; i++) sheet.addRow([String(i).padStart(9, '0'), '123.45']).commit();
  sheet.commit(); await workbook.commit(); console.log(`Generated ${count} rows with unique shared-string IDs`);
} else {
  const { readExcelRows } = await import('../dist/adapters/excel.js');
  let rows = 0, heap = 0, rss = 0;
  const started = performance.now();
  for await (const row of readExcelRows(file, { sourceId: 'memory-test', sheet: 'Records' })) {
    assert.equal(row.data.id, String(rows).padStart(9, '0')); assert.equal(row.data.amount, '123.45'); rows++;
    if (rows % 1000 === 0) { const m = process.memoryUsage(); heap = Math.max(heap,m.heapUsed); rss = Math.max(rss,m.rss); }
  }
  assert.equal(rows, count);
  console.log(JSON.stringify({ excelRows: rows, seconds: Number(((performance.now()-started)/1000).toFixed(2)), sampledHeapMiB: Number((heap/1024**2).toFixed(2)), sampledRssMiB: Number((rss/1024**2).toFixed(2)), memorySamplingEveryRows: 1000 }, null, 2));
}
