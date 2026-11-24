'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { planEntity } = require('../src/jpa/entity-scaffold');
const { readForeignKeyTargetCatalog } = require('../src/db/metadata');

const database = 'fixture_main', outside = 'fixture_related', table = 'node', pkg = 'fixture.scoped';
const uri = name => 'file:///fixture/scoped/' + name + '.java';
const column = (name, ordinal, primaryKey, nullable) => ({ name, ordinal, type: 'bigint', primaryKey, nullable, extra: '', defaultValue: null });
const idx = (name, fields) => ({ name, primaryKey: name === 'PRIMARY', unique: true,
  columns: fields.map((name, index) => ({ name, ordinal: index + 1, prefixLength: null })) });
const fk = (name, target, local) => ({ name, referencedSchema: target, referencedTable: table,
  columns: [{ name: local, referencedColumn: 'id', ordinal: 1 }] });
const coverage = { tables: 'loaded', columns: 'loaded', indexes: 'loaded', foreignKeys: 'loaded' };

function scenario() {
  const source = { name: table, kind: 'table', engine: 'InnoDB', columns: [column('id', 1, true, false), column('parent_id', 2, false, true),
    column('remote_id', 3, false, true)], indexes: [idx('PRIMARY', ['id'])],
    foreignKeys: [fk('fk_parent', database, 'parent_id'), fk('fk_remote', outside, 'remote_id')] };
  const target = { name: table, kind: 'table', engine: 'InnoDB', columns: [column('id', 1, true, false)],
    indexes: [idx('PRIMARY', ['id'])], foreignKeys: [] };
  const catalog = { database, scope: 'database', coverage, tables: [source] };
  const targetCatalogs = [{ sourceDatabase: database, table, foreignKey: 'fk_remote', targetSchema: outside, targetTable: table,
    sourceColumns: [{ name: 'remote_id', ordinal: 1, referencedColumn: 'id' }],
    catalog: { database: outside, scope: 'table', selectedTable: table, coverage, tables: [target] } }];
  const targetSources = [{ uri: uri('RemoteNode'), text: `package ${pkg};
import jakarta.persistence.*;
@Entity @Table(name = "node", catalog = "${outside}")
public class RemoteNode {
    @Id @Column(name = "id") private Long id;
    public Long getId() { return id; }
}` }];
  const relationships = [
    { kind: 'selfReference', foreignKey: 'fk_parent', property: 'parentReference', mode: 'association' },
    { kind: 'crossSchemaAssociation', foreignKey: 'fk_remote', targetSchema: outside, targetTable: table,
      targetType: pkg + '.RemoteNode', targetUri: targetSources[0].uri, property: 'remoteReference', mode: 'scalar' }
  ];
  const plan = () => planEntity({ catalog, table, name: 'Node', packageName: pkg, uri: uri('Node'), relationships, targetCatalogs, targetSources });
  return { plan, source, target, targetCatalogs, targetSources, relationships };
}

test('self-reference binds the generated Java class and cross-schema joins use a separately proven catalog', () => {
  const { plan } = scenario();
  const { text, comparison, relationshipPlan } = plan();
  assert.match(text, /private fixture\.scoped\.Node parentReference;/);
  assert.match(text, /void setParentReference\(fixture\.scoped\.Node value\)/);
  assert.doesNotMatch(text, /private Long parentId/);
  assert.match(text, /private Long remoteId/);
  assert.match(text, /private fixture\.scoped\.RemoteNode remoteReference;/);
  assert.match(text, /name = "\\"remote_id\\"", referencedColumnName = "id", nullable = true, insertable = false, updatable = false/);
  assert.doesNotMatch(text, /setRemoteReference/);
  assert.equal(comparison.mismatches, 0);
  assert.deepEqual(relationshipPlan.relations.map(item => item.targetType), [pkg + '.Node', pkg + '.RemoteNode']);
});

