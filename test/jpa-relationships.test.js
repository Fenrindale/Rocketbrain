'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { planEntity } = require('../src/jpa/entity-scaffold');
const { targetDeclarations } = require('../src/jpa/entity-relationships');

const database = 'fixture_schema';
const pkg = 'fixture.generated';
const owner = 'OwningEntity';
const cols = names => names.map((name, index) => ({ name, ordinal: index + 1, prefixLength: null }));
const idx = (name, names, unique = true) => ({ name, unique, primaryKey: name === 'PRIMARY', columns: cols(names) });
const fk = (name, referencedTable, field, references) => ({ name, referencedTable, referencedSchema: database,
  columns: field.map((key, index) => ({ name: key, ordinal: index + 1, referencedColumn: references[index] })) });
const relation = (foreignKey, targetName, property, mode) => ({ foreignKey, targetUri: 'file:///fixture/' + targetName + '.java',
  targetType: pkg + '.' + targetName, property, mode });

function table(name, fields, keys, foreignKeys = [], indexes = []) {
  const columns = fields.map(([name, type, nullable = false], index) => ({ name, type, nullable, ordinal: index + 1,
    primaryKey: keys.includes(name), defaultValue: null, extra: '' }));
  return { name, kind: 'table', engine: 'InnoDB', columns, indexes: [idx('PRIMARY', keys), ...indexes], foreignKeys };
}

function scenario() {
  const simple = table('customer', [['id', 'bigint']], ['id']);
  const composite = table('product', [['entry_id', 'bigint'], ['tenant_id', 'int(11)']], ['tenant_id', 'entry_id']);
  const ownerTable = table('sale_entry', [['id', 'bigint'], ['customer_id', 'bigint', true], ['sku_tenant', 'int'], ['sku_entry', 'bigint']],
    ['id'], [fk('fk_customer', simple.name, ['customer_id'], ['id']), fk('fk_product', composite.name, ['sku_tenant', 'sku_entry'], ['tenant_id', 'entry_id'])],
    [idx('uq_sku', ['sku_entry', 'sku_tenant']), idx('ix_customer', ['customer_id'], false)]);
  const catalog = { database, scope: 'database', coverage: { tables: 'loaded', columns: 'loaded', indexes: 'loaded', foreignKeys: 'loaded' },
    tables: [simple, composite, ownerTable] };
  const source = (name, selected) => ({ uri: 'file:///fixture/' + name + '.java',
    text: planEntity({ catalog, table: selected, name, packageName: pkg, uri: 'file:///fixture/' + name + '.java' }).text });
  const targetSources = [source('Customer', 'customer'), source('Product', 'product')];
  const relationships = [relation('fk_customer', 'Customer', 'customerReference', 'association'), relation('fk_product', 'Product', 'productReference', 'scalar')];
  const plan = () => planEntity({ catalog, table: ownerTable.name, name: owner, packageName: pkg,
    uri: 'file:///fixture/OwningEntity.java', relationships, targetSources });
  return { plan, catalog, ownerTable, targetSources, relationships };
}

test('end-to-end JPA generation emits explicit composite no-write joins and an ordinary association-owned foreign key', () => {
  const { plan, targetSources } = scenario();
  const result = plan();
  assert.deepEqual(targetDeclarations(targetSources[0]), [{ table: 'customer', targetType: pkg + '.Customer', targetUri: targetSources[0].uri }]);
  assert.match(result.text, /@ManyToOne\(fetch = FetchType\.LAZY, optional = true\)/);
  assert.match(result.text, /void setCustomerReference\(fixture\.generated\.Customer value\)/);
  assert.doesNotMatch(result.text, /private Long customerId|setCustomerId/);
  assert.match(result.text, /@OneToOne\(fetch = FetchType\.LAZY, optional = false\)/);
  assert.match(result.text, /@JoinColumns\(\{/);
  assert.match(result.text, /referencedColumnName = "\\"tenant_id\\"", nullable = false, insertable = false, updatable = false/);
  assert.match(result.text, /private Long skuEntry/);
  assert.doesNotMatch(result.text, /setProductReference/);
  assert.equal(result.comparison.mismatches, 0);
  assert.deepEqual(result.relationshipPlan.relations[1].columns.map(column => column.name), ['sku_tenant', 'sku_entry']);
});

test('relationship cardinality is proven only by an exact non-prefix unique index, and its change invalidates the relationship fingerprint', () => {
  const { plan, ownerTable } = scenario();
  const initial = plan();
  ownerTable.indexes[1].columns[0].prefixLength = 1;
  const refreshed = plan();
  assert.equal(refreshed.relationshipPlan.relations[1].cardinality, 'ManyToOne');
  assert.equal(initial.mapping.fingerprint, refreshed.mapping.fingerprint);
  assert.notEqual(initial.relationshipPlan.fingerprint, refreshed.relationshipPlan.fingerprint);
});

test('relationship scaffolding requires explicit matches and refuses uncovered, cross-catalog and overlapping foreign keys', () => {
  const trial = (change, expected) => {
    const data = scenario();
    change(data);
    assert.throws(data.plan, expected);
  };
  trial(({ catalog }) => { catalog.coverage.foreignKeys = 'unavailable'; }, /loaded foreign key metadata/);
  trial(({ ownerTable }) => { ownerTable.foreignKeys[0].referencedSchema = 'another_schema'; }, /current catalog/);
  trial(({ targetSources }) => { targetSources[0].text = targetSources[0].text.replace('private Long id;', 'private Integer id;'); }, /compatible column names and Java types/);
  trial(({ targetSources }) => { targetSources[0].text = targetSources[0].text.replace(/@Table\(.*?\)/, '@Table'); }, /literal @Table/);
  trial(({ ownerTable }) => { ownerTable.foreignKeys[1].columns[0].referencedColumn = 'entry_id'; }, /exact referenced primary key/);
  trial(({ ownerTable }) => { ownerTable.columns[2].nullable = true; }, /consistent nullability/);
  trial(({ ownerTable }) => { ownerTable.foreignKeys[0].columns[0].name = 'id'; }, /Shared primary key columns require scalar/);
  trial(({ relationships, ownerTable }) => {
    ownerTable.foreignKeys.push(fk('fk_overlaps', 'customer', ['customer_id'], ['id']));
    relationships.push(relation('fk_overlaps', 'Customer', 'shadowReference', 'scalar'));
  }, /share a source column/);
  trial(({ relationships }) => { relationships[0].property = 'customerId'; }, /field names must be distinct/);
});

test('scalar ownership safely preserves the @Id when a foreign key uses the same primary-key column', () => {
  const { plan, ownerTable, relationships } = scenario();
  ownerTable.foreignKeys[0].columns[0].name = 'id';
  relationships[0].mode = 'scalar';
  const result = plan();
  assert.match(result.text, /@Id\n    @Column\(name = "\\"id\\""/);
  assert.equal(result.relationshipPlan.relations[0].cardinality, 'OneToOne');
  assert.match(result.text, /insertable = false, updatable = false/);
  assert.match(result.text, /private Long id/);
});
