'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { defaultEntityName, inspectTable, planEntity } = require('../src/jpa/entity-scaffold');

function catalog(composite = false) {
  const column = (name, type, ordinal, key = false, extra = '', nullable = !key) =>
    ({ name, type, ordinal, primaryKey: key, nullable, extra, defaultValue: null });
  const fields = [column('entry_id', composite ? 'bigint(20)' : 'bigint', 1, true, composite ? '' : 'auto_increment'),
    column('tenant_id', 'int(11)', 2, composite), column('order', 'varchar(50)', 3),
    column('capacity', 'decimal(20,5)', 4, false, '', false), column('scheduled_at', 'datetime(6)', 5),
    column('enabled', 'bit(1)', 6), column('published_on', 'date', 7), column('rating', 'double', 8),
    column('category', 'char(2)', 9), column('sequence_number', 'smallint(6)', 10)];
  const keys = (composite ? ['tenant_id', 'entry_id'] : ['entry_id']).map((name, index) =>
    ({ name, ordinal: index + 1, prefixLength: null }));
  return { database: 'fixture', scope: 'database', coverage: { tables: 'loaded', columns: 'loaded', indexes: 'loaded', foreignKeys: 'loaded' },
    tables: [{ name: 'publication_entry', kind: 'table', engine: 'InnoDB', columns: fields,
      indexes: [{ name: 'PRIMARY', primaryKey: true, unique: true, columns: keys }], foreignKeys: [] }] };
}

const table = 'publication_entry';
const render = (value, options = {}) => planEntity({ catalog: value, table, name: 'PublicationEntry',
  packageName: 'fixture.entries', uri: 'file:///fixture/entries/PublicationEntry.java', ...options });

test('JPA scaffold uses deterministic explicit names, supported Java types, and a generated signed BIGINT ID', () => {
  const selected = catalog();
  const result = render(selected);
  assert.equal(defaultEntityName(table), 'PublicationEntry');
  assert.equal(defaultEntityName(null), '');
  assert.equal(defaultEntityName('UPPERCASE'), '');
  assert.equal(result.text, render(structuredClone(selected)).text);
  assert.match(result.text, /^package fixture\.entries;/);
  assert.match(result.text, /@Table\(name = "\\"publication_entry\\""\)/);
  assert.match(result.text, /@Id\n    @GeneratedValue\(strategy = GenerationType\.IDENTITY\)/);
  assert.match(result.text, /@Column\(name = "\\"order\\"", nullable = true, length = 50\)\n    private String order;/);
  assert.match(result.text, /nullable = false, precision = 20, scale = 5\)\n    private BigDecimal capacity;/);
  assert.match(result.text, /private LocalDateTime scheduledAt;/);
  assert.match(result.text, /private LocalDate publishedOn;/);
  assert.match(result.text, /private Boolean enabled;/);
  assert.match(result.text, /private Short sequenceNumber;/);
  assert.doesNotMatch(result.text, /setEntryId|@IdClass/);
  assert.equal(result.comparison.matches, 10);
  assert.equal(result.comparison.mismatches, 0);
});

test('JPA scaffold models composite PK in actual index order, with exact numeric equality and scalar FK', () => {
  const selected = catalog(true);
  selected.tables[0].foreignKeys.push({ name: 'parent_fk', columns: [{ name: 'tenant_id' }] });
  const result = render(selected);
  assert.deepEqual(result.mapping.keys.map(field => field.sql), ['tenant_id', 'entry_id']);
  assert.match(result.text, /@IdClass\(PublicationEntry\.PrimaryKey\.class\)/);
  assert.match(result.text, /public static class PrimaryKey implements Serializable/);
  assert.match(result.text, /PrimaryKey\(Integer tenantId, Long entryId\)/);
  assert.match(result.text, /Objects\.equals\(this\.tenantId, key\.tenantId\)/);
  assert.match(result.text, /Objects\.hash\(tenantId, entryId\)/);
  assert.doesNotMatch(result.text, /@GeneratedValue|ManyToOne/);
  assert.ok(result.mapping.notes.some(note => note.includes('scalar fields')));
  assert.equal(result.comparison.matches, 10);
});

test('JPA scaffold rejects unsupported or ambiguous live metadata before creating a source plan', () => {
  const invalid = (change, error) => {
    const selected = catalog();
    change(selected.tables[0], selected);
    assert.throws(() => render(selected), error);
  };
  invalid((_, value) => { value.coverage.indexes = 'unavailable'; }, /catalog/);
  invalid(table => { table.indexes = []; }, /primary key/);
  invalid(table => { table.indexes[0].columns[0].prefixLength = 3; }, /metadata do not agree/);
  invalid(table => { table.columns[2].name = 'TenantId'; }, /identifiers/);
  invalid(table => { table.columns[2].name = 'tenant__id'; }, /same or invalid Java field/);
  invalid(table => { table.columns[0].type = 'bigint unsigned'; }, /Unsupported type/);
  invalid(table => { table.columns[0].type = 'varchar(60)'; }, /signed/);
  invalid(table => { table.columns[2].type = 'geometry'; }, /Unsupported type/);
  invalid(table => { table.columns[2].extra = 'STORED GENERATED'; }, /generated or special/);
  invalid(table => { table.columns[2].extra = 'auto_increment'; }, /single signed/);
  assert.throws(() => render(catalog(true), { name: 'PrimaryKey' }), /other than PrimaryKey/);
  assert.throws(() => render(catalog(), { packageName: '' }), /named Java package/);
});

test('JPA scaffold fingerprint follows reviewed mapping metadata, independent of catalog fetch time', () => {
  const selected = catalog();
  const first = inspectTable(selected, table).fingerprint;
  selected.revision = 12;
  selected.loadedAt = '2030-01-01T00:00:00Z';
  assert.equal(inspectTable(selected, table).fingerprint, first);
  selected.tables[0].columns[2].type = 'varchar(60)';
  const second = inspectTable(selected, table).fingerprint;
  assert.notEqual(first, second);
  selected.tables[0].columns[2].defaultValue = 'x';
  assert.notEqual(inspectTable(selected, table).fingerprint, second);
});
