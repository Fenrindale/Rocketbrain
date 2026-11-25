'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSnapshots, normalizeSnapshot, planMigration, captureSchema } = require('../src/db/schema-diff');
const { normalizeStored } = require('../src/db/schema-stored-diff');
const { definition } = require('../src/db/schema-diff-options');
const { fixture, addColumn } = require('./helpers/schema-diff-fixture');

const exact = { identifierCase: 'exact', definer: 'include' };
const fold = { ...exact, identifierCase: 'ascii-insensitive' };
const ignoreOwner = { ...exact, definer: 'ignore' };
const both = { ...fold, definer: 'ignore' };
const normalize = value => normalizeSnapshot(value, { verifyFingerprint: false });
const relabel = (table, name) => ({ ...structuredClone(table), name, createSql: table.createSql.replace('`'+table.name+'`', '`'+name+'`') });

test('review-only exact and ASCII-folded choices pair proven names without changing selected SQL authorization', () => {
  const current = addColumn(fixture(), 'CODE');
  current.tables[0].createSql = "CREATE TABLE `PEOPLE` (`id` int NOT NULL, `CODE` varchar(30) COMMENT 'Literal CASE', PRIMARY KEY (`id`)) ENGINE=InnoDB";
  current.tables[0].name = 'PEOPLE';
  const desired = structuredClone(current);
  desired.tables[0] = relabel(desired.tables[0], 'people');
  desired.tables[0].columns[1].name = 'code';
  desired.tables[0].createSql = desired.tables[0].createSql.replace('`CODE`', '`code`');
  const before = normalize(current), after = normalize(desired);
  assert.equal(compareSnapshots(before, after, exact).summary.changes, 2);
  const projected = compareSnapshots(before, after, fold);
  assert.equal(projected.summary.changes, 0);
  assert.equal(projected.currentFingerprint, before.fingerprint);
  assert.equal(projected.desiredFingerprint, after.fingerprint);
  assert.deepEqual(projected.foldedPairs, [{ current: 'PEOPLE', desired: 'people' }]);
  assert.deepEqual(projected.definitionPairs.map(({ current, desired }) => [current, desired]), [['PEOPLE', 'people']]);

  const wanted = addColumn(fixture());
  const ordinary = compareSnapshots(fixture(), wanted).changes[0];
  const proposed = compareSnapshots(fixture(), wanted, exact).changes[0];
  assert.equal(ordinary.selectable, true);
  assert.equal(proposed.selectable, false);
  assert.notEqual(ordinary.id, proposed.id);
  assert.equal(proposed.sql, undefined);
  assert.throws(() => planMigration(fixture(), wanted, { changeIds: [proposed.id] }), /not supported/u);
  assert.equal(planMigration(fixture(), wanted, { changeIds: [ordinary.id] }).steps.length, 1);
});

test('case collisions stay ambiguous and do not hide foreign keys pointing to different physical tables', () => {
  const current = fixture(), desired = fixture();
  for (const snapshot of [current, desired]) {
    snapshot.tables.push(relabel(snapshot.tables[0], 'PEOPLE'), relabel(snapshot.tables[0], 'other'));
    snapshot.tables.find(table => table.name === 'other').foreignKeys = [{ name: 'fk', referencedSchema: snapshot.database,
      referencedTable: snapshot === current ? 'PEOPLE' : 'people', onUpdate: 'RESTRICT', onDelete: 'RESTRICT',
      columns: [{ name: 'id', referencedColumn: 'id', ordinal: 1 }] }];
  }
  const before = normalize(current), after = normalize(desired), report = compareSnapshots(before, after, both);
  assert.equal(report.caseCollisions, 1);
  assert.ok(report.changes.some(change => change.kind === 'change-foreignKeys' && change.table === 'other'));
  assert.deepEqual(report.changes.find(change => change.kind === 'ambiguous-identifier-case').before,
    [{ name: 'PEOPLE', kind: 'table' }, { name: 'people', kind: 'table' }]);
  assert.equal(report.definitionPairs.some(pair => pair.current === 'PEOPLE' || pair.current === 'people'), false);
  assert.equal(report.currentServer.tableNameCaseSensitive, true);
  assert.equal(compareSnapshots(before, after, ignoreOwner).caseCollisions, 0);
});

test('ASCII folding preserves Unicode and refuses to infer names from a partial table selection', () => {
  const base = fixture();
  const current = fixture({ tables: [relabel(base.tables[0], 'ÉTable')] });
  const desired = fixture({ tables: [relabel(base.tables[0], 'étable')] });
  assert.equal(compareSnapshots(current, desired, fold).summary.changes, 2);
  base.scope = { kind: 'selected-tables', tables: ['people'] };
  const selection = normalize(base);
  assert.throws(() => compareSnapshots(selection, selection, fold), /complete account-visible database/u);
  assert.throws(() => compareSnapshots(selection, selection, { ...exact, apply: true }), /Choose exact/u);
  assert.equal(compareSnapshots(selection, selection, ignoreOwner).summary.changes, 0);
});

