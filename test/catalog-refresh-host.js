'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { runCatalogOperation, readCatalogRefresh } = require('../src/db/catalog-refresh');
const { createMetadataCache, observeCatalogIdentity } = require('../src/db/metadata-cache');
const { jdbcReadback } = require('./java-source-analysis-host');

const collect = catalog => [...catalog.tables, ...catalog.views];
const find = (catalog, name) => collect(catalog).find(object => object.name === name);
const quote = name => '`' + name.replaceAll('`', '``') + '`';

async function withStructure(test) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  assert.equal(owner.id, path.basename(folder));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  let restricted;
  if (process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG) {
    const fixture = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG, 'utf8'));
    assert.equal(fixture.owner, owner.id);
    assert.equal(fixture.sourceConfigPath, runtime.dbConfigPath);
    assert.equal(fixture.admin.port, config.port);
    restricted = fixture.admin;
  }
  const actor = await mysql.createConnection(config);
  const prefix = 'rb019_' + randomBytes(4).toString('hex');
  const names = Object.fromEntries(['parent','child','view','new','fk','check','idx','trigger','procedure'].map(key => [key, prefix + '_' + key]));
  const table = key => quote(names[key]);
  try {
    await actor.query('CREATE TABLE ' + table('parent') + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
    await actor.query('CREATE TABLE ' + table('child') + ' (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT) ENGINE=InnoDB');
    await actor.query('CREATE VIEW ' + table('view') + ' AS SELECT id FROM ' + table('child'));
    return await test({ config, restricted, engine: runtime.dbEngine, names, actor, table,
      addConstraint: () => actor.query('ALTER TABLE ' + table('child') + ' ADD CONSTRAINT ' + table('check') + ' CHECK (parent_id > 0)'),
      alterChild: async () => {
        await actor.query('ALTER TABLE ' + table('child') + ' ADD COLUMN payload VARCHAR(35), ADD INDEX ' + table('idx') +
          ' (parent_id), ADD CONSTRAINT ' + table('fk') + ' FOREIGN KEY (parent_id) REFERENCES ' + table('parent') + ' (id)');
        await actor.query('CREATE TRIGGER ' + table('trigger') + ' BEFORE INSERT ON ' + table('child') +
          ' FOR EACH ROW SET NEW.payload = COALESCE(NEW.payload, \'dg019\')');
      },
      alterPeers: async () => {
        await actor.query('INSERT INTO ' + table('child') + ' (parent_id) VALUES (NULL)');
        await actor.query('ALTER TABLE ' + table('parent') + ' ADD COLUMN observed VARCHAR(12)');
        await actor.query('DROP VIEW ' + table('view'));
        await actor.query('CREATE TABLE ' + table('new') + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
        await actor.query('CREATE PROCEDURE ' + table('procedure') + ' () SELECT 1');
      }
    });
  } finally {
    try {
      await actor.query('DROP TRIGGER IF EXISTS ' + table('trigger'));
      await actor.query('DROP PROCEDURE IF EXISTS ' + table('procedure'));
      await actor.query('DROP VIEW IF EXISTS ' + table('view'));
      for (const key of ['new', 'child', 'parent']) await actor.query('DROP TABLE IF EXISTS ' + table(key));
    } finally { await actor.end(); }
  }
}

function assertChild(catalog, names) {
  const child = find(catalog, names.child);
  assert.ok(child.columns.some(column => column.name === 'payload' && column.type === 'varchar(35)'));
  assert.deepEqual(child.foreignKeys.find(key => key.name === names.fk)?.columns,
    [{ name: 'parent_id', referencedColumn: 'id', ordinal: 1 }]);
  assert.ok(child.indexes.some(index => index.name === names.idx));
  assert.match(child.checks.find(check => check.name === names.check)?.expression, /parent_id.*>.*0/);
  assert.ok(catalog.triggers.some(trigger => trigger.name === names.trigger && trigger.table === names.child));
}

function assertIncremental(report, catalog, names) {
  assert.ok(report.unchanged.includes(names.child), 'A changed row and AUTO_INCREMENT do not change the metadata fingerprint.');
  assert.ok(report.refreshed.includes(names.parent) && report.refreshed.includes(names.new));
  assert.ok(report.removedFromView.includes(names.view));
  assert.ok(find(catalog, names.parent).columns.some(column => column.name === 'observed'));
  assert.ok(find(catalog, names.new));
  assert.ok(!find(catalog, names.view));
  assert.ok(catalog.routines.some(routine => routine.name === names.procedure));
}

async function verifyCatalogRefresh() {
  return withStructure(async fixture => {
    const db = new MysqlService(fixture.config);
    try {
      const baseline = await db.metadata();
      const state = { db, metadata: baseline, epoch: 1, mysql: true, running: new Set() };
      const options = { needsMysql: true, trusted: () => true, busy: () => false, assertReady: () => {}, updateStatus: () => {} };
      let fingerprints = new Map();
      async function stage(names, query) {
        return runCatalogOperation(state, async ({ before, assertCurrent }) => {
          const request = { before, names, fingerprints, assertCurrent };
          const result = query ? await readCatalogRefresh(query, fixture.config.database, request, before.revision + 1) : await db.refreshCatalog(request);
          assertCurrent();
          state.metadata = result.catalog;
          fingerprints = result.fingerprints;
          return result;
        }, options);
      }
      const { names } = fixture;
      const originalParent = find(baseline, names.parent);
      let saved;
      const cache = createMetadataCache({ get: () => saved, async update(_key, value) { saved = structuredClone(value); } }, { isTrusted: () => true });
      const identity = await observeCatalogIdentity(db, baseline);
      const captured = await cache.capture('a'.repeat(64), identity, baseline, () => true);
      await fixture.addConstraint();
      const checksOnly = await stage([names.child]);
      assert.equal(await cache.revalidateObjects(captured.id, identity, checksOnly.catalog, checksOnly.processed, () => true), 'unverified');
      assert.equal(cache.list()[0].checkedAt, captured.checkedAt);
      await fixture.alterChild();
      const first = stage([names.child]);
      await assert.rejects(stage(), /Another metadata refresh or capture is running/);
      const named = await first;
      assert.deepEqual(named.report.refreshed, [names.child]);
      assertChild(named.catalog, names);
      assert.strictEqual(find(named.catalog, names.parent), originalParent);
      assert.equal(await cache.revalidateObjects(captured.id, identity, named.catalog, named.processed, () => true), 'invalidated');
      assert.equal(cache.list().length, 0);
      const cold = await stage();
      assert.deepEqual(cold.report.failed, []);
      await fixture.actor.query('CREATE OR REPLACE VIEW ' + fixture.table('view') +
        ' AS SELECT id AS selected_id FROM ' + fixture.table('child'));
      const view = await stage([names.view]);
      assert.deepEqual(find(view.catalog, names.view).columns.map(column => column.name), ['selected_id']);
      let withheldDefinitionFallback = false;
      if (fixture.restricted) {
        const limited = new MysqlService(fixture.restricted);
        try {
          const result = await limited.refreshCatalog({ before: await limited.metadata(), names: [names.view] });
          assert.deepEqual(result.report.definitionsUnavailable, [names.view]);
          assert.deepEqual(result.report.refreshed, [names.view]);
          assert.deepEqual(find(result.catalog, names.view).columns.map(column => column.name), ['selected_id']);
          withheldDefinitionFallback = true;
        } finally { await limited.dispose(); }
      }
      const child = find(state.metadata, names.child);
      await fixture.alterPeers();
      const delta = await stage();
      assertIncremental(delta.report, delta.catalog, names);
      assert.strictEqual(find(delta.catalog, names.child), child);
      await fixture.actor.query('ALTER TABLE ' + fixture.table('child') + ' ADD COLUMN ' + quote('delayed') + ' INT');
      await fixture.actor.query('ALTER TABLE ' + fixture.table('parent') + ' ADD COLUMN ' + quote('independent') + ' INT');
      const mixed = await stage([names.child, names.parent], (sql, parameters) => {
        if (parameters?.[1] === names.child && sql.includes('information_schema.STATISTICS')) return Promise.reject(Error('Fixture catalogue read interrupted.'));
        return db._metadataQuery(sql, parameters);
      });
      assert.equal(mixed.report.failed[0]?.name, names.child);
      assert.equal(mixed.catalog.coverage.columns, 'unavailable');
      assert.strictEqual(find(mixed.catalog, names.child), child);
      assert.ok(find(mixed.catalog, names.parent).columns.some(column => column.name === 'independent'));
      const recovered = await stage([names.child], (sql, parameters) => db._metadataQuery(sql, parameters));
      assert.ok(find(recovered.catalog, names.child).columns.some(column => column.name === 'delayed'));
      assert.equal(recovered.catalog.coverage.columns, 'loaded');
      const [[row]] = await fixture.actor.query('SELECT COUNT(*) AS n FROM ' + fixture.table('child'));
      assert.equal(Number(row.n), 1);
      const beforeReconnect = await db.metadata();
      db._lose(db._metadataSession, Error('Owned metadata session reconnect fixture.'));
      await assert.rejects(db.refreshCatalog({ before: beforeReconnect, names: [names.child] }), /metadata session changed/);
      const afterReconnect = await db.metadata();
      assert.deepEqual((await db.refreshCatalog({ before: afterReconnect, names: [names.child] })).report.refreshed, [names.child]);
      return { engine: fixture.engine, namedColumnsIndexesForeignKeysChecks: true, triggerDescriptors: true,
        addedRemovedAndChangedObjects: true, refreshedViewColumns: true, withheldDefinitionFallback,
        unchangedIdentity: true, rowOnlyUpdateIgnored: true, concurrentRejected: true, replacedMetadataSessionRejected: true,
        injectedPartialFailureRetained: true, siblingPublishedAndRecovered: true, cacheInvalidatedWithoutReattesting: true,
        jdbc: await jdbcReadback() };
    } finally { await db.dispose(); }
  });
}

async function runCatalogRefreshChecks(api, vscode, checks) {
  return withStructure(async fixture => {
    const { names } = fixture;
    await api.connectMysql(fixture.config);
    let saved;
    try {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('rocketbrain.db.refreshObjectMetadata') && commands.includes('rocketbrain.db.refreshIncrementalMetadata'));
      saved = await api.cachedMetadata.capture();
      const page = await api.lazyCatalog.list({ prefix: names.child });
      const offerIndex = page.items.findIndex(item => item.name === names.child);
      assert.ok(offerIndex >= 0);
      await fixture.addConstraint();
      const viaLazy = await api.lazyCatalog.refresh(page.id, offerIndex);
      assert.deepEqual(viaLazy.refreshed, [names.child]);
      assert.equal(api.cachedMetadata.list().find(item => item.id === saved.id).checkedAt, saved.checkedAt);
      await fixture.alterChild();
      const command = await vscode.commands.executeCommand('rocketbrain.db.refreshObjectMetadata', { table: { name: names.child } });
      assert.deepEqual(command.refreshed, [names.child]);
      assertChild(api.catalogSnapshot(), names);
      assert.ok(api.schema().find(item => item.name === names.child).columns.some(column => column.name === 'payload'));
      assert.equal(api.cachedMetadata.list().some(item => item.id === saved.id), false);
      const initial = api.refreshIncremental();
      await assert.rejects(api.refreshObjects({ names: [names.child] }), /Another metadata refresh or capture is running/);
      assert.deepEqual((await initial).failed, []);
      await fixture.alterPeers();
      const incremental = await vscode.commands.executeCommand('rocketbrain.db.refreshIncrementalMetadata');
      assertIncremental(incremental, api.catalogSnapshot(), names);
      assert.deepEqual(await jdbcReadback(), { people: 2, departments: 1, rolledBackNames: 0 });
      checks.push('Installed metadata refresh commands and lazy catalog merged only verified objects. Check constraints, scoped cache invalidation and concurrent guard matched live Spring fixture metadata.');
      return { engine: fixture.engine, nativeObjectCommand: true, nativeIncrementalCommand: true, nativeLazyRefresh: true,
        installedConcurrentGuard: true, exactConstraintsAndColumns: true, installedCacheInvalidation: true };
    } finally {
      if (saved && api.cachedMetadata.list().some(item => item.id === saved.id)) await api.cachedMetadata.remove(saved.id, saved.fingerprint);
      await api.disconnectMysql();
    }
  });
}

if (require.main === module) verifyCatalogRefresh().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runCatalogRefreshChecks, verifyCatalogRefresh };
