'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const AST = require('../src/db/schema-trigger-ast');
const graph = require('../src/db/schema-dependency-graph');
const {SchemaRecovery} = require('../src/db/schema-recovery');
const {compareSnapshots, normalizeSnapshot} = require('../src/db/schema-diff');
const {fixture, addColumn} = require('./helpers/schema-diff-fixture');
const {assertOrdinaryTriggerSource, projectMappedTriggers, validateObservedTriggerPhase} =
  require('../src/db/schema-mapped-triggers');

const mapping = {people: [{from: 'note', to: 'headline'}]};
const sqlMode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES';
const q = AST.q;

function actor(name, source, {table = 'people', timing = 'BEFORE', order = 1, schema = 'one'} = {}) {
  return {schema, name, table, timing, event: 'UPDATE', sqlMode, definer: 'fixture@localhost',
    charset: 'utf8mb4', collation: 'utf8mb4_bin', databaseCollation: 'utf8mb4_bin', order,
    ast: AST.parse(source, schema, table, {sqlMode})};
}

function observedRow(trigger, source = AST.render(trigger.ast)) {
  return [trigger.name, trigger.table, trigger.timing, trigger.event, source, trigger.sqlMode, trigger.definer,
    trigger.charset, trigger.collation, trigger.databaseCollation, trigger.order, trigger.schema];
}

function showCreate(trigger, {event = trigger.event, definer = q('fixture') + '@' + q('localhost'),
  body = AST.render(trigger.ast)} = {}) {
  return [[trigger.name, trigger.sqlMode, 'CREATE DEFINER=' + definer + ' TRIGGER ' + q(trigger.schema) + '.' + q(trigger.name) +
    ' ' + trigger.timing + ' ' + event + ' ON ' + q(trigger.table) + ' FOR EACH ROW ' + body]];
}

const first = actor('fix_note', "BEGIN DECLARE note VARCHAR(32) DEFAULT 'NEW.note'; " +
  'IF OLD.note = NEW.note THEN SET NEW.note=COALESCE(NEW.note,note); END IF; END');
const sibling = actor('fix_tag', "SET NEW.tag=COALESCE(NEW.tag,'OLD.note')", {order: 2});
const audit = actor('log_note', 'INSERT INTO one.audit_notes (logged) VALUES (OLD.note)', {timing: 'AFTER'});

test('rebinds exact OLD and NEW tokens while preserving literals, locals, audit target and sibling order', () => {
  const input = [audit, first, sibling];
  const [mappedAudit, mappedFirst, preserved] = projectMappedTriggers({database: 'one', columnMappings: mapping}, input);
  assert.deepEqual(mappedFirst.ast.locals, ['note']);
  assert.match(AST.render(mappedFirst.ast), /OLD \. `headline` = NEW \. `headline`/u);
  assert.match(AST.render(mappedFirst.ast), /SET NEW\.`headline`/u);
  assert.match(AST.render(mappedFirst.ast), /'NEW.note'/u);
  assert.match(AST.render(mappedAudit.ast), /OLD \. `headline`/u);
  assert.deepEqual(mappedAudit.ast.targets, audit.ast.targets);
  assert.equal(preserved, sibling);
  assert.deepEqual([mappedAudit.order, mappedFirst.order, preserved.order], [1, 1, 2]);
  assert.match(AST.render(first.ast), /SET NEW\.`note`/u);
  assert.doesNotThrow(() => assertOrdinaryTriggerSource(showCreate(first), first));
});

test('refuses noncanonical header, opaque or cross-schema targets, and an opt-in with no affected binding', () => {
  const plan = {database: 'one', columnMappings: mapping};
  for (const header of [{event: 'UPDATE OF note'}, {event: 'UPDATE OR INSERT'}, {definer: 'unrelated@localhost'}]) {
    assert.throws(() => assertOrdinaryTriggerSource(showCreate(first, header), first), /exact ordinary trigger/u);
  }
  for (const trigger of [
    actor('other_schema', 'SET NEW.note=OLD.note', {schema: 'outside'}),
    actor('mapped_target', 'INSERT INTO one.people (note) VALUES(NEW.note)', {table: 'audit_notes', timing: 'AFTER'}),
    actor('call_procedure', 'CALL one.inspect_trigger(NEW.note)')
  ]) {
    assert.throws(() => projectMappedTriggers(plan, [first, trigger]), /statically bound/u);
  }
  assert.throws(() => projectMappedTriggers(plan, [sibling]), /no observed NEW or OLD/u);
  const compound = actor('comparison', 'IF OLD.note <> NEW.note THEN SET NEW.note=OLD.note; END IF');
  assert.throws(() => assertOrdinaryTriggerSource(showCreate(compound), compound), /compound SQL token/u);
  assert.throws(() => projectMappedTriggers(plan, [compound]), /compound SQL token/u);
});

