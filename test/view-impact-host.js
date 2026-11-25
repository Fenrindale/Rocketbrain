'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { owned } = require('./schema-stored-diff-host');
const { observeViewImpact } = require('../src/db/view-impact');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = name => '`' + name.replaceAll('`', '``') + '`';
const location = ({ schema, name }) => quote(schema) + '.' + quote(name);
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };

async function showViewPermissionTest(runtime, config, table, view) {
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const file = await fs.realpath(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG);
  assert.equal(path.dirname(file), folder);
  const harness = await read(file);
  assert.equal(harness.format, 'RocketbrainOwnedDatabaseAdminFixture');
  assert.equal(harness.version, 1);
  assert.equal(harness.owner, path.basename(folder));
  assert.equal(harness.sourceConfigPath, runtime.dbConfigPath);
  assert.equal(harness.engine, runtime.dbEngine);
  for (const route of [harness.admin, harness.guest]) {
    assert.equal(route.host, config.host);
    assert.equal(route.port, config.port);
    assert.equal(route.database, config.database);
  }
  const grantor = await mysql.createConnection(harness.admin);
  try {
    const [[{ datadir }]] = await grantor.query('SELECT @@datadir datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(), folder.toLowerCase());
    for (const relation of [table, view]) {
      assert.equal(relation.schema, config.database);
      await grantor.query('GRANT SELECT ON ' + location(relation) + ' TO ?@?', [harness.guest.user, harness.guest.host]);
    }
  } finally {
    await grantor.end();
  }
  const guest = await mysql.createConnection(harness.guest);
  try {
    assert.deepEqual((await guest.query('SELECT id FROM ' + location(view)))[0].map(row => row.id), [11]);
    await assert.rejects(() => guest.query('SHOW CREATE VIEW ' + location(view)), error =>
      ['ER_TABLEACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_VIEW_NO_EXPLAIN'].includes(error.code));
  } finally {
    await guest.end();
  }
  return harness.guest;
}

async function verifyViewImpact(adapter) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const crossPath = await fs.realpath(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG);
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const cross = await read(crossPath);
  assert.equal(path.dirname(crossPath), folder);
  assert.equal(cross.fixtureId, path.basename(folder));
  const peer = 'rocketbrain_related';
  assert.deepEqual(cross.schemas, ['rocketbrain_fixture', peer]);
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const home = config.database;
  const prefix = 'rb_impact_' + randomBytes(5).toString('hex') + '_';
  const relation = (schema, name, kind = 'view') => ({ schema, name: prefix + name, kind });
  const target = relation(home, 'base', 'table'), sameName = relation(peer, 'base', 'table');
  const sibling = relation(home, 'sibling', 'table');
  const direct = relation(peer, 'direct'), transitive = relation(home, 'downstream'), noShow = relation(home, 'no_show');
  const shadow = relation(home, 'shadow'), opaque = relation(home, 'opaque');
  const spring = async () => {
    const url = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  try {
    await spring();
    for (const item of [target, sameName, sibling]) {
      await actor.query('CREATE TABLE ' + location(item) + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
      await actor.query('INSERT INTO ' + location(item) + ' VALUES (?)', [item === sameName ? 19 : 11]);
    }
    await actor.query('CREATE VIEW ' + location(direct) + ' AS SELECT id FROM ' + location(target));
    await actor.query('CREATE VIEW ' + location(transitive) + ' AS SELECT d.id FROM ' + location(direct) +
      ' d JOIN ' + location(sibling) + ' s ON s.id=d.id');
    await actor.query('CREATE VIEW ' + location(shadow) + ' AS SELECT id FROM ' + location(sameName));
    await actor.query('CREATE VIEW ' + location(opaque) + ' AS SELECT id FROM ' + location(target) + ' UNION SELECT 17');
    await actor.query('CREATE VIEW ' + location(noShow) + ' AS SELECT id FROM ' + location(target));
    const guest = await showViewPermissionTest(runtime, config, target, noShow);
    const published = {};
    let report;
    try {
      await adapter.connect(config);
      const request = { target, schemas: [home, peer] };
      report = await adapter.inspect(request);
      assert.equal(report.readOnly, true);
      assert.equal(report.coverage, 'account-visible selected application schemas');
      assert.match(report.fingerprint, /^[a-f0-9]{64}$/u);
      assert.deepEqual(report.target, target);
      assert.deepEqual(report.impacted.map(item => item.depth), [1, 1, 2]);
      for (const expected of [direct, noShow]) {
        assert.deepEqual(report.impacted.find(item => item.relation.name === expected.name)?.path, [target, expected]);
      }
      assert.deepEqual(report.impacted.find(item => item.relation.name === transitive.name)?.path, [target, direct, transitive]);
      assert.equal(report.edges.length, 3);
      assert.deepEqual(report.opaqueViews.find(item => item.relation.name === opaque.name),
        { relation: opaque, reason: 'unsupported-view-definition' });
      assert.ok(!JSON.stringify(report).includes('SELECT '));
      assert.ok(!JSON.stringify(report).includes(config.user));
      const viewReport = await adapter.inspect({ target: direct, schemas: [peer, home] });
      assert.deepEqual(viewReport.impacted.map(item => item.path), [[direct, transitive]]);
      const homeReport = await adapter.inspect({ target, schemas: [home] });
      assert.deepEqual(homeReport.impacted.map(item => item.relation), [noShow]);
      assert.ok(homeReport.unresolvedReferences.some(item => item.view.name === transitive.name &&
        item.relation.schema === peer && item.reason === 'outside-selected-schemas'));
      await assert.rejects(() => adapter.inspect({ target: { ...shadow, kind: 'table' }, schemas: [home, peer] }), /object kind/u);
      await assert.rejects(() => adapter.inspect(request, () => { throw Error('fixture cancellation'); }), /fixture cancellation/u);
      await adapter.preview?.(request, report);
      published.nativeReadonlyReport = Boolean(adapter.preview);
    } finally {
      await adapter.disconnect();
    }
    try {
      await adapter.connect(guest);
      const limited = await adapter.inspect({ target, schemas: [home] });
      assert.ok(limited.observedRelations < report.observedRelations);
      assert.deepEqual(limited.opaqueViews.find(item => item.relation.name === noShow.name),
        { relation: noShow, reason: 'definition-unavailable' });
      assert.equal(limited.impacted.length, 0);
      assert.match(limited.scopeNote, /Hidden relations/u);
      await assert.rejects(() => adapter.inspect({ target, schemas: [home, peer] }), /missing or not visible/u);
    } finally {
      await adapter.disconnect();
    }
    const [[unchanged]] = await actor.query('SELECT id FROM ' + location(transitive));
    assert.equal(unchanged.id, 11);
    await spring();
    return { engine: runtime.dbEngine, serverVersion: version, schemas: 2, directViewCount: 2, transitiveViewCount: 1,
      reachableEdges: report.edges.length, viewTarget: true, sameNamedPeerIsolated: true, outsideScopeReported: true,
      hiddenSchemaRejected: true, opaqueDefinitionReported: true, selectWithoutShowViewReported: true,
      cancellationRejected: true, springJdbcUnchanged: true, ...published };
  } finally {
    try {
      for (const item of [transitive, direct, shadow, opaque, noShow]) await actor.query('DROP VIEW IF EXISTS ' + location(item));
      for (const item of [sibling, sameName, target]) await actor.query('DROP TABLE IF EXISTS ' + location(item));
    } finally {
      await actor.end();
    }
  }
}

async function verifyViewImpactBackend() {
  let db;
  return verifyViewImpact({
    connect(config) { db = new MysqlService(config); },
    disconnect() { return db?.dispose(); },
    inspect(request, assertActive = () => {}) {
      return observeViewImpact((sql, values) => {
        assertActive();
        assert.match(sql, /^SELECT /u);
        return db._metadataQuery(sql, values);
      }, request);
    }
  });
}

async function runViewImpactChecks(api, vscode, checks) {
  const service = api.objectSources.viewImpact;
  const result = await verifyViewImpact({
    connect: config => api.connectMysql(config),
    disconnect: () => api.disconnectMysql(),
    inspect: service.inspect,
    async preview(request, expected) {
      const opened = await vscode.commands.executeCommand('rocketbrain.db.inspectViewImpact', request);
      assert.equal(opened.uri.scheme, 'rocketbrain-view-impact');
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.uri.toString(), opened.uri.toString());
      assert.deepEqual(JSON.parse(editor.document.getText()), expected);
      const before = editor.document.getText();
      await vscode.commands.executeCommand('type', { text: 'cannot write' });
      assert.equal(editor.document.getText(), before);
      assert.equal(editor.document.isDirty, false);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });
  checks.push('Inspected direct and transitive cross-schema view paths from an observed table and view in the native read-only report.');
  checks.push('Separated unsupported definitions, withheld SHOW VIEW access, hidden schemas and out-of-scope references on the actual server.');
  return result;
}

module.exports = { runViewImpactChecks, verifyViewImpactBackend };
if (require.main === module) {
  verifyViewImpactBackend().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