test('only a recognized CREATE header may project DEFINER or a declaration name; bodies and SQL SECURITY remain exact', () => {
  const source = "CREATE ALGORITHM=UNDEFINED DEFINER=`my``user`@`localhost` SQL SECURITY DEFINER VIEW `CaseView` AS SELECT 'DEFINER=Different' AS test";
  const object = { name: 'CaseView', kind: 'view' };
  assert.equal(definition(object, source, exact).source, source);
  assert.equal(definition(object, source, both).source,
    "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `caseview` AS SELECT 'DEFINER=Different' AS test");
  const executableHeader = '/*!50013 ' + source + ' */';
  assert.deepEqual(definition(object, executableHeader, both), { source: executableHeader, headerObserved: false });
  assert.equal(definition({ ...object, name: 'other' }, source, both).source, source);

  const current = addColumn(fixture(), 'NOTE');
  current.tables[0].createSql = "CREATE TABLE `people` (`id` int NOT NULL, `NOTE` varchar(30) COMMENT 'quoted `NOTE` and (,)\nstill a literal', PRIMARY KEY (`id`))";
  const changed = structuredClone(current);
  changed.tables[0].columns[1].name = 'note';
  changed.tables[0].createSql = changed.tables[0].createSql.replaceAll('`NOTE`', '`note`');
  assert.equal(compareSnapshots(normalize(current), normalize(changed), both).changes[0].kind, 'change-object-definition');
});

test('projected stored comparison keeps raw account source and reports collisions and withheld definitions', () => {
  function snapshot(definer, name) {
    const value = fixture();
    value.storedObjects = normalizeStored({ formatVersion: 1, scope: 'account-visible',
      coverage: { procedure: 'loaded', function: 'loaded', trigger: 'loaded', event: 'loaded' },
      objects: [{ kind: 'procedure', name, state: 'observed', definition: `CREATE DEFINER=\`${definer}\`@\`localhost\` PROCEDURE \`${name}\`() SELECT 1`,
        settings: { sql_mode: '', character_set_client: 'utf8mb4', collation_connection: 'utf8mb4_bin', 'database collation': 'utf8mb4_bin' } },
      { kind: 'function', name: 'hidden', state: 'withheld' }] }, value.server, { verifyFingerprint: false });
    return value;
  }
  const current = snapshot('first', 'MiXeD'), desired = snapshot('second', 'mixed');
  const compared = compareSnapshots(current, desired, both);
  assert.equal(compared.storedObjects.matchedByOptions, 1);
  assert.equal(compared.storedObjects.differences[0].state, 'definition-unavailable');
  assert.equal(compareSnapshots(current, desired, fold).storedObjects.differences.find(change => change.kind === 'procedure').before.definition.includes('`first`'), true);
  current.storedObjects.objects.push(desired.storedObjects.objects.find(object => object.kind === 'procedure'));
  const collision = compareSnapshots(normalize(current), desired, both).storedObjects.differences.find(change => change.kind === 'procedure');
  assert.equal(collision.state, 'ambiguous-identifier-case');
  assert.deepEqual(collision.currentNames, ['MiXeD', 'mixed']);
  assert.equal(collision.before, null);
});

test('catalog capture uses exact qualified metadata predicates for physical case-sensitive lookup', async () => {
  const calls = [];
  let mode = 0;
  const db = { async _metadataQuery(sql, values) {
    calls.push(sql);
    const rows = sql.startsWith('SELECT VERSION()') ? [['8.4.13', 'loopback', 3306, 1, mode, '', 'fixture@localhost', 'one']]
      : sql.includes('@@server_uuid') ? [['owned-server']]
      : sql.startsWith('SELECT TABLE_NAME') ? [...(mode === 0 ? [['PEOPLE', 'BASE TABLE']] : []), ['people', 'BASE TABLE']]
      : sql.startsWith('SELECT t.TABLE_NAME') ? [[values[1], 'BASE TABLE', 'InnoDB', 'utf8mb4_bin', '', 'Dynamic', '', 'utf8mb4']]
      : sql.startsWith('SELECT COLUMN_NAME') ? [[values[1] === 'PEOPLE' ? 'upper_id' : 'lower_id', 'int', 'NO', null, '', '', 1, '', null, null, '']]
      : sql.startsWith('SHOW CREATE') ? [['', sql.replace('SHOW CREATE TABLE `one`.', 'CREATE TABLE ') + ' (`id` int) ENGINE=InnoDB']]
      : [];
    return { rows };
  } };
  const value = await captureSchema(db);
  assert.deepEqual(value.tables.map(table => [table.name, table.columns[0].name]), [['PEOPLE', 'upper_id'], ['people', 'lower_id']]);
  const catalog = calls.filter(sql => sql.includes('information_schema.'));
  assert.ok(catalog.every(sql => /BINARY (?:t\.|tc\.|k\.)?TABLE_SCHEMA=BINARY \?/u.test(sql)));
  assert.ok(catalog.filter(sql => !sql.startsWith('SELECT TABLE_NAME,TABLE_TYPE')).every(sql => /BINARY (?:t\.|tc\.|k\.)?TABLE_NAME=BINARY \?/u.test(sql)));
  for (mode of [1, 2]) {
    calls.length = 0;
    const scoped = await captureSchema(db, { tables: ['people'] });
    assert.equal(scoped.server.tableNameCaseSensitive, false);
    assert.ok(calls.some(sql => sql.includes('TABLE_SCHEMA=? AND TABLE_NAME IN (?)')));
    assert.ok(calls.filter(sql => sql.includes('information_schema.')).every(sql => !sql.includes('BINARY ')));
  }
});