test('scoped JPA relationships refuse a mismatched source, target catalog, foreign-key tuple and Java namespace', () => {
  for (const [edit, reason] of [
    [({ relationships }) => { relationships[0].foreignKey = 'fk_remote'; }, /self-reference must target/],
    [({ targetCatalogs }) => { targetCatalogs.length = 0; }, /same connection must prove/],
    [({ targetCatalogs }) => { targetCatalogs[0].sourceColumns[0].name = 'parent_id'; }, /same connection must prove/],
    [({ targetCatalogs }) => { targetCatalogs[0].sourceDatabase = 'different_database'; }, /same connection must prove/],
    [({ targetSources }) => { targetSources[0].text = targetSources[0].text.replace(', catalog = "' + outside + '"', ''); }, /explicit matching @Table/],
    [({ targetSources }) => { targetSources[0].text = targetSources[0].text.replace('catalog =', 'schema ='); }, /explicit matching @Table/],
    [({ target }) => { target.columns[0].type = 'int'; }, /compatible column names and Java types/]
  ]) {
    const fixture = scenario();
    edit(fixture);
    assert.throws(fixture.plan, reason);
  }
});

test('scoped JPA relationship fingerprint changes when target metadata changes', () => {
  const { plan, target } = scenario();
  const first = plan().relationshipPlan.fingerprint;
  target.columns[0].defaultValue = '1';
  assert.notEqual(plan().relationshipPlan.fingerprint, first);
});

function dictionary({ changed = false, wrongTable = false } = {}) {
  let reads = 0;
  const calls = [];
  const query = async (sql, values) => {
    calls.push({ sql, values });
    if (/SELECT TABLE_SCHEMA,/.test(sql)) {
      reads++;
      return { rows: [[database, table, 'fk_remote', changed && reads > 1 ? 'new_column' : 'remote_id', 1,
        outside, wrongTable ? 'other' : table, 'id']] };
    }
    assert.deepEqual(values, [outside, table]);
    assert.match(sql, /TABLE_NAME = \?/);
    if (/information_schema\.TABLES/.test(sql)) return { rows: [[table, 'BASE TABLE', 'InnoDB', null, null]] };
    if (/information_schema\.COLUMNS/.test(sql)) return { rows: [[table, 'id', 'bigint', 'NO', null, 'PRI', '', 1, null, null, null]] };
    if (/information_schema\.STATISTICS/.test(sql)) return { rows: [[table, 'PRIMARY', 0, 1, 'id', null, 'BTREE', 'A']] };
    if (/information_schema\.KEY_COLUMN_USAGE/.test(sql)) return { rows: [] };
    throw Error('Unexpected metadata lane');
  };
  const request = { table, foreignKey: 'fk_remote', targetSchema: outside, targetTable: table };
  return { calls, query, request };
}

test('cross-schema metadata inspects only the exact target table and brackets it with source FK checks', async () => {
  const { calls, query, request } = dictionary();
  const proof = await readForeignKeyTargetCatalog(query, database, request, 1);
  assert.equal(proof.catalog.scope, 'table');
  assert.equal(proof.catalog.database, outside);
  assert.equal(proof.catalog.selectedTable, table);
  assert.ok(proof.catalog.tables[0].indexes[0].primaryKey);
  assert.deepEqual(proof.sourceColumns, [{ name: 'remote_id', ordinal: 1, referencedColumn: 'id' }]);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0].values, [database, table, 'fk_remote']);
  assert.deepEqual(calls.at(-1).values, calls[0].values);
  const moved = dictionary({ changed: true });
  await assert.rejects(readForeignKeyTargetCatalog(moved.query, database, moved.request, 1), /changed during/);
  const other = dictionary({ wrongTable: true });
  await assert.rejects(readForeignKeyTargetCatalog(other.query, database, other.request, 1), /no longer proves/);
  assert.equal(other.calls.length, 1);
});
