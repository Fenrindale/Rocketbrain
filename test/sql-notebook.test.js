'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { captureResult, decodeNotebook, encodeNotebook, limits, renderResult, sourceDigest } = require('../src/db/sql-notebook');

test('SQL notebooks transfer source and explicitly pinned output without retaining unrelated metadata', () => {
  const source = 'SELECT 1 AS number';
  const result = captureResult({ columns:['number', 'nil'], rows:[['18446744073709551615', null]], truncated:false }, source);
  const notebook = [{ type:'markdown', source:'## Results' }, { type:'sql', source, result },
    { type:'sql', source:'SELECT 2', metadata:{ password:'not retained' }, outputs:['not retained'] }];
  const data = encodeNotebook(notebook);
  assert.doesNotMatch(data.toString('utf8'), /password|not retained/);
  assert.deepEqual(decodeNotebook(data), notebook.slice(0, 2).concat({ type:'sql', source:'SELECT 2' }));
  assert.equal(result.sourceDigest, sourceDigest(source));
});

test('SQL notebook tables cap displayed data, escape markup and retain NULL separately', () => {
  const columns = Array.from({ length:limits.columns + 1 }, (_, index) => 'column_' + index);
  columns[0] = '<column>';
  const row = columns.map(() => '&'.repeat(4096));
  row[0] = '<strong>result</strong>';
  row[1] = null;
  const result = captureResult({ columns, rows:[row, row], truncated:false }, 'SELECT * FROM data');
  assert.ok(result.truncated);
  assert.ok(result.rows.length > 0);
  assert.equal(result.columns.length, limits.columns);
  assert.ok(result.rows[0][2].endsWith('…'));
  assert.equal(result.rows[0][1], null);
  const output = renderResult(result);
  assert.match(output.html, /&lt;column&gt;.*&lt;strong&gt;result&lt;\/strong&gt;<\/td><td><em>NULL<\/em>/s);
  assert.doesNotMatch(output.html, /<strong>/);
  assert.match(output.text, /Preview limited/);
});

test('SQL notebook serialization rejects invalid encodings, types, limits and saved row shapes', () => {
  assert.throws(() => decodeNotebook(Uint8Array.of(255)), /UTF-8/);
  assert.throws(() => decodeNotebook(Buffer.from('{"version":2,"cells":[]}')), /format version/);
  assert.throws(() => encodeNotebook([{ type:'javascript', source:'1' }]), /SQL or Markdown/);
  assert.throws(() => encodeNotebook([{ type:'sql', source:'SELECT\0 1' }]), /SQL or Markdown/);
  assert.throws(() => encodeNotebook(Array.from({ length:65 }, () => ({ type:'sql', source:'' }))), /at most 64/);
  assert.throws(() => encodeNotebook(Array.from({ length:24 }, () => ({ type:'sql', source:'x'.repeat(100000) }))), /exceeds 2 MiB/);
  assert.throws(() => encodeNotebook([{ type:'sql', source:'SELECT 1', result:{
    sourceDigest:sourceDigest('SELECT 1'), capturedAt:0, truncated:false, columns:['one'], rows:[['one', 'two']]
  } }]), /saved result table/);
});
