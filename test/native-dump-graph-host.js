'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function verifyNativeDumpGraph(api, { configPath, tools, dialect, withAdmin }) {
  const folder = path.dirname(configPath);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  const cross = JSON.parse(await fs.readFile(path.join(folder, 'cross-schema.json'), 'utf8'));
  assert.equal(owner.id, cross.fixtureId);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  const source = config.database, target = 'rocketbrain_related';
  const suffix = randomBytes(5).toString('hex');
  const table = 'rb_graph_orders_' + suffix, audit = 'rb_graph_audit_' + suffix;
  const leaf = 'rb_graph_leaf_' + suffix, view = 'rb_graph_view_' + suffix;
  const procedure = 'rb_graph_log_' + suffix, fn = 'rb_graph_score_' + suffix;
  const first = 'rb_graph_add_' + suffix, second = 'rb_graph_multiply_' + suffix, invoke = 'rb_graph_trigger_' + suffix;
  const crossing = 'rb_graph_crossing_' + suffix, outside = 'rb_graph_outside_' + suffix, foreignUser = 'rb_graph_foreign_' + suffix;
  const file = path.join(folder, 'rb-graph-' + suffix + '.sql'), badFile = path.join(folder, 'rb-invalid-' + suffix + '.sql');
  const actor = await mysql.createConnection(config);
  let ownsTarget = false;
  try {
    const [existing] = await actor.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [target]);
    assert.deepEqual(existing, []);
    ownsTarget = true;
    await actor.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, amount INT NOT NULL) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${audit} (id INT PRIMARY KEY, amount INT NOT NULL, FOREIGN KEY (id) REFERENCES ${table}(id)) ENGINE=InnoDB`);
    await actor.query(`CREATE SQL SECURITY INVOKER VIEW ${leaf} AS SELECT id, amount FROM ${source}.${table}`);
    await actor.query(`CREATE SQL SECURITY INVOKER VIEW ${view} AS SELECT id, amount FROM ${source}.${leaf}`);
    await actor.query(`CREATE PROCEDURE ${procedure}(IN entry_id INT, IN price INT) SQL SECURITY INVOKER MODIFIES SQL DATA BEGIN INSERT INTO ${audit}(id, amount) VALUES (entry_id, price); END`);
    await actor.query(`CREATE FUNCTION ${fn}(metric INT) RETURNS INT DETERMINISTIC NO SQL SQL SECURITY INVOKER RETURN metric * 2`);
    await actor.query(`CREATE TRIGGER ${first} BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.amount = NEW.amount + 1`);
    await actor.query(`CREATE TRIGGER ${second} BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.amount = NEW.amount * 2`);
    await actor.query(`CREATE TRIGGER ${invoke} AFTER INSERT ON ${table} FOR EACH ROW BEGIN CALL ${procedure}(NEW.id, NEW.amount); END`);
    await actor.query(`INSERT INTO ${table} VALUES (1, 3)`);

    await api.connectMysql(config);
    const dumps = api.nativeDumps, list = await dumps.listTables();
    assert.equal(list.dialect, dialect);
    const objects = [{ kind: 'view', name: view }, { kind: 'view', name: leaf }, { kind: 'procedure', name: procedure },
      { kind: 'function', name: fn }, ...[second, invoke, first].map(name => ({ kind: 'trigger', name }))];
    const request = { tools, file, tables: [table, audit], objects, connectionEpoch: list.connectionEpoch };
    await assert.rejects(dumps.dump({ ...request, file: badFile, objects: [objects[0]] }), /Include every referenced/);
    await assert.rejects(dumps.dump({ ...request, file: badFile, objects: [{ kind: 'trigger', name: first }] }), /Include all triggers/);

    await actor.query(`CREATE TABLE ${target}.${outside} (id INT PRIMARY KEY) ENGINE=InnoDB`);
    await actor.query(`CREATE VIEW ${crossing} AS SELECT id FROM ${target}.${outside}`);
    await assert.rejects(dumps.dump({ ...request, file: badFile, objects: [{ kind: 'view', name: crossing }] }), /Cross-schema/);
    await actor.query(`DROP VIEW ${crossing}`);
    await actor.query(`DROP TABLE ${target}.${outside}`);
    if (withAdmin) {
      await adminCreate();
      await assert.rejects(dumps.dump({ ...request, file: badFile, objects: [{ kind: 'view', name: foreignUser }] }), /current effective account/);
      await withAdmin(admin => admin.query(`DROP VIEW ${source}.${foreignUser}`));
    }

    const dumped = await dumps.dump(request);
    assert.equal(dumped.graph.objects.length, objects.length);
    const sql = await fs.readFile(file, 'utf8');
    assert.match(sql, /DEFINER=CURRENT_USER SQL SECURITY INVOKER VIEW/);
    assert.doesNotMatch(sql, /\bDROP (?:TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER)\b/i);
    assert.ok(!sql.includes(source + '.') && !sql.includes('`' + source + '`.'));
    await api.disconnectMysql();
    await api.connectMysql({ ...config, database: target });
    const originalCollation = dumped.graph.defaults.collation;
    const alternateCollation = originalCollation === 'utf8mb4_unicode_ci' ? 'utf8mb4_general_ci' : 'utf8mb4_unicode_ci';
    await actor.query(`ALTER DATABASE ${target} COLLATE ${alternateCollation}`);
    try { await assert.rejects(dumps.previewRestore({ tools, file }), /default collation differs/); }
    finally { await actor.query(`ALTER DATABASE ${target} COLLATE ${originalCollation}`); }
    const review = await dumps.previewRestore({ tools, file });
    assert.deepEqual(review.objects, dumped.graph.objects);
    const restored = await dumps.restore({ reviewId: review.reviewId, destinationDatabase: target, allowWrite: true });
    assert.equal(restored.graphVerified, true);
    assert.equal(restored.sha256, dumped.sha256);
    const query = `SELECT CAST(amount AS CHAR) AS amount FROM ${target}.${view} ORDER BY id`;
    const [initial] = await actor.query(query);
    assert.deepEqual(initial, [{ amount: '8' }]);
    await actor.query(`INSERT INTO ${target}.${table} VALUES (2, 3)`);
    assert.deepEqual((await actor.query(query))[0], [{ amount: '8' }, { amount: '8' }]);
    assert.deepEqual((await actor.query(`SELECT CAST(amount AS CHAR) AS amount FROM ${target}.${audit} ORDER BY id`))[0],
      [{ amount: '8' }, { amount: '8' }]);
    assert.deepEqual((await actor.query(`SELECT ${target}.${fn}(11) AS score`))[0], [{ score: 22 }]);
    return { dialect, verifiedObjects: restored.objects.length, viewsUsed: true, routineFunctionUsed: true,
      triggerOrderAndProcedureCall: true, crossSchemaRefused: true, foreignDefinerRefused: Boolean(withAdmin), mismatchedCollationRefused: true };

    async function adminCreate() {
      return withAdmin(admin => admin.query(`CREATE SQL SECURITY DEFINER VIEW ${source}.${foreignUser} AS SELECT id FROM ${source}.${table}`));
    }
  } finally {
    await api.disconnectMysql();
    try {
      for (const database of ownsTarget ? [target, source] : [source]) {
        for (const name of [crossing, view, leaf]) await actor.query(`DROP VIEW IF EXISTS ${database}.${name}`);
        for (const name of [first, second, invoke]) await actor.query(`DROP TRIGGER IF EXISTS ${database}.${name}`);
        await actor.query(`DROP PROCEDURE IF EXISTS ${database}.${procedure}`);
        await actor.query(`DROP FUNCTION IF EXISTS ${database}.${fn}`);
        for (const name of [audit, table, outside]) await actor.query(`DROP TABLE IF EXISTS ${database}.${name}`);
      }
      if (withAdmin) await withAdmin(admin => admin.query(`DROP VIEW IF EXISTS ${source}.${foreignUser}`));
    } finally {
      await actor.end();
      for (const item of [file, badFile]) await fs.unlink(item).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    }
  }
}

async function runNativeDumpGraphChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const dialect = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  const bundle = dialect === 'mysql' ? await require('../scripts/integration-mysql-runtime').ensureMysqlRuntime() :
    await require('../scripts/integration-db-runtime').ensureMariaDbRuntime();
  const proof = await verifyNativeDumpGraph(api, { dialect, tools: path.dirname(bundle.server), configPath: runtime.dbConfigPath });
  checks.push('native schema-object dump, dependency-ordered restore, live view, function, procedure and trigger behavior');
  return proof;
}

module.exports = { verifyNativeDumpGraph, runNativeDumpGraphChecks };
