'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { planEntity } = require('../src/jpa/entity-scaffold');

const database = 'fixture_schema', pkg = 'fixture.collection', owner = 'Club';
const uri = name => 'file:///fixture/collection/' + name + '.java';
const cols = names => names.map((name, index) => ({ name, ordinal: index + 1, prefixLength: null }));
const idx = (name, names, unique = true) => ({ name, unique, primaryKey: name === 'PRIMARY', columns: cols(names) });
const fk = (name, referencedTable, field, references) => ({ name, referencedTable, referencedSchema: database,
  columns: field.map((key, index) => ({ name: key, ordinal: index + 1, referencedColumn: references[index] })) });

function table(name, fields, keys, foreignKeys = [], indexes = []) {
  const columns = fields.map(([name, type, nullable = false], index) => ({ name, type, nullable, ordinal: index + 1,
    primaryKey: keys.includes(name), defaultValue: null, extra: '' }));
  return { name, kind: 'table', engine: 'InnoDB', columns, indexes: [idx('PRIMARY', keys), ...indexes], foreignKeys };
}

function scenario() {
  const root = table('club', [['id', 'bigint']], ['id']);
  const child = table('member', [['id', 'bigint'], ['club_id', 'bigint']], ['id'],
    [fk('fk_member_club', root.name, ['club_id'], ['id'])]);
  const tag = table('tag', [['tag_id', 'bigint'], ['tenant_id', 'int']], ['tenant_id', 'tag_id']);
  const through = table('club_tag', [['club_id', 'bigint'], ['tag_tenant', 'int'], ['tag_key', 'bigint']], ['club_id', 'tag_tenant', 'tag_key'],
    [fk('fk_club', root.name, ['club_id'], ['id']), fk('fk_tag', tag.name, ['tag_tenant', 'tag_key'], ['tenant_id', 'tag_id'])]);
  const catalog = { database, scope: 'database', coverage: { tables: 'loaded', columns: 'loaded', indexes: 'loaded', foreignKeys: 'loaded' },
    tables: [root, child, tag, through] };
  const source = { uri: uri('Member'), text: `package ${pkg};
import jakarta.persistence.*;
@Entity @Table(name = "member")
public class Member {
    @Id @Column(name = "id") private Long id;
    @ManyToOne(optional = false)
    @JoinColumn(name = "club_id", referencedColumnName = "id", nullable = false)
    private Club clubReference;
}` };
  const target = { uri: uri('Tag'), text: planEntity({ catalog, table: 'tag', name: 'Tag', packageName: pkg, uri: uri('Tag') }).text };
  const selected = [
    { kind: 'inverseOneToMany', foreignKey: 'fk_member_club', childTable: 'member', targetType: pkg + '.Member',
      targetUri: source.uri, mappedBy: 'clubReference', property: 'members' },
    { kind: 'joinTableManyToMany', joinTable: 'club_tag', ownerForeignKey: 'fk_club', targetForeignKey: 'fk_tag',
      targetType: pkg + '.Tag', targetUri: target.uri, property: 'tags' }
  ];
  const plan = () => planEntity({ catalog, table: 'club', name: owner, packageName: pkg, uri: uri(owner),
    relationships: selected, targetSources: [source, target] });
  return { plan, catalog, root, child, tag, through, source, target, selected };
}

