'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {compareSnapshots, normalizeSnapshot} = require('../src/db/schema-diff');
const {makePlan, physicalShape, SchemaRecovery} = require('../src/db/schema-recovery');
const {projectSelectedRebuild, isSelectableRebuildChange} = require('../src/db/schema-rebuild-selection');
const {fixture, addColumn} = require('./helpers/schema-diff-fixture');

const normalize = value => normalizeSnapshot(value, {verifyFingerprint: false});

function fixturePair(dialect = 'mysql') {
  const current = addColumn(fixture({dialect}), 'note', {comment: 'retained metadata'});
  const parent = current.tables[0];
  const child = structuredClone(parent);
  child.name = 'members';
  child.createSql = 'CREATE TABLE members (id INT PRIMARY KEY) ENGINE=InnoDB';
  child.foreignKeys = [{name: 'fk_people', referencedSchema: current.database, referencedTable: 'people',
    onUpdate: 'CASCADE', onDelete: 'RESTRICT', columns: [{name: 'id', referencedColumn: 'id'}]}];
  current.tables.push(child);
  const proposed = structuredClone(current);
  proposed.database = proposed.server.database = 'proposed';
  proposed.tables[0].columns[0].name = 'person_id';
  proposed.tables[0].columns[0].type = 'bigint';
  proposed.tables[0].columns.splice(1, 1);
  proposed.tables[0].indexes[0].columns[0].name = 'person_id';
  proposed.tables[1].columns[0].type = 'bigint';
  proposed.tables[1].comment = 'unselected comment';
  proposed.tables[1].foreignKeys[0].referencedSchema = proposed.database;
  proposed.tables[1].foreignKeys[0].columns[0].referencedColumn = 'person_id';
  return {current: normalize(current), proposed: normalize(proposed)};
}

test('selects a complete mapped key change across tables and preserves the staged-out live definition', () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const {current, proposed} = fixturePair(dialect);
    const report = compareSnapshots(current, proposed);
    const chosen = report.changes.filter(change => change.object !== 'note' && change.kind !== 'change-table-options');
    assert.equal(chosen.length, 5);
    assert.ok(chosen.every(change => isSelectableRebuildChange(change, current, proposed)));
    const ids = chosen.map(change => change.id);
    const projection = projectSelectedRebuild(current, proposed, ids.reverse());
    const {desired, tables, changes} = projection;
    assert.deepEqual(changes, [...chosen].sort((left, right) => left.id < right.id ? -1 : 1));
    assert.deepEqual(tables, ['members', 'people']);
    const [child, parent] = desired.tables;
    assert.equal(child.comment, '');
    assert.equal(child.foreignKeys[0].referencedSchema, current.database);
    assert.deepEqual(child.foreignKeys[0].columns, [{name: 'id', referencedColumn: 'person_id', ordinal: 1}]);
    assert.deepEqual(parent.columns.map(column => column.name), ['person_id', 'note']);
    assert.deepEqual(parent.columns[1], current.tables[1].columns[1]);
    assert.deepEqual(projectSelectedRebuild(current, desired, ids).desired, desired);
    const plan = makePlan(current, desired, {tables, columnMappings: {people: [{from: 'id', to: 'person_id'}]}});
    assert.deepEqual(plan.steps[1].common, ['person_id', 'note']);
    assert.deepEqual(plan.steps[1].sourceColumns, ['id', 'note']);
  }
});

test('refuses malformed selection, omitted key changes and ambiguous database name mapping', () => {
  const {current, proposed} = fixturePair();
  const report = compareSnapshots(current, proposed);
  const chosen = report.changes.filter(change => change.object !== 'note' && change.kind !== 'change-table-options');
  const ids = chosen.map(change => change.id);
  const pick = excludedKind => chosen.filter(change => change.kind !== excludedKind).map(change => change.id);
  const rejected = value => assert.throws(() => projectSelectedRebuild(current, proposed, value),
    error => error.code === 'ROCKETBRAIN_REBUILD_SELECTION');
  for (const value of [null, [], Array(1), ['bad'], [ids[0], ids[0]], ['e'.repeat(24)], pick('change-index'),
    pick('change-foreignKeys'), [report.changes.find(change => change.kind === 'change-table-options').id]]) rejected(value);
  const external = structuredClone(proposed);
  external.tables[0].foreignKeys[0].referencedSchema = current.database;
  assert.throws(() => projectSelectedRebuild(current, normalize(external), ids), /external foreign-key reference/);
});

