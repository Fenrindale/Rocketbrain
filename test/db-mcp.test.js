'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { approveDatabaseScope, databaseTools, validateScope, directReadOnly } = require('../src/mcp/database-tools');
const { workspaceTools } = require('../src/mcp/workspace-tools');

const approval = { version: 1, host: '127.0.0.1', port: 3306, schema: 'journal', username: 'reader',
  tables: [{ name: 'events', columns: ['id', 'message'] }] };
const scope = () => validateScope(approval, 'fixture-only');

test('database approval binds one numeric loopback route and exact named table/column scope', () => {
  for (const invalid of [{ host: 'localhost' }, { host: '192.0.2.20' }, { port: 0 }, { schema: 'MYSQL' },
    { schema: 'other.table' }, { tables: [{ name: 'events', columns: ['id', 'ID'] }] }, { username: 'reader%20a' },
    { tables: [{ name: 'events', columns: [] }] }, { password: 'read' }]) {
    assert.throws(() => validateScope({ ...approval, ...invalid }, 'fixture-only'));
  }
  assert.throws(() => validateScope(approval, ''), /password/);
  assert.equal(scope().tables.get('events')[1], 'message');
});

test('reads bounded ordinary approval JSON and rejects extra credential fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-mcp-scope-'));
  const file = path.join(dir, 'approve.json');
  try {
    await fs.writeFile(file, JSON.stringify(approval));
    assert.deepEqual((await approveDatabaseScope(file, 'fixture-only')).tables.get('events'), ['id', 'message']);
    await fs.writeFile(file, JSON.stringify({ ...approval, password: 'fixture-only' }));
    await assert.rejects(() => approveDatabaseScope(file, 'fixture-only'));
    await fs.writeFile(file, 'a'.repeat(32 * 1024 + 1));
    await assert.rejects(() => approveDatabaseScope(file, 'fixture-only'), /32 KiB/);
    await assert.rejects(() => approveDatabaseScope('./relative.json', 'fixture-only'), /absolute local/);
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});

test('direct grant audit excludes writable grants, role inheritance and grant-option delegation', () => {
  const usage = "GRANT USAGE ON *.* TO 'reader'@'127.0.0.1'";
  const read = "GRANT SELECT (`id`, `message`) ON `journal`.`events` TO 'reader'@'127.0.0.1'";
  assert.equal(directReadOnly([usage, read]), true);
  assert.equal(directReadOnly([usage + " IDENTIFIED BY PASSWORD '*HASH'", read]), true);
  for (const invalid of [[usage], [read + ' WITH GRANT OPTION'], [read, "GRANT `superrole` TO 'reader'@'127.0.0.1'"],
    [read.replace('SELECT (`id`, `message`)', 'SELECT, INSERT')], [read, "GRANT EXECUTE ON *.* TO 'reader'@'127.0.0.1'"]]) {
    assert.equal(directReadOnly(invalid), false);
  }
});

test('DB MCP tools require explicit allowlisting and reject widening or raw SQL at argument validation', () => {
  const tools = databaseTools(scope());
  const registry = workspaceTools('.', ['db_sample'], tools);
  assert.equal(registry.authorized('db_catalog'), false);
  assert.throws(() => workspaceTools('.', ['db_sample']), /recognized tools/);
  assert.deepEqual(registry.tools.map(tool => tool.name), ['db_sample']);
  const baseline = { table: 'events', columns: ['id'] };
  const validated = registry.validate('db_sample', { ...baseline, equals: [{ column: 'id', kind: 'integer', value: '9007199254740993' }] });
  assert.deepEqual(validated.filters, [{ column: 'id', kind: 'integer', bound: '9007199254740993' }]);
  for (const extra of [{ sql: 'SELECT 1' }, { table: 'Events' }, { columns: ['id', 'HIDDEN'] }, { limit: 51 },
    { equals: [{ column: 'id', kind: 'json', value: '{}' }] }, { equals: [{ column: 'id', kind: 'integer', value: 7 }] },
    { order: [{ column: 'id', direction: 'asc;delete' }] }, { order: [{ column: 'ID', direction: 'asc' }] }]) {
    assert.throws(() => registry.validate('db_sample', { ...baseline, ...extra }));
  }
});
