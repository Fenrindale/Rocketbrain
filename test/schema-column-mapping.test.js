'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {MysqlService} = require('../src/db/mysql');
const {makePlan, JOURNAL} = require('../src/db/schema-recovery');
const {captureSchema, compareSnapshots, normalizeSnapshot} = require('../src/db/schema-diff');
const {chooseColumnMappings, chooseConversions} = require('../src/db/schema-conversion-vscode');
const {fixture: snapshot} = require('./helpers/schema-diff-fixture');
const F = require('./helpers/schema-column-mapping-fixture');

function renameFixture(change = () => {}) {
  const current = snapshot();
  const desired = structuredClone(current);
  const table = desired.tables[0];
  table.columns[0].name = 'record_id';
  table.columns[0].type = 'bigint';
  table.indexes[0].columns[0].name = 'record_id';
  table.createSql = table.createSql.replaceAll('\x60id\x60', '\x60record_id\x60').replace('int NOT', 'bigint NOT');
  change(table, current);
  return {current, desired: normalizeSnapshot(desired, {verifyFingerprint: false})};
}

const operationId = '01234567890123456789012345678901';
const mappings = {people: [{from: 'id', to: 'record_id'}]};

test('rebuild maps differently named source fields to exact target ordinals and isolates the new journal shape', () => {
  const {current, desired} = renameFixture();
  const plan = makePlan(current, desired, {tables: ['people'], operationId, columnMappings: mappings});
  assert.equal(plan.formatVersion, 5);
  assert.deepEqual(plan.steps[0].sourceColumns, ['id']);
  assert.deepEqual(plan.steps[0].common, ['record_id']);
  assert.equal(plan.steps[0].conversions[0].to.type, 'BIGINT');
  assert.equal(plan.steps[0].conversions[0].from.type, 'INT');
  assert.match(plan.sql, /Retain source values .id. → .record_id./u);
  assert.match(plan.steps[0].copySql, /\x60record_id\x60\) SELECT \x60id\x60 FROM/u);
  const ordinary = renameFixture(table => {
    table.columns[0].name = 'id';
    table.indexes[0].columns[0].name = 'id';
  });
  const older = makePlan(ordinary.current, ordinary.desired, {tables: ['people'], operationId});
  assert.deepEqual(older, makePlan(ordinary.current, ordinary.desired, {tables: ['people'], operationId, columnMappings: {}}));
  assert.equal(older.formatVersion, 3);
  assert.equal(Object.hasOwn(older, 'columnMappings'), false);
  assert.equal(Object.hasOwn(older.steps[0], 'sourceColumns'), false);
});

test('rebuild refuses claimed/malformed/nonbijective column mappings or unpreserved affected keys', () => {
  const {current, desired} = renameFixture();
  for (const value of [null, [], {other: mappings.people}, {people: []},
    {people: [{from: 'ID', to: 'record_id'}]}, {people: [{from: 'id', to: 'record_id', type: 'int'}]},
    {people: [...mappings.people, ...mappings.people]}, {people: [{from: 'id', to: 'ID'}]}]) {
    assert.throws(() => makePlan(current, desired, {tables: ['people'], columnMappings: value}), /column|table/i);
  }
  for (const change of [t => {t.indexes[0].columns[0].name = 'id';}, t => {t.indexes[0].name = 'pk2';},
    t => {t.columns[0].extra = 'auto_increment';}, t => {t.checks.push({name: 'c', expression: 'record_id>0'});}]) {
    const f = renameFixture(change);
    assert.throws(() => makePlan(f.current, f.desired, {tables: ['people'], columnMappings: mappings}), /column|index/iu);
  }
  const decimal = renameFixture(table => {table.columns[0].type = 'decimal(9,2)';});
  assert.throws(() => makePlan(decimal.current, decimal.desired, {tables: ['people'], columnMappings: mappings,
    conversions: {people: [{column: 'record_id', strategy: 'decimal-quantize', onLoss: 'truncate'}]}}), /preserve.*exact/iu);
});

test('column mapping picker requires explicit source and target choices and shows exact conversion policies', async () => {
  const {current, desired} = renameFixture();
  const titles = [];
  const vscode = {workspace: {isTrusted: true}, window: {
    async showQuickPick(options, {title}) {
      titles.push(title);
      assert.ok(!options.some(option => option.description === 'Requires separate loss approval'));
      return options.find(option => option.label === 'id' || option.label === 'record_id' || option.rule?.strategy === 'exact');
    }
  }};
  const selected = await chooseColumnMappings(vscode, current, desired, ['people']);
  assert.deepEqual(selected, mappings);
  assert.deepEqual(await chooseConversions(vscode, current, desired, ['people'], {columnMappings: selected}),
    {people: [{column: 'record_id', strategy: 'exact'}]});
  assert.deepEqual(titles, ['Map a renamed column in people', 'Destination for people.id', 'Conversion for people.record_id']);
  vscode.window.showQuickPick = async choices => choices.find(choice => choice.skip);
  assert.deepEqual(await chooseColumnMappings(vscode, current, desired, ['people']), {});
  vscode.window.showQuickPick = async () => undefined;
  assert.equal(await chooseColumnMappings(vscode, current, desired, ['people']), null);
});