test('keeps live order across rejected desired reordering and validates selected dependency edges', () => {
  const current = addColumn(addColumn(fixture(), 'left'), 'right');
  const proposed = structuredClone(current);
  proposed.tables[0].columns = proposed.tables[0].columns.map((column, index) =>
    ({...column, ordinal: [1, 3, 2][index], comment: index ? 'edited' : ''}));
  const reordered = normalize(proposed);
  const ids = compareSnapshots(current, reordered).changes.filter(change => change.kind === 'change-column')
    .map(change => change.id);
  const projection = projectSelectedRebuild(current, reordered, ids);
  assert.deepEqual(projection.desired.tables[0].columns.map(column => column.name), ['id', 'left', 'right']);
  const replay = projectSelectedRebuild(current, projection.desired, ids);
  assert.deepEqual(replay.desired, projection.desired);
  assert.deepEqual(replay.changes.map(change => change.id), projection.changes.map(change => change.id));

  const additional = addColumn(addColumn(structuredClone(current), 'first_new'), 'second_new');
  const additions = compareSnapshots(current, additional).changes;
  assert.throws(() => projectSelectedRebuild(current, additional, [additions[1].id]), /dependency changes together/);
  assert.deepEqual(projectSelectedRebuild(current, additional, additions.map(change => change.id)).desired.tables[0]
    .columns.map(column => column.name), ['id', 'left', 'right', 'first_new', 'second_new']);
});

test('service rejects mismatched explicit rebuild tables before starting a session', async () => {
  const recovery = new SchemaRecovery({});
  recovery._idle = () => {};
  recovery.transport._withSession = () => assert.fail('No session may start for mismatched table selection.');
  const {current, proposed} = fixturePair();
  const changeIds = compareSnapshots(current, proposed).changes.filter(change => change.object !== 'note' &&
    change.kind !== 'change-table-options').map(change => change.id);
  for (const tables of [[], ['people'], ['members', 'people', 'people'], Array(2)]) {
    await assert.rejects(recovery.preview({current, desired: proposed, changeIds, tables}), /must match/);
  }
  for (const conversions of [{people: [{column: 'note', strategy: 'web-mercator-forward'}]},
    {members: [{column: 'note', strategy: 'exact'}]}, {members: Array(1)}, {other: []}]) {
    await assert.rejects(recovery.preview({current, desired: proposed, changeIds, conversions}), /conversion rules/iu);
  }
});

test('case-only index name changes require both catalog IDs before a session', async () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const currentValue = addColumn(fixture({dialect}), 'note');
    currentValue.tables[0].indexes.push({name: 'logical_idx', unique: false, primaryKey: false, type: 'BTREE',
      columns: [{name: 'note', ordinal: 1, prefixLength: null, collation: 'A'}]});
    const current = normalize(currentValue);
    const proposedValue = structuredClone(current);
    proposedValue.tables[0].indexes.find(index => index.name === 'logical_idx').name = 'LOGICAL_IDX';
    const proposed = normalize(proposedValue);
    const changes = compareSnapshots(current, proposed).changes;
    assert.deepEqual(changes.map(change => change.kind), ['add-index', 'drop-index']);
    const recovery = new SchemaRecovery({});
    recovery._idle = () => {};
    recovery.transport._withSession = () => assert.fail('No session may start for a one-sided index rename.');
    for (const change of changes) {
      await assert.rejects(recovery.preview({current, desired: proposed, changeIds: [change.id]}), /case-only name change/);
    }
    const target = projectSelectedRebuild(current, proposed, changes.map(change => change.id)).desired;
    assert.deepEqual(target.tables[0].indexes.map(index => index.name), ['LOGICAL_IDX', 'PRIMARY']);
  }
});

