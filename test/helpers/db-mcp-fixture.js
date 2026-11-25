'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function prepareDbMcpFixture(fixture) {
  const { config, withAdmin } = fixture.db;
  const root = path.dirname(fixture.configPath);
  const marker = JSON.parse(await fs.readFile(path.join(root, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, 'RocketbrainSpringProjectFixture-v1');
  assert.equal(marker.id, path.basename(root));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');

  const id = randomBytes(5).toString('hex');
  const table = 'rb_mcp_sample_' + id;
  const view = 'rb_mcp_view_' + id;
  const reader = 'rb_mcp_read_' + id;
  const readerPassword = randomBytes(32).toString('base64url');
  const writer = 'rb_mcp_write_' + id;
  const writerPassword = randomBytes(32).toString('base64url');
  const firstId = '9007199254740992', secondId = '9007199254740993';
  const exactDecimal = '100000000000000000000000.2500';
  const columns = ['id', 'price', 'date_value', 'raw_value', 'json_value', 'note'];
  const scope = { version: 1, host: config.host, port: config.port, schema: config.database, username: reader,
    tables: [{ name: 'rb_spring_person', columns: ['id', 'display_name'] }, { name: table, columns }] };
  await withAdmin(async db => {
    await db.query('CREATE TABLE ??.?? (id BIGINT UNSIGNED PRIMARY KEY, price DECIMAL(38,4), date_value DATETIME(6), ' +
      'raw_value VARBINARY(16), json_value JSON, note LONGTEXT, hidden VARCHAR(32)) ENGINE=InnoDB', [config.database, table]);
    await db.query('CREATE VIEW ??.?? AS SELECT id FROM ??.??', [config.database, view, config.database, table]);
    const rows = [
      [firstId, '100000000000000000000000.2400', '2026-01-02 03:04:05.123456', Buffer.from([1]), '{"role":"first"}', null, 'outside-approved-sample'],
      [secondId, exactDecimal, '2026-01-02 03:04:05.123456', Buffer.from([0, 64, 255]), '{"role":"second"}', '한글'.repeat(800), 'outside-approved-sample'],
      ...Array.from({ length: 60 }, (_, index) => [(9007199254740994n + BigInt(index)).toString(), '0.1000', null, null, null, '\0'.repeat(1000), 'outside-approved-sample'])
    ];
    await db.query('INSERT INTO ??.?? (id,price,date_value,raw_value,json_value,note,hidden) VALUES ?', [config.database, table, rows]);
    await db.query('CREATE USER ?@? IDENTIFIED BY ?', [reader, config.host, readerPassword]);
    await db.query('CREATE USER ?@? IDENTIFIED BY ?', [writer, config.host, writerPassword]);
    await db.query('GRANT SELECT (id, display_name) ON ??.rb_spring_person TO ?@?', [config.database, reader, config.host]);
    await db.query('GRANT SELECT (id, price, date_value, raw_value, json_value, note) ON ??.?? TO ?@?', [config.database, table, reader, config.host]);
    await db.query('GRANT SELECT (id) ON ??.?? TO ?@?', [config.database, view, reader, config.host]);
    await db.query('GRANT SELECT, INSERT ON ??.?? TO ?@?', [config.database, table, writer, config.host]);
  });
  const dbScope = path.join(root, 'db-mcp-scope.json');
  const writerScope = path.join(root, 'db-mcp-writer-scope.json');
  const viewScope = path.join(root, 'db-mcp-view-scope.json');
  await fs.writeFile(dbScope, JSON.stringify(scope), { flag: 'wx' });
  await fs.writeFile(writerScope, JSON.stringify({ ...scope, username: writer, tables: [{ name: table, columns }] }), { flag: 'wx' });
  await fs.writeFile(viewScope, JSON.stringify({ ...scope, tables: [{ name: view, columns: ['id'] }] }), { flag: 'wx' });

  return { ROCKETBRAIN_DB_MCP_TEST_SCOPE: dbScope, ROCKETBRAIN_DB_MCP_TEST_PASSWORD: readerPassword,
    ROCKETBRAIN_DB_MCP_TEST_WRITER_SCOPE: writerScope, ROCKETBRAIN_DB_MCP_TEST_WRITER_PASSWORD: writerPassword,
    ROCKETBRAIN_DB_MCP_TEST_VIEW_SCOPE: viewScope };
}

module.exports = { prepareDbMcpFixture };
