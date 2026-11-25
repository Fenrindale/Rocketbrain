'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

async function withFixture(run) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const marker = JSON.parse(await fs.readFile(path.join(owner, 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(path.basename(owner), marker.id);
  const cross = JSON.parse(await fs.readFile(path.join(owner, 'cross-schema.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(cross.fixtureId, marker.id);
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  const [local, remote] = cross.schemas;
  const suffix = randomBytes(5).toString('hex');
  const table = 'rb_scope_' + suffix, logical = 'rb_logical_' + suffix;
  const fk = 'rb_fk_' + suffix;
  const definition = { id: suffix, name: 'Saved logical reference', child: logical, parent: table,
    pairs: [{ child: 'reference_id', parent: 'id' }, { child: 'token', parent: 'token' }] };
  const value = '9007199254740993', lower = '9007199254740992';
  const raw = Buffer.from([0, 255, 65]);
  const actor = await mysql.createConnection(config);
  try {
    const [[server]] = await actor.query('SELECT @@datadir datadir');
    assert.equal(path.dirname(await fs.realpath(server.datadir)).toLowerCase(), owner.toLowerCase());
    await actor.query('CREATE TABLE ??.?? (tenant BIGINT UNSIGNED, token VARBINARY(8), label VARCHAR(32), PRIMARY KEY(tenant,token)) ENGINE=InnoDB',
      [remote, table]);
    await actor.query('CREATE TABLE ??.?? (id BIGINT UNSIGNED PRIMARY KEY, tenant BIGINT UNSIGNED, token VARBINARY(8), ' +
      'CONSTRAINT ?? FOREIGN KEY (tenant,token) REFERENCES ??.??(tenant,token)) ENGINE=InnoDB', [local, table, fk, remote, table]);
    await actor.query('CREATE TABLE ??.?? (id INT PRIMARY KEY, reference_id BIGINT UNSIGNED, token VARBINARY(8)) ENGINE=InnoDB', [local, logical]);
    await actor.query('INSERT INTO ??.?? VALUES ?', [remote, table, [[lower, raw, 'lower'], [value, raw, 'chosen'], [value, Buffer.from([0, 0]), 'other bytes']]]);
    await actor.query('INSERT INTO ??.?? VALUES ?', [local, table, [[1, lower, raw], [2, value, raw], [3, null, raw], [4, value, Buffer.from([0, 0])]]]);
    await actor.query('INSERT INTO ??.?? VALUES ?', [local, logical, [[10, 2, raw], [11, 2, Buffer.from([0])], [12, null, raw]]]);
    await run({ actor, config, local, remote, table, logical, definition, value });
    assert.deepEqual(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
    return { engine: runtime.dbEngine, crossSchemaBothDirections: true, sameTableName: true, binaryComposite: true, exactBigInt: true,
      logicalBothDirections: true, nullableKeySkipped: true, jdbc: await jdbcReadback() };
  } finally {
    try {
      await actor.query('DROP TABLE IF EXISTS ??.??', [local, logical]);
      await actor.query('DROP TABLE IF EXISTS ??.??', [local, table]);
      await actor.query('DROP TABLE IF EXISTS ??.??', [remote, table]);
    } finally { await actor.end(); }
  }
}

async function verifyChain({ local, remote, table, logical, value }, tools) {
  const one = async (source, index, schema, name, direction, kind) => {
    const match = (await tools.choices(source, index)).find(edge => edge.schema === schema && edge.table === name &&
      edge.direction === direction && edge.kind === kind);
    assert.ok(match, `Missing ${kind} ${direction} relation to ${schema}.${name}`);
    const target = await tools.follow(source, index, match);
    assert.equal(target.result.edit.schema, schema);
    assert.equal(target.result.edit.canEdit, false);
    assert.equal(target.result.state.readOnly, true);
    return target;
  };
  const child = await tools.open(table);
  const parent = await one(child, 1, remote, table, 'referenced', 'physical');
  assert.deepEqual(parent.result.rows.map(row => row.map(String)), [[value, '0x00ff41', 'chosen']]);
  assert.match(parent.result.browse.sql, /FROM `rocketbrain_related`\.`rb_scope_[0-9a-f]+` WHERE `tenant` = CAST\(\? AS UNSIGNED\) AND `token` = \?/);
  const reverse = await one(parent, 0, local, table, 'referencing', 'physical');
  assert.deepEqual(reverse.result.rows.map(row => row.map(String)), [['2', value, '0x00ff41']]);
  assert.equal((await tools.choices(child, 2)).some(edge => edge.kind === 'physical'), false);
  const annotation = await tools.open(logical);
  const linked = await one(annotation, 0, local, table, 'referenced', 'logical');
  assert.deepEqual(linked.result.rows.map(row => String(row[0])), ['2']);
  const logicalReverse = await one(linked, 0, local, logical, 'referencing', 'logical');
  assert.deepEqual(logicalReverse.result.rows.map(row => String(row[0])), ['10']);
  if (tools.back) {
    assert.deepEqual(await tools.back(parent), { resultId: child.id, rowId: child.result.edit.rowIds[1] });
    assert.deepEqual(await tools.back(logicalReverse), { resultId: linked.id, rowId: linked.result.edit.rowIds[0] });
  }
  return child;
}

async function runRelatedScopedChecks(api, vscode, checks) {
  const result = await withFixture(async fixture => {
    const { config, table, logical, definition } = fixture;
    const profiles = api.dbConnections, diagrams = api.schemaDiagrams;
    const profile = await profiles.save({ profile: { name: 'Related rows fixture ' + definition.id,
      host: config.host, port: config.port, user: config.user, database: config.database, tls: { mode: 'disabled' }, ssh: null },
      password: config.password, rememberPassword: false });
    let annotation;
    try {
      await profiles.connect({ id: profile.id, password: config.password });
      const opened = await diagrams.openDiagram({ focus: logical });
      const updated = await diagrams.addRelation(opened.token, { name: definition.name, child: logical, parent: table, pairs: definition.pairs });
      annotation = updated.diagram.edges.find(edge => edge.kind === 'logical' && edge.child === logical);
      assert.ok(annotation);
      const selection = (record, index) => ({ modelId: record.result.edit.modelId, rowId: record.result.edit.rowIds[index] });
      const tools = {
        open: async name => {
          await vscode.commands.executeCommand('rocketbrain.openTable', name);
          const record = api.results().at(-1);
          assert.equal(record.result.edit.table, name);
          return record;
        },
        choices: (record, index) => api.inspectRelatedRows(record.id, selection(record, index)),
        follow: async (record, index, match) => {
          const id = await api.openRelatedRows(record.id, selection(record, index), match.key);
          const next = api.results().find(item => item.id === id);
          assert.equal(next.state, 'done', next.error);
          assert.notEqual(next.sessionId, record.sessionId);
          return next;
        },
        back: record => api.returnToRelatedSource(record.id)
      };
      await verifyChain(fixture, tools);
      const source = await tools.open(logical);
      const [selected] = await tools.choices(source, 0);
      const fresh = await diagrams.openDiagram({ focus: logical });
      await diagrams.removeRelation(fresh.token, annotation.id);
      annotation = undefined;
      await assert.rejects(tools.follow(source, 0, selected), /foreign key or visible row changed/);
    } finally {
      if (annotation) {
        const fresh = await diagrams.openDiagram({ focus: logical });
        await diagrams.removeRelation(fresh.token, annotation.id);
      }
      await api.disconnectMysql();
      await profiles.remove({ id: profile.id, expectedRevision: profile.revision });
    }
  });
  checks.push('Native related-row navigation resolves cross-schema names, uses exact binary composite keys and returns to the retained source row.');
  return { ...result, nativeBackToSource: true, staleAnnotationRejected: true };
}

async function verifyBackend() {
  const { MysqlService } = require('../src/db/mysql');
  const { relatedRowsFromObservation: relatedRows } = require('../src/db/related-rows');
  const { logicalEdges } = require('../src/db/schema-erd');
  const result = await withFixture(async fixture => {
    const { config, local, definition } = fixture;
    const db = new MysqlService(config);
    let sequence = 0;
    const session = async () => {
      const id = `related-fixture-${++sequence}`;
      await db.openSession(id, { readOnly: true });
      return id;
    };
    try {
      const tools = {
        open: async table => ({ table, schema: local, result: await db.previewTable(table, { sessionId: await session() }) }),
        choices: async (record, index) => {
          const logical = record.schema === local ? logicalEdges(await db.metadata(), [definition]) : [];
          const catalog = await db.relatedRowsCatalog({ schema: record.schema, table: record.table, logical });
          return relatedRows(catalog, record.result.columns, record.result.rows[index], record.result.edit.columns);
        },
        follow: async (_record, _index, match) => ({ table: match.table, schema: match.schema,
          result: await db.previewRelatedTable(match, { sessionId: await session(), filters: match.filters }) })
      };
      const source = await verifyChain(fixture, tools);
      const edge = (await tools.choices(source, 1)).find(item => item.kind === 'physical');
      const readSession = await session();
      await assert.rejects(db.previewRelatedTable({ ...edge, keys: [{ ...edge.keys[0], type: 'varchar(15)' }] },
        { sessionId: readSession, filters: edge.filters }), /key columns changed/);
      await db.openSession('related-writable-fixture', { readOnly: false });
      await assert.rejects(db.previewRelatedTable(edge, { sessionId: 'related-writable-fixture', filters: edge.filters }), /read-only console/);
    } finally { await db.dispose(); }
  });
  return { ...result, changedMetadataRejected: true, writableSessionRejected: true };
}

if (require.main === module) verifyBackend().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { runRelatedScopedChecks, withScopedRelationshipFixture: withFixture };
