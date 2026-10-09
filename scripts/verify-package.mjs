// Exercise the actual npm artifact in an isolated consumer, outside this repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check through npm run test:package');
const parent = resolve(tmpdir());
const folder = await mkdtemp(join(parent, 'core-reconcile-package-'));

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

try {
  // The script builds before entering here; avoid extra lifecycle output in JSON.
  const manifests = JSON.parse(
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', folder], root),
  );
  assert.equal(manifests.length, 1);
  const artifact = manifests[0];
  assert.equal(artifact.name, '@qpv-systems/core-reconcile');
  assert.equal(basename(artifact.filename), artifact.filename);
  const files = new Set(artifact.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'CHANGELOG.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/adapters/excel.js',
    'dist/adapters/excel.d.ts',
  ]) {
    assert.ok(files.has(required), `Missing package file: ${required}`);
  }
  for (const file of files) {
    assert.match(
      file,
      /^(dist\/|docs\/|package\.json$|README\.md$|CONTRIBUTING\.md$|LICENSE$|CHANGELOG\.md$)/,
    );
    assert.doesNotMatch(file, /(^|\/)(demo|server|test|node_modules)(\/|\.|$)/);
  }

  const consumer = join(folder, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'core-reconcile-consumer-check',
      private: true,
      type: 'module',
    }),
  );
  npm(
    ['install', '--omit=dev', '--no-audit', '--no-fund', join(folder, artifact.filename)],
    consumer,
  );

  // Generate an exact-value fixture without installing test dependencies in the consumer.
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>001</t></is></c><c r="B2"><v>9007199254740993.01</v></c></row></sheetData></worksheet>',
  );
  await writeFile(join(consumer, 'input.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
  await writeFile(
    join(consumer, 'smoke.mjs'),
    String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as core from '@qpv-systems/core-reconcile';
import { readExcelRows, ExcelInputError } from '@qpv-systems/core-reconcile/excel';

const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('exceljs'), { code: 'MODULE_NOT_FOUND' });
for (const name of ['reconcile', 'createReconciler', 'reconcileSorted', 'createSortKey',
  'reconcilePartitions', 'readDatabaseRows', 'readDatabaseBatches', 'ReconciliationInputError']) {
  assert.equal(typeof core[name], 'function', 'Missing export: ' + name);
}
assert.equal(typeof ExcelInputError, 'function');
const config = {
  version: 'artifact-policy-1',
  keys: [{ name: 'id', internal: [r => r.id], partner: [r => r.id] }],
  comparisons: [{ name: 'amount', kind: 'decimal', internal: r => r.amount,
    partner: r => r.amount, mismatchStatus: 'AMOUNT_MISMATCH' }],
};
const row = { id: '001', amount: '9007199254740993.01' };
const input = {
  batchId: 'artifact-check', runId: '1', processedAt: '2026-10-09T03:00:00Z',
  internal: { sourceId: 'db-snapshot', complete: true, rows: [{ id: 'db-row-1', data: row }] },
  partner: { sourceId: 'file-snapshot', complete: true, rows: [{ id: 'file-row-2', line: 2, data: row }] },
};
assert.equal(core.createReconciler(config).reconcile(input).summary.matchedPairs, 1);
let entries = 0, completed = false;
for await (const event of core.reconcileSorted({
  batchId: input.batchId, runId: input.runId, processedAt: input.processedAt, config,
  left: { sourceId: 'db-snapshot', complete: true,
    rows: core.readDatabaseRows([row], { getId: () => 'db-row-1' }) },
  right: { sourceId: 'file-snapshot', complete: true,
    rows: readExcelRows(fileURLToPath(new URL('./input.xlsx', import.meta.url)),
      { sourceId: 'file-snapshot', sheet: 'Records', requiredColumns: ['id', 'amount'] }) },
})) {
  if (event.type === 'entry') {
    assert.equal(event.entry.status, 'MATCHED');
    assert.equal(event.entry.internal.id, 'db-row-1');
    assert.equal(event.entry.partner.line, 2);
    assert.equal(event.entry.partner.data.amount, row.amount);
    entries++;
  }
  if (event.type === 'complete') {
    assert.equal(event.summary.matchedPairs, 1);
    completed = true;
  }
}
assert.equal(entries, 1);
assert.equal(completed, true);
console.log('Installed package: public exports, exact decimals, database and Excel verified.');
`,
  );
  execFileSync(process.execPath, [join(consumer, 'smoke.mjs')], {
    cwd: consumer,
    timeout: 60000,
    stdio: 'inherit',
  });
  console.log(
    `Package ${artifact.name}@${artifact.version}: ${files.size} files verified; no server or demo.`,
  );
} finally {
  assert.equal(dirname(resolve(folder)), parent);
  assert.ok(basename(folder).startsWith('core-reconcile-package-'));
  await rm(folder, { recursive: true, force: true });
}
