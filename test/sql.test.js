'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { statementAt, toCsv, spreadsheetText } = require('../src/sql');

test('SQL run at the end of a statement line keeps that statement', () => {
  const sql = 'SELECT 1;   \r\n-- following note\r\nSELECT 2;';
  assert.equal(statementAt(sql, sql.indexOf(';') + 1), 'SELECT 1;');
  assert.equal(statementAt(sql, sql.indexOf('\r')), 'SELECT 1;');
  assert.equal(statementAt(sql, sql.indexOf('following')), '-- following note\r\nSELECT 2;');
  assert.equal(statementAt(sql, sql.indexOf('SELECT 2') + 4), '-- following note\r\nSELECT 2;');
  const sameLine = 'SELECT 1; SELECT 2;';
  assert.equal(statementAt(sameLine, sameLine.indexOf(';') + 1), 'SELECT 2;');
  const demo = 'SELECT * FROM projects;\n\n-- Select SQL or place the cursor in a statement.';
  assert.equal(statementAt(demo, demo.indexOf(';') + 1, { dialect: 'sqlite' }), 'SELECT * FROM projects;');
});
test('statement selection respects strings, escaped identifiers and comments', () => {
  const sql = "SELECT ';' AS `a;b`;\n-- note ;\nSELECT 2;\nSELECT 'it''s;fine';";
  assert.equal(statementAt(sql, 4), "SELECT ';' AS `a;b`;");
  assert.equal(statementAt(sql, sql.indexOf('SELECT 2') + 4), '-- note ;\nSELECT 2;');
  assert.equal(statementAt(sql, sql.length), "SELECT 'it''s;fine';");
});
test('empty editor and trailing whitespace are handled', () => {
  assert.equal(statementAt('', 0), '');
  assert.equal(statementAt('SELECT 1;\n\n', 11), 'SELECT 1;');
});
test('SQLite backslashes do not escape a closing quote', () => {
  const sql = "SELECT 'a\\';\nSELECT 2;";
  assert.equal(statementAt(sql, sql.length, { dialect: 'sqlite' }), 'SELECT 2;');
});
test('TSV and CSV share spreadsheet formula protection', () => {
  assert.equal(spreadsheetText('  =HYPERLINK("url")'), '\'  =HYPERLINK("url")');
  assert.equal(spreadsheetText('ordinary text'), 'ordinary text');
});
test('CSV safely quotes text and neutralizes spreadsheet formulas', () => {
  const csv = toCsv({ columns: ['text'], rows: [['=1+1'], ['a,"b\nc'], [null]] });
  assert.ok(csv.startsWith('\uFEFF"text"'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"a,""b\nc"'));
});