const database = process.env.ROCKETBRAIN_SCHEMA_COLUMN_MAP_CONFIG;
const runtime = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const cpFile = process.env.ROCKETBRAIN_SCHEMA_COLUMN_MAP_SPRING_CLASSPATH;
const report = process.env.ROCKETBRAIN_SCHEMA_COLUMN_MAP_RECEIPT;

test('actual schema rebuild maps renamed values and paired composite FK types with fresh recovery and Spring JDBC', {
  skip: !database || !runtime || !cpFile, timeout: 190000
}, async () => {
  const {config, engine} = await F.ownedConfig(database);
  const {javaHome} = JSON.parse(await fs.readFile(runtime, 'utf8'));
  const s = await F.fixture(config);
  let service = new MysqlService(config);
  const capture = scope => captureSchema(service, scope);
  const spring = projected => F.springRead(s, {javaHome, cpFile, engine, projected});
  try {
    const current = await s.prepare(capture);
    const args = {current, desired: s.desired, tables: s.tableNames, columnMappings: s.columnMappings};
    await s.checkGraph(capture, false);
    const before = await spring(false);
    const journalVisibility = () => s.actor.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [config.database,JOURNAL]);
    const beforeJournal = await journalVisibility();
    await assert.rejects(service.previewSchemaRebuild({...args, tables: [s.tables.parent]}), /FK|foreign key|affected/iu);
    await assert.rejects(service.previewSchemaRebuild({...args, desired: s.invalidDesired('index')}), /affected index/iu);
    await assert.rejects(service.previewSchemaRebuild({...args, desired: s.invalidDesired('foreign')}), /affected foreign key/iu);
    await assert.rejects(service.previewSchemaRebuild({...args,
      columnMappings: {[s.tables.parent]: [{from: F.names.from, to: 'id'}]}}), /distinct removed/iu);
    const afterJournal = await journalVisibility();
    assert.deepEqual(afterJournal[0], beforeJournal[0]);
    await s.checkGraph(capture, false);

    const review = await service.previewSchemaRebuild(args);
    s.plans.push(review.plan);
    assert.equal(review.plan.formatVersion, 5);
    assert.equal(review.plan.requiresDependencyChangeApproval, true);
    assert.equal(review.plan.atomicAcrossTables, false);
    assert.match(review.plan.sql, /Retain source values.*legacy_code.*current_code/u);
    const step = review.plan.steps.find(step => step.table === s.tables.parent);
    assert.deepEqual(step.sourceColumns, ['id', 'zone_id', F.names.from, 'note']);
    assert.deepEqual(step.common, ['id', 'zone_id', F.names.to, 'note']);
    assert.match(step.copySql, /INSERT INTO.*\x60current_code\x60.*SELECT.*\x60legacy_code\x60/u);
    assert.match(review.plan.sql, /REFERENCES [^\r\n]+\x60zone_id\x60,\x60current_code\x60/u);
    await assert.rejects(service.applySchemaRebuild({...F.flags, allowDependencyChanges: false, reviewId: review.reviewId}),
      /dependencies|dependency|approve/iu);
    review.plan.columnMappings[s.tables.parent][0].to = 'tampered_public_mapping';
    const result = await service.applySchemaRebuild({...F.flags, reviewId: review.reviewId});
    assert.equal(result.state, 'applied', JSON.stringify(result));
    await s.checkGraph(capture, true);
    const after = await spring(true);
    assert.deepEqual(before, after);
    const saved = await s.journal(review.plan.id);
    assert.deepEqual(saved.plan.columnMappings, s.columnMappings);
    assert.deepEqual(saved.plan.steps.find(step => step.table === s.tables.parent).sourceColumns, step.sourceColumns);
    assert.equal(JSON.stringify(saved).includes(F.expected.parent[0][3]), false);
    assert.equal(JSON.stringify(saved).includes('independent peer'), false);

    await service.dispose();
    service = new MysqlService(config);
    const recover = () => service.recoverSchemaRebuild({...F.flags, operationId: review.plan.id});
    const bad = structuredClone(saved);
    delete bad.plan.columnMappings;
    await s.actor.execute('UPDATE ' + F.q(JOURNAL) + ' SET payload=? WHERE operation_id=?', [JSON.stringify(bad), review.plan.id]);
    await assert.rejects(recover(), /column mapping metadata|ownership markers/iu);
    await s.actor.execute('UPDATE ' + F.q(JOURNAL) + ' SET payload=? WHERE operation_id=?', [JSON.stringify(saved), review.plan.id]);
    const recovered = await recover();
    assert.equal(recovered.state, 'recovered', JSON.stringify(recovered));
    assert.equal(recovered.originalSchemaAndDataVerified, true);
    await s.checkGraph(capture, false);
    const restored = await spring(false);
    assert.deepEqual(before, restored);

    const drift = await service.previewSchemaRebuild({...args, current: await capture(s.scope)});
    s.plans.push(drift.plan);
    assert.equal((await service.applySchemaRebuild({...F.flags, reviewId: drift.reviewId})).state, 'applied');
    await s.actor.query('UPDATE ' + F.q(s.tables.parent) + " SET note='peer edit after publication' WHERE id=1");
    await assert.rejects(service.recoverSchemaRebuild({...F.flags, operationId: drift.plan.id}), /Live data\/schema changed|changed|fences/iu);
    assert.equal((await s.actor.query('SELECT note FROM ' + F.q(s.tables.parent) + ' WHERE id=1'))[0][0].note, 'peer edit after publication');
    await assert.rejects(s.actor.query('UPDATE ' + F.q(s.tables.parent) + " SET note='second external attempt' WHERE id=1"),
      /Rocketbrain rebuild/u);
    await s.checkPeer();
    if (report) await fs.writeFile(report, JSON.stringify({engine, planVersion: 5, before, after, restored,
      explicitColumnRename: true, preservedValuesAndNulls: true, retainedCompositeIndex: true, retainedCompositeFK: true,
      bothOwnersSelected: true, readOnlyPreflightRefusals: true, columnMappingDriftRefused: true,
      noRowValuesInJournal: true, liveRowDriftRefused: true, freshSessionRestored: true,
      peerPreserved: true, atomicAcrossTables: false}, null, 2) + '\n', {flag: 'wx'});
  } finally {
    try {await service.dispose();}
    finally {await s.close();}
  }
});

