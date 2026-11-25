'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { withFixture } = require('./sql-related-source-host');

const high = '9007199254740993';
const key = Buffer.from([0x00, 0xff, 0x41]);

async function verifyLogical(fixture, tools) {
  const { actual, table, local, remote } = fixture;
  const loose = table + '_loose';
  const mapping = { name: 'Approved cross-schema annotation', child: { schema: local, table: loose },
    parent: { schema: remote, table }, pairs: [{ child: 'ref_id', parent: 'tenant' }, { child: 'ref_key', parent: 'token' }] };
  await actual('CREATE TABLE ?? (id INT PRIMARY KEY, ref_id BIGINT UNSIGNED, ref_key VARBINARY(8), wrong VARCHAR(30)) ENGINE=InnoDB', [loose]);
  try {
    await actual('INSERT INTO ?? VALUES ?', [loose, [[44, high, key, 'avoid'], [45, null, key, 'null']]]);
    await assert.rejects(tools.prepare({ ...mapping, parent: { schema: local, table } }), /different schemas/);
    await assert.rejects(tools.prepare({ ...mapping, pairs: mapping.pairs.slice(1) }), /every parent primary-key/);
    await assert.rejects(tools.prepare({ ...mapping, pairs: [{ child: 'wrong', parent: 'tenant' }, mapping.pairs[1]] }), /compatible, exact types/);
    await assert.rejects(tools.prepare({ ...mapping, child: { schema: local, table } }), /physical foreign key/);
    const stale = await tools.prepare(mapping);
    assert.equal(stale.changesDatabase, false);
    await actual('ALTER TABLE ??.?? ADD COLUMN new_column INT', [remote, table]);
    await assert.rejects(tools.save(stale.token), /definition or database account changed/);
    await assert.rejects(tools.save(stale.token), /review expired/);
    assert.deepEqual((await tools.list()).relations, []);
    await actual('ALTER TABLE ??.?? DROP COLUMN new_column', [remote, table]);

    const review = await tools.prepare(mapping), saved = await tools.save(review.token);
    assert.ok(saved.relation.id);
    assert.deepEqual(saved.relation, { id: saved.relation.id, ...mapping });
    assert.equal(saved.changesDatabase, false);
    await assert.rejects(tools.prepare(mapping), /already saved/);
    if (tools.reconnect) await tools.reconnect();
    const collected = await tools.list();
    assert.deepEqual(collected.relations, [saved.relation]);
    if (tools.otherProfile) await tools.otherProfile();
    if (tools.otherAccount) await tools.otherAccount(mapping.child);
    assert.equal(Number((await actual('SELECT COUNT(*) n FROM information_schema.KEY_COLUMN_USAGE ' +
      'WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL', [local, loose]))[0].n), 0);
    const child = await tools.query('SELECT q.id AS row_key,q.ref_id AS parent_id,q.ref_key AS parent_bytes FROM `' + loose + '` q ORDER BY q.id');
    const related = (await tools.choices(child, 0)).find(item => item.kind === 'logical' && item.schema === remote && item.table === table);
    assert.ok(related);
    assert.equal((await tools.choices(child, 1)).length, 0);
    const parent = await tools.follow(child, 0, related);
    assert.deepEqual(parent.result.rows, [[high, '0x00ff41', 'exact']]);
    assert.equal(parent.result.edit.canEdit, false);
    const reverse = (await tools.choices(parent, 0)).find(item => item.kind === 'logical' && item.schema === local &&
      item.table === loose && item.direction === 'referencing');
    assert.ok(reverse);
    const original = await tools.follow(parent, 0, reverse);
    assert.deepEqual(original.result.rows, [[44, high, '0x00ff41', 'avoid']]);
    if (tools.back) {
      const row = child.result.relatedRows.rowIds[0];
      assert.deepEqual(await tools.back(parent), { resultId: child.id, rowId: row });
    }
    await actual('ALTER TABLE ??.?? ADD COLUMN structural_drift INT NULL', [remote, table]);
    try {
      assert.equal((await tools.choices(child, 0)).some(item => item.kind === 'logical'), false);
      await assert.rejects(tools.follow(child, 0, related), /foreign key or visible row changed/);
    } finally { await actual('ALTER TABLE ??.?? DROP COLUMN structural_drift', [remote, table]); }
    await assert.rejects(tools.remove(saved.relation.id, 'stale'), /saved mapping changed/);
    assert.equal((await tools.remove(saved.relation.id, (await tools.list()).revision)).removed, true);
    assert.deepEqual((await tools.list()).relations, []);
    assert.equal((await tools.choices(child, 0)).some(item => item.kind === 'logical'), false);
    return { bidirectionalExactComposite: true, logicalWithoutServerDdl: true, isolatedScopes: Boolean(tools.otherProfile),
      separateAccountRefused: Boolean(tools.otherAccount),
      reviewedSaveAndDelete: true, typedEndpointsAndFullParentKey: true, staleReviewAndNavigationRefused: true,
      logicalFromSqlAndGrid: true, persistenceAcrossReconnect: Boolean(tools.reconnect), nativeReturn: Boolean(tools.back) };
  } finally { await actual('DROP TABLE IF EXISTS ??', [loose]); }
}

