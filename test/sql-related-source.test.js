'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProjection, proveProjection, keyParameters, sourceServer } = require('../src/db/sql-related-source');

const metadata = {
  columns: [
    { name: 'tenant', type: 'bigint unsigned', charset: null, collation: null },
    { name: 'token', type: 'varbinary(16)', charset: null, collation: null },
    { name: 'owner', type: 'int', charset: null, collation: null }
  ], primary: ['tenant', 'token'], fingerprint: 'capture'
};

test('only a direct single source SELECT can attach a physical projection proof', () => {
  const shape = parseProjection('SELECT c.tenant AS key_value,c.token AS key_value,owner FROM `db`.`child` AS c WHERE owner=2 ORDER BY owner LIMIT 3;', 'local');
  assert.deepEqual(shape, { schema: 'db', table: 'child', alias: 'c', projection: [
    { column: 'tenant', label: 'key_value' }, { column: 'token', label: 'key_value' }, { column: 'owner', label: 'owner' }
  ] });
  assert.equal(parseProjection('SELECT c.* FROM child c', 'db').projection, null);
  for (const statement of [
    'SELECT c.tenant + 1 AS tenant FROM child c',
    'WITH x AS (SELECT * FROM child) SELECT * FROM x',
    'SELECT * FROM (SELECT * FROM child) c',
    'SELECT x.* FROM child x, parent y',
    'SELECT DISTINCT * FROM child',
    'SELECT * FROM child WHERE EXISTS (SELECT 1 FROM parent)',
    'SELECT * FROM child JOIN parent USING (tenant)',
    'SELECT * FROM child GROUP BY tenant',
    'SELECT * FROM child WHERE 1; SELECT * FROM parent',
    'SELECT * FROM "child"',
    'SELECT * FROM child /*!50100 WHERE 1 */'
  ]) assert.equal(parseProjection(statement, 'db'), null, statement);
});

test('driver column origins and every primary-key column are required even when labels are duplicated', () => {
  const projection = parseProjection('SELECT c.tenant AS d,c.token AS d,c.owner FROM child c', 'db');
  const fields = ['tenant', 'token', 'owner'].map((originalName, index) => ({
    name: index < 2 ? 'd' : 'owner', originalName, schema: 'db', table: 'c', originalTable: 'child'
  }));
  const result = { columns: ['d', 'd', 'owner'], fields };
  const source = proveProjection(result, projection, metadata);
  assert.deepEqual(source.columns, ['tenant', 'token', 'owner']);
  assert.deepEqual(keyParameters(source, ['9007199254740993', '0x00ff', 7]), [
    { sql: 'CAST(? AS UNSIGNED)', parameter: '9007199254740993' }, { sql: '?', parameter: Buffer.from([0, 255]) }
  ]);
  assert.throws(() => keyParameters(source, [9007199254740992, '0x00ff']), /unsupported/);
  assert.throws(() => keyParameters(source, ['9007199254740993', null]), /unsupported/);
  for (const wrong of [{ originalName: 'owner' }, { table: 'child' }, { schema: 'other' }, { originalTable: 'other' }]) {
    assert.equal(proveProjection({ ...result, fields: [{ ...fields[0], ...wrong }, ...fields.slice(1)] }, projection, metadata), null);
  }
  assert.equal(proveProjection({ columns: ['owner'], fields: fields.slice(2) },
    parseProjection('SELECT owner FROM child c', 'db'), metadata), null);
});

test('source identity includes the physical vendor server and active account context', async () => {
  const connect = (version, role, uid) => async statement => {
    if (statement.startsWith('SELECT VERSION()')) return { rows: [[version, 'me@local', role, 'db', 'STRICT_TRANS_TABLES', 'SYSTEM']] };
    assert.equal(statement, version.includes('MariaDB') ? 'SELECT @@server_uid' : 'SELECT @@server_uuid');
    return { rows: [[uid]] };
  };
  assert.notEqual(await sourceServer(connect('11.4.8-MariaDB', null, 'same')), await sourceServer(connect('11.4.8-MariaDB', 'reader', 'same')));
  assert.notEqual(await sourceServer(connect('8.4.13', 'NONE', 'first')), await sourceServer(connect('8.4.13', 'NONE', 'other')));
});