test('refuses trigger function spellings whose rendered whitespace can alter their binding', () => {
  const plan = {database: 'one', columnMappings: mapping};
  for (const expression of ['CAST(OLD.note AS CHAR)', 'NOW()', 'SUBSTR(OLD.note,1,4)',
    'SUBSTRING(OLD.note,1,4)', 'TRIM(OLD.note)', 'substring (OLD.note,1,4)']) {
    const before = 'SET NEW.note=' + expression;
    const trigger = actor('sensitive', before);
    for (const mode of [sqlMode, sqlMode + ',IGNORE_SPACE']) {
      const observed = {...trigger, sqlMode: mode};
      assert.throws(() => assertOrdinaryTriggerSource(showCreate(observed, {body: before}), observed),
        /whitespace-sensitive trigger function/u);
      assert.throws(() => projectMappedTriggers(plan, [observed]), /whitespace-sensitive trigger function/u);
    }
  }
});

test('retains ordinary INTERVAL tokens while refusing fused literals and conditional comments', () => {
  const interval = 'SET NEW.note=OLD.note + INTERVAL 1 DAY';
  const trigger = actor('interval_test', interval);
  assert.doesNotThrow(() => assertOrdinaryTriggerSource(showCreate(trigger, {body: interval}), trigger));
  const [after] = projectMappedTriggers({database: 'one', columnMappings: mapping}, [trigger]);
  assert.match(AST.render(after.ast), /INTERVAL 1 DAY/u);
  for (const expression of ['OLD.note + INTERVAL 1DAY', '0xAB', "X'AB'", "B'01'", "_utf8mb4'NEW.note'", '.5', '1.']) {
    const body = 'SET NEW.note=' + expression;
    const observed = actor('literal_test', body);
    assert.throws(() => assertOrdinaryTriggerSource(showCreate(observed, {body}), observed), /compound SQL token/u);
  }
  assert.throws(() => actor('comment_test', "SET NEW.note=/*!80000 'NEW.note' */ OLD.note"), /comments/iu);
  assert.throws(() => actor('qualified_function', 'SET NEW.note=one.COALESCE(OLD.note,NEW.note)'),
    /qualified stored functions/iu);
});

function mockedCatalog(dialect) {
  const initial = addColumn(addColumn(fixture({dialect}), 'note'), 'tag');
  const copiedAudit = structuredClone(initial.tables[0]);
  copiedAudit.name = 'audit_notes';
  copiedAudit.columns = [copiedAudit.columns[0], {...copiedAudit.columns[1], name: 'logged'}];
  const normalize = snapshot => normalizeSnapshot(snapshot, {verifyFingerprint: false});
  const current = normalize({...initial, tables: [...initial.tables, copiedAudit]});
  const proposed = structuredClone(current);
  const note = proposed.tables.find(table => table.name === 'people').columns.find(column => column.name === 'note');
  note.name = 'headline';
  note.type = 'varchar(60)';
  const desired = normalize(proposed);
  const selected = compareSnapshots(current, desired).changes.map(change => change.id);
  const actorList = [audit, first, sibling];
  const reads = [];
  const recovery = new SchemaRecovery({_options: {database: current.database}});
  recovery._idle = () => {};
  recovery.transport._withSession = use => use({});
  recovery.transport._read = async (_session, sql, values) => {
    reads.push(sql);
    if (sql === 'SHOW GRANTS') return [["GRANT SELECT, SHOW VIEW, TRIGGER ON *.* TO 'fixture'@'localhost'"]];
    if (sql.includes('FROM information_schema.TRIGGERS')) return actorList.map(trigger => observedRow(trigger));
    if (sql.startsWith('SHOW CREATE TRIGGER ')) return showCreate(actorList.find(trigger => sql.endsWith('.' + q(trigger.name))));
    if (sql.includes('FROM information_schema.SCHEMATA')) return [['utf8mb4_bin']];
    if (sql.includes('FROM information_schema.TABLES')) return current.tables.map(table => ['one', table.name, 'BASE TABLE']);
    if (['KEY_COLUMN_USAGE', 'VIEWS', 'ROUTINES', 'INNODB_FOREIGN', 'INNODB_SYS_FOREIGN'].some(name =>
      sql.includes('information_schema.' + name))) return [];
    assert.fail('Unexpected mock catalog query ' + sql + ' with ' + JSON.stringify(values));
  };
  recovery._capture = async () => current;
  recovery._table = async (_session, target) => current.tables.find(table => table.name === target?.table);
  recovery._dependencyEnvironment = async () => {};
  recovery._storedDependencies = async () => [];
  return {recovery, reads, input: {current, desired, columnMappings: mapping, changeIds: selected, mapTriggerColumns: true}};
}