test('actual selected rebuild retains an unselected live column and restores the selected FK pair through a new session', {
  skip: !database || !runtime || !cpFile, timeout: 190000
}, async () => {
  const {config, engine} = await F.ownedConfig(database);
  const {javaHome} = JSON.parse(await fs.readFile(runtime, 'utf8'));
  const s = await F.fixture(config, {unselectedDrop: true});
  let service = new MysqlService(config);
  const capture = scope => captureSchema(service, scope);
  const parent = s.tables.parent;
  const child = s.tables.child;
  const spring = projected => F.springRead(s, {javaHome, cpFile, engine, projected});
  const signature = change => [change.kind, change.table, change.object].join(':');
  const targetChangeKeys = new Set([
    ['drop-column', parent, F.names.from].join(':'),
    ['add-column', parent, F.names.to].join(':'),
    ['change-index', parent, 'named_code'].join(':'),
    ['change-column', child, 'link_code'].join(':'),
    ['change-foreignKeys', child, child].join(':')
  ]);
  try {
    const current = await s.prepare(capture);
    const desired = s.desired;
    const changes = compareSnapshots(current, desired).changes;
    const selected = changes.filter(change => targetChangeKeys.has(signature(change)));
    const ignored = changes.find(change => change.kind === 'drop-column' && change.table === parent && change.object === 'note');
    assert.equal(selected.length, targetChangeKeys.size);
    assert.ok(ignored);
    assert.equal(changes.length, selected.length + 1);
    const request = {current, desired, changeIds: selected.map(change => change.id), columnMappings: s.columnMappings};

    const before = await spring(false);
    const missingForeignKey = selected.filter(change => change.kind !== 'change-foreignKeys');
    await assert.rejects(service.previewSchemaRebuild({...request, changeIds: missingForeignKey.map(change => change.id)}),
      /foreign|dependency|referenc|affected/iu);
    await assert.rejects(service.previewSchemaRebuild({...request, tables: [parent]}), /select|table|scope/iu);
    await s.checkGraph(capture, false);

    const review = await service.previewSchemaRebuild(request);
    s.plans.push(review.plan);
    assert.deepEqual(review.plan.steps.map(step => step.table).sort(), [child, parent].sort());
    const parentStep = review.plan.steps.find(step => step.table === parent);
    assert.deepEqual(parentStep.after.columns.map(column => column.name), ['id', 'zone_id', F.names.to, 'note']);
    assert.ok(parentStep.common.includes('note'));
    assert.ok(parentStep.sourceColumns.includes('note'));
    assert.ok(review.plan.requiresDependencyChangeApproval);
    assert.equal(review.plan.atomicAcrossTables, false);
    request.changeIds.push(ignored.id);
    parentStep.after.columns = parentStep.after.columns.filter(column => column.name !== 'note');

    const applied = await service.applySchemaRebuild({...F.flags, reviewId: review.reviewId});
    assert.equal(applied.state, 'applied', JSON.stringify(applied));
    await s.checkGraph(capture, true);
    const after = await spring(true);
    assert.deepEqual(after, before);
    const afterSnapshot = await capture(s.scope);
    assert.deepEqual(compareSnapshots(afterSnapshot, desired).changes.map(signature), [signature(ignored)]);
    const recorded = await s.journal(review.plan.id);
    assert.ok(recorded.desired.tables.find(table => table.name === parent).columns.some(column => column.name === 'note'));
    assert.equal(JSON.stringify(recorded).includes(F.expected.parent[0][3]), false);

    await service.dispose();
    service = new MysqlService(config);
    const restored = await service.recoverSchemaRebuild({...F.flags, operationId: review.plan.id});
    assert.equal(restored.state, 'recovered', JSON.stringify(restored));
    await s.checkGraph(capture, false);
    const restoredJdbc = await spring(false);
    assert.deepEqual(restoredJdbc, before);
    const recoveredSnapshot = await capture(s.scope);
    assert.deepEqual(compareSnapshots(recoveredSnapshot, current).changes, []);
    const receipt = process.env.ROCKETBRAIN_SCHEMA_SELECTED_REBUILD_RECEIPT;
    if (receipt) await fs.writeFile(path.resolve(receipt), JSON.stringify({
      engine, version: before.version, before, after, restored: restoredJdbc,
      selectedChanges: [...targetChangeKeys].map(key => key.split(':')[0]).sort(),
      unselectedColumnKeptThroughApplyAndRecovery: true,
      selectedScopeImmuneToExternalMutation: true,
      dependencyRefusedBeforeApply: true,
      compositeIndexAndForeignKeyPreserved: true,
      unrelatedPeerAndNullValuesPreserved: true,
      storedProjectedTargetRecovered: true,
      atomicAcrossTables: false
    }, null, 2) + '\n', {flag: 'wx'});
  } finally {
    try {await service.dispose();}
    finally {await s.close();}
  }
});


