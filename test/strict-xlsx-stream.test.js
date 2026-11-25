'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanSource } = require('../src/db/import-stream-source');
const { zip, workbook } = require('./helpers/xlsx-fixture');
const { strictEntries, strictRows, strictWorkbook, spreadsheet, relationships,
  transitionalSpreadsheet, transitionalRelationships } = require('./helpers/strict-xlsx-fixture');

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-strict-xlsx-')), file = path.join(folder, 'workbook.xlsx');
  t.after(async () => {
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder);
  });
  return file;
}

test('strict XLSX worksheet selection preserves mixed stored cell types and original number precision', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, strictWorkbook(strictRows(1250)));
  const summary = await scanSource({ file });
  assert.equal(summary.xlsxVariant, 'strict');
  assert.deepEqual(summary.sheets.map(sheet => sheet.id), ['1', '2']);
  const selection = { file, sheetId: '1', blankPolicy: 'null' };
  await assert.rejects(scanSource(selection), /Formula cells/);
  const report = await scanSource({ ...selection, formulaPolicy: 'cached' });
  assert.equal(report.rowCount, 1250);
  assert.equal(report.formulaCount, 1);
  assert.equal(report.xlsxVariant, 'strict');
  assert.equal(report.dateSystem, '1904');
  assert.deepEqual(report.preview.slice(0, 2), [
    ['검증 shared & literal', '1234567890123456.12345678', '18446744073709551615', null, '2026-01-03 12:34:56.123456', '1'],
    ['Strict 1', '0.00000001', '9007199254740993', '', '1904-01-01 12:00:00', '0']
  ]);
  assert.deepEqual((await scanSource({ file, sheetId: '2' })).preview, [['Other selected row']]);
  await fs.writeFile(file, workbook());
  assert.equal((await scanSource({ file, sheetId: '1' })).xlsxVariant, 'transitional');
});

test('strict package refuses worksheet/style namespace drift and alternate relationship IDs', async t => {
  const file = await fixture(t);
  const mutations = [
    ['_rels/.rels', text => text.replace(relationships, transitionalRelationships), /Workbook does not match/],
    ['xl/workbook.xml', text => text.replace('conformance="strict"', 'conformance="transitional"'), /conformance declaration disagree/],
    ['xl/workbook.xml', text => text.replace('xmlns:r="' + relationships, 'xmlns:r="' + transitionalRelationships), /Invalid workbook sheets/],
    ['xl/styles.xml', text => text.replace(spreadsheet, transitionalSpreadsheet), /Styles does not match/],
    ['xl/_rels/workbook.xml.rels', text => text.replace(relationships + '/styles', transitionalRelationships + '/styles'), /mixes Strict and Transitional/],
    ['xl/worksheets/sheet1.xml', text => text.replace(spreadsheet, transitionalSpreadsheet), /Invalid worksheet namespace/],
    ['xl/worksheets/sheet1.xml', text => text.replace('<v>0</v>', '<v xmlns="' + transitionalSpreadsheet + '">0</v>'), /mixes Strict and Transitional/],
    ['xl/_rels/workbook.xml.rels', text => text.replace('Target="styles.xml"', 'Target="https://example.invalid/styles.xml" TargetMode="External"'), /External/]
  ];
  for (const [part, alter, message] of mutations) {
    const doc = strictEntries(strictRows(2));
    const original = doc[part];
    doc[part] = alter(original);
    assert.notEqual(doc[part], original);
    await fs.writeFile(file, zip(doc));
    await assert.rejects(scanSource({ file, sheetId: '1', formulaPolicy: 'cached' }), message, part);
  }
});