test('JPA inverse mappedBy and FK-backed composite join-table collections generate one owner source with exact roles', () => {
  const { plan } = scenario();
  const { text, comparison, relationshipPlan } = plan();
  assert.match(text, /@OneToMany\(mappedBy = "clubReference", fetch = FetchType\.LAZY\)/);
  assert.match(text, /List<fixture\.collection\.Member> getMembers\(\)/);
  assert.match(text, /@ManyToMany\(fetch = FetchType\.LAZY\)/);
  assert.match(text, /@JoinTable\(name = "\\"club_tag\\""/);
  assert.match(text, /@JoinColumn\(name = "\\"tag_tenant\\"", referencedColumnName = "\\"tenant_id\\"", nullable = false\)/);
  assert.match(text, /Set<fixture\.collection\.Tag> getTags\(\)/);
  assert.doesNotMatch(text, /CascadeType|orphanRemoval|void setMembers/);
  assert.equal(comparison.mismatches, 0);
  assert.deepEqual(relationshipPlan.relations.map(relation => relation.cardinality), ['OneToMany', 'ManyToMany']);
});

test('JPA inverse requires an exact explicitly writable child association without another write owner', () => {
  for (const [edit, reason] of [
    [({ selected }) => { selected[0].mappedBy = 'missing'; }, /explicit @ManyToOne/],
    [({ source }) => { source.text = source.text.replace('referencedColumnName = "id", ', ''); }, /explicit join names/],
    [({ source }) => { source.text = source.text.replace('name = "club_id",', 'name = "wrong",'); }, /explicit join names/],
    [({ source }) => { source.text = source.text.replace('nullable = false)', 'nullable = false, updatable = false)'); }, /only writable/],
    [({ source }) => { source.text = source.text.replace('private Club clubReference;', 'private Club clubReference; @Column(name = "club_id") private Long shadow;'); }, /only writable/],
    [({ child }) => { child.indexes.push(idx('uq', ['club_id'])); }, /without a uniqueness constraint/]
  ]) {
    const scenarioState = scenario();
    edit(scenarioState);
    assert.throws(scenarioState.plan, reason);
  }
});

test('JPA inverse proves ordered composite child joins and rejects uniqueness on a subset of the FK', () => {
  const fixture = scenario();
  fixture.selected.pop();
  Object.assign(fixture.root, table('club', [['id', 'bigint'], ['tenant_id', 'int']], ['tenant_id', 'id']));
  Object.assign(fixture.child, table('member', [['id', 'bigint'], ['club_id', 'bigint'], ['club_tenant', 'int']], ['id'],
    [fk('fk_member_club', 'club', ['club_tenant', 'club_id'], ['tenant_id', 'id'])]));
  fixture.source.text = fixture.source.text.replace('@JoinColumn(name = "club_id", referencedColumnName = "id", nullable = false)',
    '@JoinColumns({@JoinColumn(name = "club_tenant", referencedColumnName = "tenant_id", nullable = false), ' +
    '@JoinColumn(name = "club_id", referencedColumnName = "id", nullable = false)})');
  const planned = fixture.plan();
  assert.deepEqual(planned.relationshipPlan.relations[0].columns.map(column => column.physicalReference), ['tenant_id', 'id']);
  fixture.child.indexes.push(idx('narrow_unique', ['club_tenant']));
  assert.throws(fixture.plan, /without a uniqueness constraint/);
});

test('JPA join table rejects payload, overlap, non-primary roles, narrower uniqueness and another schema', () => {
  for (const [edit, reason] of [
    [({ through }) => { through.columns.push({ name: 'payload', type: 'bigint', nullable: true, ordinal: 4, primaryKey: false, extra: '' }); }, /exactly the two foreign keys/],
    [({ through }) => { through.foreignKeys[1].columns[1].name = 'club_id'; }, /exactly the two foreign keys/],
    [({ through }) => { through.foreignKeys[1].columns[1].referencedColumn = 'other'; }, /types and order/],
    [({ through }) => { through.indexes.push(idx('only_one_tag', ['club_id'])); }, /narrower uniqueness/],
    [({ through }) => { through.foreignKeys[1].referencedSchema = 'external'; }, /foreign key in the current catalog/],
    [({ selected }) => { selected[1].property = 'members'; }, /distinct relationship names/]
  ]) {
    const scenarioState = scenario();
    edit(scenarioState);
    assert.throws(scenarioState.plan, reason);
  }
});

test('JPA collection proof captures both child and join-table foreign key definitions for stale metadata guards', () => {
  const fixture = scenario();
  const first = fixture.plan().relationshipPlan.fingerprint;
  fixture.through.foreignKeys[1].onDelete = 'CASCADE';
  const second = fixture.plan().relationshipPlan.fingerprint;
  assert.notEqual(first, second);
  fixture.child.foreignKeys[0].onUpdate = 'RESTRICT';
  assert.notEqual(second, fixture.plan().relationshipPlan.fingerprint);
});