async function verifyCrossLogicalBackend(runtime, withSeparateAccount) {
  return withFixture(runtime, async fixture => {
    const { registerSchemaDiagrams } = require('../src/db/schema-erd-vscode');
    const { crossLogicalKey } = require('../src/db/cross-schema-logical');
    const { MysqlService } = require('../src/db/mysql');
    const { relatedRowsFromObservation } = require('../src/db/related-rows');
    const db = new MysqlService(fixture.config), loaded = new Map();
    const profile = { id: 'owned-local-profile', host: fixture.config.host, port: fixture.config.port, database: fixture.config.database };
    const noop = () => ({ dispose() {} });
    const service = registerSchemaDiagrams({ workspaceState: {
      get: (name, fallback) => structuredClone(loaded.get(name) ?? fallback),
      async update(name, value) { loaded.set(name, structuredClone(value)); }
    } }, { workspace: { isTrusted: true, workspaceFolders: [{}] }, commands: { registerCommand: noop } }, { database: {
      liveCatalogSnapshot: () => ({ database: profile.database }), activeConnectionProfile: () => profile,
      inspectCrossLogical: input => db.inspectCrossLogical(input), onDidChangeDatabase: noop
    } });
    let counter = 0;
    const session = async () => { const id = 'db-logical-' + (++counter); await db.openSession(id); return id; };
    const choices = async (record, index) => {
      const { result, sessionId, source } = record;
      const saved = loaded.get(crossLogicalKey)?.[0]?.value || [];
      const row = result.rows[index];
      if (source.primary) await db.recheckSqlRowSource({ source, row });
      const catalog = await db.relatedRowsCatalog({ schema: source.schema, table: source.table, crossLogical: saved });
      const options = relatedRowsFromObservation(catalog, source.columns, row, source.definitions);
      for (const relationship of options.filter(item => item.sourceServer)) {
        assert.ok(await db.matchesRelatedRoute(sessionId, relationship.sourceServer));
      }
      return options;
    };
    try {
      const { schemas } = await db.crossLogicalEndpoint({});
      assert.ok(schemas.includes(fixture.local) && schemas.includes(fixture.remote));
      const { tables } = await db.crossLogicalEndpoint({ schema: fixture.remote });
      assert.ok(tables.includes(fixture.table));
      const parent = await db.crossLogicalEndpoint({ schema: fixture.remote, table: fixture.table });
      assert.deepEqual(parent.primary, ['tenant', 'token']);
      const report = await verifyLogical(fixture, {
        list: () => service.listCrossRelations(), prepare: input => service.prepareCrossRelation(input),
        save: token => service.saveCrossRelation(token), remove: (id, revision) => service.removeCrossRelation(id, revision),
        async query(sql) {
          const sessionId = await session(), result = await db.query(sql, { sessionId });
          const source = await db.captureSqlRowSource(sql, result, sessionId);
          assert.ok(source);
          return { result, sessionId, source };
        },
        choices,
        async follow(record, index, prior) {
          const edge = (await choices(record, index)).find(item => item.key === prior.key);
          if (!edge) throw Error('The foreign key or visible row changed. Choose the relation again.');
          const sessionId = await session(), result = await db.previewRelatedTable(edge, { sessionId, filters: edge.filters });
          return { result, sessionId, source: { schema: edge.schema, table: edge.table, columns: result.columns, definitions: result.edit.columns } };
        },
        async otherProfile() {
          profile.id = 'different-owned-profile';
          try { assert.deepEqual(service.listCrossRelations().relations, []); }
          finally { profile.id = 'owned-local-profile'; }
        },
        ...(withSeparateAccount && { otherAccount: source => withSeparateAccount(fixture.config, async config => {
          const secondary = new MysqlService(config);
          try {
            const before = await secondary.crossLogicalEndpoint(source);
            assert.deepEqual(before.primary, ['id']);
            const crossLogical = loaded.get(crossLogicalKey)[0].value;
            const catalog = await secondary.relatedRowsCatalog({ ...source, crossLogical });
            assert.equal(catalog.edges.some(edge => edge.sourceServer), false);
          } finally { await secondary.dispose(); }
        }) })
      });
      return { ...report, actualEndpointInventory: true };
    } finally { await service.dispose(); await db.dispose(); }
  });
}

async function runCrossSchemaLogicalChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const result = await withFixture(runtime, async fixture => {
    const { config, table } = fixture, profiles = api.dbConnections, diagram = api.schemaDiagrams;
    const options = { host: config.host, port: config.port, user: config.user, database: config.database,
      tls: { mode: 'disabled' }, ssh: null };
    const profile = await profiles.save({ profile: { ...options, name: 'Logical ' + table }, password: config.password, rememberPassword: false });
    const other = await profiles.save({ profile: { ...options, name: 'Separate ' + table }, password: config.password, rememberPassword: false });
    const connect = id => profiles.connect({ id, password: config.password });
    const select = (record, index) => {
      const model = record.result.edit || record.result.relatedRows;
      return { modelId: model.modelId, rowId: model.rowIds[index] };
    };
    await connect(profile.id);
    try {
      assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.schema.logicalAcrossSchemas'));
      return await verifyLogical(fixture, {
        prepare: input => diagram.prepareCrossRelation(input), save: review => diagram.saveCrossRelation(review),
        remove: (id, revision) => diagram.removeCrossRelation(id, revision), list: () => diagram.listCrossRelations(),
        async reconnect() { await api.disconnectMysql(); await connect(profile.id); },
        async otherProfile() {
          await connect(other.id);
          try { assert.deepEqual(diagram.listCrossRelations().relations, []); }
          finally { await connect(profile.id); }
        },
        async query(sql) {
          const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
          await vscode.window.showTextDocument(document, { preview: false });
          const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
          const record = api.results().find(item => item.id === id);
          assert.equal(record?.state, 'done', record?.error);
          assert.ok(record.result.relatedRows);
          return record;
        },
        choices: (record, index) => api.inspectRelatedRows(record.id, select(record, index)),
        async follow(record, index, edge) {
          const id = await api.openRelatedRows(record.id, select(record, index), edge.key);
          const opened = api.results().find(item => item.id === id);
          assert.equal(opened?.state, 'done', opened?.error);
          return opened;
        },
        back: record => api.returnToRelatedSource(record.id)
      });
    } finally {
      const current = diagram.listCrossRelations();
      for (const mapping of current.relations) await diagram.removeCrossRelation(mapping.id, diagram.listCrossRelations().revision);
      await api.disconnectMysql();
      await profiles.remove({ id: other.id, expectedRevision: other.revision });
      await profiles.remove({ id: profile.id, expectedRevision: profile.revision });
    }
  });
  checks.push('Registered a reviewed compound logical mapping between explicit schemas and followed it from a captured SQL result and reverse grid.');
  checks.push('The real server retained no new foreign key. A schema change invalidated review and navigation, and remove stopped both directions.');
  return result;
}

module.exports = { verifyCrossLogicalBackend, runCrossSchemaLogicalChecks };
