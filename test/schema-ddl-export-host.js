'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

async function runSchemaDdlExportChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const url = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  const verifySpring = async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springIsolation);
  };

  const suffix = randomBytes(6).toString('hex');
  const parent = 'rb_ddl_z_parent_' + suffix, child = 'rb_ddl_a_child_' + suffix;
  const relay = 'rb_ddl_z_view_' + suffix, outer = 'rb_ddl_a_view_' + suffix;
  const fk = 'rb_ddl_fk_' + suffix;
  const actor = await mysql.createConnection(config);
  const tools = api.schemaDdlExport, created = new Map();
  assert.ok(tools);
  const quote = name => '`' + name + '`';
  async function create(kind, name, sql) {
    await actor.query(sql);
    created.set(name, kind);
  }
  async function clearOwned() {
    for (const [name, kind] of [...created].reverse()) {
      await actor.query('DROP ' + (kind === 'view' ? 'VIEW ' : 'TABLE ') + quote(name));
      created.delete(name);
    }
  }
  try {
    await verifySpring();
    await create('table', parent, 'CREATE TABLE ' + quote(parent) + ' (id INT AUTO_INCREMENT PRIMARY KEY,note VARCHAR(64) DEFAULT \'AUTO_INCREMENT=503; literal\') ENGINE=InnoDB');
    await create('table', child, 'CREATE TABLE ' + quote(child) + ' (id INT PRIMARY KEY,parent_id INT NOT NULL,KEY child_parent(parent_id),' +
      'CONSTRAINT ' + quote(fk) + ' FOREIGN KEY (parent_id) REFERENCES ' + quote(parent) + ' (id) ON DELETE CASCADE) ENGINE=InnoDB');
    await create('view', relay, 'CREATE VIEW ' + quote(relay) + ' AS SELECT id,parent_id FROM ' + quote(child));
    await create('view', outer, 'CREATE VIEW ' + quote(outer) + ' AS SELECT id FROM ' + quote(relay));
    await api.connectMysql(config);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.schema.exportDdl'));
    const tables = [outer, child, parent, relay], expected = [['table', parent], ['table', child], ['foreignKey', fk], ['view', relay], ['view', outer]];
    const exportReview = await tools.prepare({ tables });
    assert.deepEqual(exportReview.omitted, []);
    assert.deepEqual(exportReview.statements.map(item => [item.kind, item.name]), expected);
    assert.equal(exportReview.sql.includes(config.password), false);
    assert.equal(exportReview.rowDataIncluded, false);
    assert.equal(exportReview.executedSql, false);
    const readColumns = async () => (await actor.execute(
      'SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ' +
      'EXTRA, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?, ?) ORDER BY TABLE_NAME, ORDINAL_POSITION',
      [config.database, ...tables]
    ))[0];
    const columnsBefore = await readColumns();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-ddl-export:/' + exportReview.id + '/schema.sql'));
    assert.equal(document.getText(), exportReview.sql);
    const output = path.resolve(__dirname, '../test-output');
    fs.mkdirSync(output, { recursive: true });
    const available = fs.mkdtempSync(path.join(output, 'schema-ddl-export-'));
    const file = path.join(available, 'schema.sql');
    await actor.query('INSERT INTO ' + quote(parent) + ' (note) VALUES (?)', ['owned row']);
    const saved = await tools.saveReview(exportReview.id, vscode.Uri.file(file));
    assert.equal(saved.fingerprint, exportReview.fingerprint);
    assert.equal(fs.readFileSync(file, 'utf8'), exportReview.sql);
    const again = await tools.prepare({ tables: [...tables].reverse() });
    assert.equal(again.sql, exportReview.sql);
    assert.match(exportReview.sql, /AUTO_INCREMENT=503; literal/);
    assert.doesNotMatch(exportReview.sql, /ENGINE=InnoDB AUTO_INCREMENT\s*=/);
    await actor.query('ALTER TABLE ' + quote(child) + ' ADD COLUMN native_stale_guard INT NULL');
    const stale = path.join(available, 'stale.sql');
    await assert.rejects(tools.saveReview(again.id, vscode.Uri.file(stale)), /changed after review/);
    assert.equal(fs.existsSync(stale), false);
    await actor.query('ALTER TABLE ' + quote(child) + ' DROP COLUMN native_stale_guard');
    const partial = await tools.prepare({ tables: [child, outer] });
    assert.deepEqual(partial.omitted.map(item => item.name).sort(), [child, outer].sort());
    assert.equal(partial.statements.length, 0);

    // The test alone restores its exact four owned fixture objects. The extension only wrote the file.
    await clearOwned();
    for (const [index, entry] of exportReview.statements.entries()) {
      assert.deepEqual([entry.kind, entry.name], expected[index]);
      if (entry.kind === 'foreignKey') await actor.query(entry.sql);
      else await create(entry.kind, entry.name, entry.sql);
    }
    const replayed = await tools.prepare({ tables });
    assert.deepEqual(await readColumns(), columnsBefore);
    // MySQL can make the already-effective character set explicit in
    // SHOW CREATE when it replays a column with a COLLATE clause.
    const comparable = entry => entry.name === parent
      ? { ...entry, sql: entry.sql.replace(/(`note` varchar\(64\)) CHARACTER SET utf8mb4(?= COLLATE utf8mb4_unicode_ci\b)/i, '$1') }
      : entry;
    assert.deepEqual(replayed.statements.map(comparable), exportReview.statements.map(comparable));
    assert.equal(Number((await actor.query('SELECT COUNT(*) AS n FROM ' + quote(parent)))[0][0].n), 0);
    await assert.rejects(actor.query('INSERT INTO ' + quote(child) + ' VALUES (1,999)'), { code: 'ER_NO_REFERENCED_ROW_2' });
    assert.deepEqual((await actor.query('SELECT * FROM ' + quote(outer)))[0], []);
    await verifySpring();
    checks.push('Native DDL export read and previewed actual ordered InnoDB, FK and two dependent view definitions. The file bytes remained identical across a counter change and reordered scope request.');
    checks.push('An intervening schema edit refused the save before any output write. A selection missing prerequisite definitions reported both omissions without executable statements.');
    checks.push('A direct test-only round-trip of the five exported definitions retained column metadata and FK enforcement with zero copied rows. The Spring JDBC fixture remained unchanged.');
    return { statementKinds: expected.map(([kind]) => kind), replaySchemaEquivalent: true, counterElided: true,
      deterministicFileBytes: true, staleSaveRefused: true, omittedMissingDependencies: 2, rowDataIncluded: false,
      serverForeignKeyEnforced: true, springIsolation };
  } finally {
    try { await api.disconnectMysql(); }
    finally { try { await clearOwned(); } finally { await actor.end(); } }
  }
}

module.exports = { runSchemaDdlExportChecks };