test('real recovery pipeline previews both dialect shapes, separates phase SQL and revalidates a journal offline', async () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const {recovery, reads, input} = mockedCatalog(dialect);
    const prepared = await recovery.preview(input);
    const plan = prepared.plan;
    assert.equal(plan.formatVersion, 9);
    assert.equal(plan.mapTriggerColumns, true);
    assert.deepEqual(plan.steps[0].sourceColumns, ['id', 'note', 'tag']);
    assert.equal(plan.requiresDependencyChangeApproval, true);
    assert.ok(reads.every(sql => /^(SELECT|SHOW) /u.test(sql)));
    const originals = graph.createActions(plan.dependencies, 'before');
    const replacements = graph.createActions(plan.dependencies, 'after');
    const shadow = graph.validationActions({id: plan.id, plan});
    assert.deepEqual(replacements.map(action => action.name), originals.map(action => action.name));
    assert.match(originals.find(action => action.name === first.name).sql, /SET NEW\.`note`/u);
    assert.match(replacements.find(action => action.name === first.name).sql, /SET NEW\.`headline`/u);
    assert.match(shadow[1].sql, /SET NEW\.`headline`/u);
    assert.match(plan.sql, /-- Guarded original-definition recovery:/u);
    assert.match(plan.sql, /-- RECOVERY CREATE DEFINER=CURRENT_USER TRIGGER/u);
    const record = {format: 'RocketbrainSchemaRecovery', id: plan.id, ...structuredClone(recovery.reviews.get(prepared.reviewId))};
    assert.equal(recovery._validRecord(record, plan.id), record);
    const originalRows = plan.dependencies.before.triggers.map(trigger => observedRow(trigger));
    assert.doesNotThrow(() => validateObservedTriggerPhase(plan.dependencies, 'before', originalRows));
    assert.throws(() => validateObservedTriggerPhase(plan.dependencies, 'after', originalRows), /reviewed phase/u);
    assert.throws(() => validateObservedTriggerPhase(plan.dependencies, 'before', [...originalRows].reverse()), /relative action order/u);
    const altered = structuredClone(record);
    const deps = altered.plan.dependencies;
    deps.after.triggers = deps.before.triggers;
    delete deps.fingerprint;
    deps.fingerprint = createHash('sha256').update(JSON.stringify(deps)).digest('hex');
    assert.throws(() => recovery._validRecord(altered, plan.id), /dependency phases differ/u);
    assert.throws(() => recovery._validRecord({...record, plan: {...record.plan, formatVersion: 6}}, plan.id),
      /approval or recovery format changed/u);
  }
});

test('keeps the guarded migration opt-in explicit and refuses legacy unmapped trigger combinations', async () => {
  const {recovery, input, reads} = mockedCatalog('mysql');
  await assert.rejects(recovery.preview({...input, mapTriggerColumns: 'true'}), /explicit boolean/u);
  await assert.rejects(recovery.preview({...input, columnMappings: undefined}), /requires selected table changes/u);
  assert.deepEqual(reads, []);
  await assert.rejects(recovery.preview({...input, mapTriggerColumns: false}), /trigger row expression|NEW assignment/u);
});
