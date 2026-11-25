'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { relationIntent, compatibleColumns, inspectCrossLogical, visibleCrossEdges, readSaved } = require('../src/db/cross-schema-logical');

const child = { schema: 'app', table: 'entries' }, parent = { schema: 'related', table: 'entries' };
const pairs = [{ child: 'ref', parent: 'id' }, { child: 'token', parent: 'token' }];
const draft = { name: 'Approved relation', child, parent, pairs };
const contract = {
  app: [['id', 'int', null, null], ['ref', 'bigint unsigned', null, null], ['token', 'varbinary(8)', null, null]],
  related: [['id', 'bigint unsigned', null, null], ['token', 'varbinary(8)', null, null]]
};

function connection({ account = 'me@loopback', changed = false, physical = false, trace = [] } = {}) {
  return async (statement, bindings) => {
    trace.push(statement);
    if (statement.startsWith('SELECT VERSION()')) return { rows: [['8.4.13', account, 'NONE', 'app', '', 'SYSTEM']] };
    if (statement === 'SELECT @@server_uuid') return { rows: [['disposable-engine']] };
    const schema = bindings?.[0];
    if (statement.startsWith('SELECT TABLE_SCHEMA')) return { rows: [[schema, 'entries', 'BASE TABLE', 'InnoDB']] };
    if (statement.startsWith('SHOW CREATE TABLE')) return { rows: [['entries', 'CREATE TABLE entries (id INT)' + (changed ? ' ROW_FORMAT=COMPACT' : '')]] };
    if (statement.startsWith('SELECT COLUMN_NAME,COLUMN_TYPE')) return { rows: contract[schema] };
    if (statement.startsWith('SELECT COLUMN_NAME,ORDINAL_POSITION')) return { rows: schema === 'app' ? [['id', 1]] : [['id', 1], ['token', 2]] };
    if (statement.startsWith('SELECT CONSTRAINT_NAME')) return { rows: physical ? [['fk', 'ref', 'id', 1], ['fk', 'token', 'token', 2]] : [] };
    throw Error('Unexpected statement ' + statement);
  };
}

test('cross-schema annotations require explicitly distinct schema and matching typed key pairs', async () => {
  assert.deepEqual(relationIntent(draft), draft);
  assert.throws(() => relationIntent({ ...draft, parent: { schema: 'app', table: 'z' } }), /different schemas/);
  assert.throws(() => relationIntent({ ...draft, pairs: [...pairs, pairs[0]] }), /appear once/);
  assert.equal(compatibleColumns({ type: 'int unsigned' }, { type: 'int' }), false);
  assert.equal(compatibleColumns({ type: 'varchar(8)', charset: 'utf8mb4', collation: 'utf8mb4_bin' },
    { type: 'varchar(8)', charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }), false);
  await assert.rejects(inspectCrossLogical(connection(), 'app', { ...draft, pairs: [...pairs].reverse() }), /observed order/);
  await assert.rejects(inspectCrossLogical(connection({ physical: true }), 'app', draft), /already exists as a physical foreign key/);
});

test('approved annotations resolve both exact endpoints and disappear after account or definition drift', async () => {
  const record = { id: 'fixture-relation', ...await inspectCrossLogical(connection(), 'app', draft) };
  assert.deepEqual(readSaved(record), record);
  const forward = await visibleCrossEdges(connection(), child, [record]);
  const reverse = await visibleCrossEdges(connection(), parent, [record]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].kind, 'logical');
  assert.deepEqual(forward[0].parts, [
    { column: 'ref', foreignColumn: 'id', ordinal: 1 }, { column: 'token', foreignColumn: 'token', ordinal: 2 }
  ]);
  assert.deepEqual(await visibleCrossEdges(connection({ changed: true }), child, [record]), []);
  const trace = [];
  assert.deepEqual(await visibleCrossEdges(connection({ account: 'different@loopback', trace }), child, [record]), []);
  assert(!trace.some(statement => statement.startsWith('SHOW CREATE TABLE')));
  assert.deepEqual(await visibleCrossEdges(connection(), { schema: 'third', table: 'entries' }, [record]), []);
});
