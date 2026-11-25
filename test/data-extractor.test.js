'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileExtractor, describeCapture, extract } = require('../src/db/data-extractor');
const { createExtractorReviews, loadExtractor } = require('../src/db/data-extractor-review');

const captured = () => ({ columns: ['id', 'metric', 'note'], rows: [
  ['9007199254740994', '-1234567890.123456', '=formula'], ['9007199254740995', '1234567890.123457', null]
], fields: [{ schema: 'app', originalTable: 'scores', type: 8 }, { schema: 'app', originalTable: 'scores', type: 246 },
  { schema: 'app', originalTable: 'scores', type: 253, characterSet: 45 }] });
const script = JSON.stringify({ version: 1, name: 'Typed lines', extension: 'txt',
  header: [{ meta: 'source.schema' }, ' ', { columns: { template: [{ meta: 'column.name' }, ':', { meta: 'column.kind' }], separator: '|' } }, '\n'],
  row: [{ cell: 1 }, ' ', { cell: 'metric' }, ' ', { cell: 'note', as: 'csv' }, '\n'],
  footer: ['Total: ', { aggregate: { operation: 'sum', cell: 'metric' } }, ', rows: ', { meta: 'rows.emitted' }, '\n'] });

test('versioned extractors render typed metadata and stream numbered values and exact decimal aggregates', async () => {
  const result = captured();
  const program = compileExtractor(script, describeCapture(result));
  const stream = extract(program, result.rows);
  assert.equal((await stream.next()).value.toString(), 'app id:integer|metric:decimal|note:text\n');
  assert.equal((await stream.next()).value.toString(), '9007199254740994 -1234567890.123456 "\'=formula"\n');
  assert.equal((await stream.next()).value.toString(), '9007199254740995 1234567890.123457 ""\n');
  assert.equal((await stream.next()).value.toString(), 'Total: 0.000001, rows: 2\n');
  assert.equal((await stream.next()).done, true);
  const one = compileExtractor(JSON.stringify({ ...JSON.parse(script), filter: { cell: 'note', equals: null } }), describeCapture(result));
  const retained = [];
  for await (const chunk of extract(one, result.rows)) retained.push(chunk.toString());
  assert.equal(retained.length, 3);
  assert.match(retained[2], /1234567890\.123457, rows: 1/);
});

test('extractor instructions reject host capabilities and ambiguous names', () => {
  const capture = describeCapture(captured());
  assert.throws(() => compileExtractor(JSON.stringify({ ...JSON.parse(script), row: [{ fs: 'read files' }] }), capture), /Unknown or misplaced/);
  assert.throws(() => compileExtractor(JSON.stringify({ ...JSON.parse(script), row: [{ cell: 'id' }] }),
    { ...capture, columns: [...capture.columns, { ...capture.columns[0], ordinal: 4 }] }), /unique result column/);
  assert.throws(() => compileExtractor(JSON.stringify({ ...JSON.parse(script), footer: [{ aggregate: { operation: 'sum', cell: 'note' } }] }), capture), /observed database integer or decimal/);
});

test('reviewed extractor output is exact, refuses stale data or overwrite and cleans unpublished bytes', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-extractor-test-'));
  const file = path.join(folder, 'result.txt'), definition = path.join(folder, 'typed.rbextract.json');
  let value = captured(), trusted = true;
  const manager = createExtractorReviews({ getCapture: id => id === 1 ? value : undefined, canRead: () => trusted });
  try {
    await fs.writeFile(definition, script);
    assert.equal(await loadExtractor(definition), script);
    const review = await manager.prepare(1, script);
    trusted = false;
    await assert.rejects(manager.write(review.id, file, { confirmed: true }), /Trust this workspace/);
    trusted = true;
    await assert.rejects(manager.write(review.id, file), /Approve the reviewed/);
    const saved = await manager.write(review.id, file, { confirmed: true });
    assert.equal(saved.sha256, review.sha256);
    assert.equal(await fs.readFile(file, 'utf8'), review.preview);
    const duplicate = await manager.prepare(1, script);
    await assert.rejects(manager.write(duplicate.id, file, { confirmed: true }), /Choose a new output name/);
    assert.equal(await fs.readFile(file, 'utf8'), review.preview);
    const stale = await manager.prepare(1, script);
    value = captured();
    await assert.rejects(manager.write(stale.id, file, { confirmed: true }), /captured result changed/);
    const changed = await manager.prepare(1, script);
    value.rows[1][1] = '00.1000';
    await assert.rejects(manager.write(changed.id, file, { confirmed: true }), /differs from the review/);
    assert.deepEqual((await fs.readdir(folder)).sort(), ['result.txt', 'typed.rbextract.json']);
  } finally {
    manager.dispose();
    for (const child of [definition, file]) await fs.unlink(child).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder);
  }
});