test('retained generated values cannot depend on an unselected recomputation', async () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const amount = addColumn(fixture({dialect}), 'amount', {type: 'decimal(9,3)', charset: null, collation: null});
    const current = addColumn(amount, 'twice', {type: 'decimal(10,3)', charset: null, collation: null,
      extra: dialect === 'mariadb' ? 'PERSISTENT GENERATED' : 'STORED GENERATED', generationExpression: 'amount * 2'});
    const target = structuredClone(current);
    target.tables[0].columns[1].type = 'decimal(9,2)';
    const desired = normalize(target);
    const changeIds = compareSnapshots(current, desired).changes.map(change => change.id);
    const recovery = new SchemaRecovery({});
    recovery._idle = () => {};
    recovery.transport._withSession = () => assert.fail('No session may start if an unchanged generated value can change.');
    await assert.rejects(recovery.preview({current, desired, changeIds,
      conversions: {people: [{column: 'amount', strategy: 'decimal-quantize', onLoss: 'truncate'}]}}),
    /affected generated-column change/iu);

    target.tables[0].columns[2].generationExpression = 'amount * 3';
    const both = normalize(target);
    const selected = compareSnapshots(current, both).changes.map(change => change.id);
    const next = Error('entered session after exact combined validation');
    recovery.transport._withSession = () => { throw next; };
    await assert.rejects(recovery.preview({current, desired: both, changeIds: selected,
      conversions: {people: [{column: 'amount', strategy: 'decimal-quantize', onLoss: 'truncate'}]}}),
    error => error === next);
  }
});

test('selected recovery binds its schema, scope and dependency owner and checks physical storage', async () => {
  const current = fixture();
  const desired = addColumn(structuredClone(current), 'added');
  const changeIds = compareSnapshots(current, desired).changes.map(change => change.id);
  const recovery = new SchemaRecovery({_options: {database: current.database}});
  recovery._idle = () => {};
  recovery.transport._withSession = run => run({});
  recovery._capture = async () => current;
  recovery._inspectDependencies = async () => {
    const empty = {foreignKeys: [], views: [], triggers: []};
    const bundle = {format: 'RocketbrainSchemaDependencies', formatVersion: 2, database: current.database,
      currentUser: current.server.currentUser, selected: ['people'], lockTables: [], before: empty, after: empty};
    return {...bundle, fingerprint: createHash('sha256').update(JSON.stringify(bundle)).digest('hex')};
  };
  recovery._storedDependencies = async () => [];
  recovery._table = async () => null;
  const {reviewId} = await recovery.preview({current, desired, changeIds});
  const saved = recovery.reviews.get(reviewId);
  const receipt = {format: 'RocketbrainSchemaRecovery', id: reviewId, ...structuredClone(saved)};
  assert.equal(recovery._validRecord(receipt, reviewId), receipt);
  for (const corrupt of [
    plan => { plan.database = 'other'; },
    plan => { plan.scope = {kind: 'selected-tables', tables: ['people']}; },
    plan => {
      plan.dependencies.database = 'other';
      delete plan.dependencies.fingerprint;
      plan.dependencies.fingerprint = createHash('sha256').update(JSON.stringify(plan.dependencies)).digest('hex');
    },
    plan => { plan.formatVersion = 3; }
  ]) {
    const changed = structuredClone(receipt);
    corrupt(changed.plan);
    assert.throws(() => recovery._validRecord(changed, reviewId), {code: 'ROCKETBRAIN_REBUILD_JOURNAL'});
  }
  const original = current.tables[0];
  const changedStorage = {...original, rowFormat: 'Compact'};
  assert.deepEqual(physicalShape(original), physicalShape(changedStorage));
  assert.notDeepEqual(physicalShape(original, saved.plan), physicalShape(changedStorage, saved.plan));
});