test('actual selected rebuild installs and recovers a new foreign-key group on an existing table', {
  skip: !database || !runtime || !cpFile, timeout: 190000
}, async () => {
  const {config, engine} = await F.ownedConfig(database);
  const {javaHome} = JSON.parse(await fs.readFile(runtime, 'utf8'));
  const s = await F.fixture(config);
  let service = new MysqlService(config);
  const capture = scope => captureSchema(service, scope);
  try {
    const desired = await s.prepare(capture);
    await s.actor.query('ALTER TABLE ' + F.q(s.tables.child) + ' DROP FOREIGN KEY ' + F.q(s.constraint));
    const current = await capture(s.scope);
    const changes = compareSnapshots(current, desired).changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'change-foreignKeys');
    const requested = await service.previewSchemaRebuild({current, desired, changeIds: [changes[0].id]});
    s.plans.push(requested.plan);
    assert.equal(requested.plan.steps.length, 1);
    assert.equal(requested.plan.steps[0].table, s.tables.child);
    assert.ok(requested.plan.requiresDependencyChangeApproval);
    assert.equal(requested.plan.dependencies.before.foreignKeys.length, 0);
    assert.equal(requested.plan.dependencies.after.foreignKeys.length, 1);
    await assert.rejects(service.applySchemaRebuild({...F.flags, reviewId: requested.reviewId, allowDependencyChanges: false}),
      /dependenc|approve|fence/iu);
    const applied = await service.applySchemaRebuild({...F.flags, reviewId: requested.reviewId});
    assert.equal(applied.state, 'applied', JSON.stringify(applied));
    await s.checkGraph(capture, false);
    const spring = await F.springRead(s, {javaHome, cpFile, engine, projected: false});

    await service.dispose();
    service = new MysqlService(config);
    const recovered = await service.recoverSchemaRebuild({...F.flags, operationId: requested.plan.id});
    assert.equal(recovered.state, 'recovered', JSON.stringify(recovered));
    assert.deepEqual(compareSnapshots(await capture(s.scope), current).changes, []);
    await s.checkPeer();
    const receipt = process.env.ROCKETBRAIN_SCHEMA_SELECTED_REBUILD_NEW_FK_RECEIPT;
    if (receipt) await fs.writeFile(path.resolve(receipt), JSON.stringify({
      engine, version: spring.version, joined: spring.joined, newForeignKeyInstalled: true,
      missingDependencyApprovalRefused: true, freshRecoveryRemovedOnlyNewForeignKey: true
    }, null, 2) + '\n', {flag: 'wx'});
  } finally {
    try {await service.dispose();}
    finally {await s.close();}
  }
});
