'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const { openMcp } = require('./helpers/ide-mcp-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function verifyDbMcp(cli, workspace) {
  const dbScope = process.env.ROCKETBRAIN_DB_MCP_TEST_SCOPE;
  const password = process.env.ROCKETBRAIN_DB_MCP_TEST_PASSWORD;
  const expectedDialect = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(dbScope && password && ['mysql', 'mariadb'].includes(expectedDialect));
  const scope = JSON.parse(await fs.readFile(dbScope, 'utf8'));
  const { name: table, columns } = scope.tables[1];
  const open = options => openMcp('node', cli, workspace, ['db_catalog', 'db_sample'], { dbScope, password, ...options });
  const call = (client, name, args) => client.request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
  const unwrap = reply => {
    assert.equal(reply.result?.isError, false, JSON.stringify(reply.error ?? reply.result?.content));
    return reply.result.structuredContent;
  };
  const client = open();
  try {
    await client.initialize();
    const response = await client.request('tools/list');
    assert.deepEqual(response.result.tools.map(tool => tool.name), ['db_catalog', 'db_sample']);
    assert.ok(response.result.tools.every(tool => tool.annotations.readOnlyHint));
    const catalog = unwrap(await call(client, 'db_catalog'));
    assert.equal(catalog.dialect, expectedDialect);
    assert.equal(catalog.schema, scope.schema);
    assert.deepEqual(catalog.tables.map(item => item.name), ['rb_spring_person', table]);
    assert.deepEqual(catalog.tables[0].columns.map(item => item.name), ['id', 'display_name']);
    assert.deepEqual(catalog.tables[1].columns.map(item => item.name), columns);
    const people = unwrap(await call(client, 'db_sample', { table: 'rb_spring_person', columns: ['id', 'display_name'],
      limit: 10, order: [{ column: 'id', direction: 'asc' }] }));
    assert.equal(people.rows.length, 2);
    assert(people.rows.every(row => row[0].kind === 'integer' && row[1].kind === 'text'));

    const exact = unwrap(await call(client, 'db_sample', { table, columns,
      equals: [{ column: 'id', kind: 'integer', value: '9007199254740993' },
        { column: 'price', kind: 'decimal', value: '100000000000000000000000.2500' }] }));
    assert.equal(exact.rows.length, 1);
    assert.equal(exact.clippedCells, 1);
    assert.deepEqual(exact.rows, [[{ kind: 'integer', value: '9007199254740993' }, { kind: 'decimal', value: '100000000000000000000000.2500' },
      { kind: 'temporal', value: '2026-01-02 03:04:05.123456' }, { kind: 'binary', value: 'AED/', encoding: 'base64' },
      { kind: expectedDialect === 'mysql' ? 'json' : 'text', value: exact.rows[0][4].value }, { kind: 'truncated' }]]);
    assert.deepEqual(JSON.parse(exact.rows[0][4].value), { role: 'second' });
    for (const filter of [{ column: 'id', kind: 'integer', value: '9007199254740993' },
      { column: 'price', kind: 'decimal', value: '100000000000000000000000.2500' }]) {
      const single = unwrap(await call(client, 'db_sample', { table, columns: ['id'], equals: [filter] }));
      assert.deepEqual(single.rows, [[{ kind: 'integer', value: '9007199254740993' }]]);
    }
    const nullFiltered = unwrap(await call(client, 'db_sample', { table, columns: ['id', 'note'], equals: [{ column: 'note', kind: 'null' }] }));
    assert.deepEqual(nullFiltered.rows, [[{ kind: 'integer', value: '9007199254740992' }, { kind: 'null', value: null }]]);
    const limited = unwrap(await call(client, 'db_sample', { table, columns: ['id'], limit: 1,
      order: [{ column: 'id', direction: 'asc' }] }));
    assert.equal(limited.rows.length, 1);
    assert.equal(limited.truncated, true);
    assert.equal(limited.rows[0][0].value, '9007199254740992');
    const budget = unwrap(await call(client, 'db_sample', { table, columns: ['id', 'note'], limit: 50, order: [{ column: 'id', direction: 'desc' }] }));
    assert.equal(budget.truncated, true);
    assert.ok(budget.rows.length >= 10 && budget.rows.length < 25);
    assert.equal(budget.untrustedData, true);
    for (const [name, args] of [['db_catalog', { table: 'rb_spring_department' }], ['db_sample', { table, columns: ['hidden'] }],
      ['db_sample', { table, columns: ['id'], sql: 'SELECT 1' }], ['db_sample', { table, columns: ['id'], schema: 'other' }],
      ['db_sample', { table, columns: ['id'], order: [{ column: 'hidden', direction: 'asc' }] }]]) {
      assert.equal((await call(client, name, args)).error.code, -32602);
    }
    const wrongKind = await call(client, 'db_sample', { table, columns: ['id'], equals: [{ column: 'id', kind: 'text', value: 'not an integer' }] });
    assert.equal(wrongKind.result.isError, true);
    assert.ok(client.received.map(frame => JSON.stringify(frame)).every(frame =>
      !frame.includes(password) && !frame.includes(scope.username) && !frame.includes('outside-approved-sample')));
  } finally { assert.deepEqual(await client.close(), { code: 0, stderr: '', malformed: null }); }

  async function refused(options, target) {
    assert.ok(options.dbScope);
    const candidate = open(options);
    try {
      const reply = await candidate.modern('tools/call', { name: 'db_catalog', arguments: target ? { table: target } : {} });
      assert.equal(reply.result.isError, true);
      assert.ok(!JSON.stringify(reply).includes(options.password ?? password));
    } finally { assert.deepEqual(await candidate.close(), { code: 0, stderr: '', malformed: null }); }
  }
  const writerScope = process.env.ROCKETBRAIN_DB_MCP_TEST_WRITER_SCOPE;
  const writerPassword = process.env.ROCKETBRAIN_DB_MCP_TEST_WRITER_PASSWORD;
  assert.ok(writerPassword);
  await refused({ dbScope: writerScope, password: writerPassword });
  await refused({ dbScope: process.env.ROCKETBRAIN_DB_MCP_TEST_VIEW_SCOPE });
  await refused({ dbScope, password: password + '-invalid' });

  const reader = await mysql.createConnection({ host: scope.host, port: scope.port, user: scope.username, database: scope.schema, password });
  try {
    await assert.rejects(() => reader.query('UPDATE ?? SET ?? = ? WHERE ?? = ?', [table, 'note', 'outside', 'id', '9007199254740993']),
      error => error.code === 'ER_TABLEACCESS_DENIED_ERROR' || error.code === 'ER_COLUMNACCESS_DENIED_ERROR');
    await assert.rejects(() => reader.query('SELECT ?? FROM ?? LIMIT 1', ['hidden', table]), error => error.code === 'ER_COLUMNACCESS_DENIED_ERROR');
  } finally { await reader.end(); }

  return { dialect: expectedDialect, typedRows: true, exactWideIntegerFilter: true, exactDecimalFilter: true, rowAndByteLimits: true,
    authAndColumnGrants: true, targetScope: true, writableAccountRejected: true, viewRejected: true, jdbc: await jdbcReadback() };
}

async function runDbMcpChecks(_api, vscode, checks) {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  const [folder] = vscode.workspace.workspaceFolders;
  const result = await verifyDbMcp(path.join(extension.extensionPath, 'dist', 'ide-mcp-server.js'), folder.uri.fsPath);
  checks.push('The packaged MCP CLI read only approved, typed database values from the actual Spring fixture.');
  return { ...result, bundledStdio: true };
}

if (require.main === module) verifyDbMcp(path.resolve(__dirname, '../dist/ide-mcp-server.js'), path.resolve(__dirname, '..')).then(
  result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });

module.exports = { runDbMcpChecks, verifyDbMcp };
