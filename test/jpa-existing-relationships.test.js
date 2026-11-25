'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readRelationshipJoinCatalog } = require('../src/db/metadata');
const { existingRelationshipSelection, planExistingRelationship } = require('../src/jpa/entity-existing-relationships');

const database = 'fixture_main', pkg = 'fixture.jpa';
const uri = name => 'file:///fixture/src/main/java/fixture/jpa/' + name + '.java';
const column = (name, ordinal, primaryKey, nullable) => ({
  name, ordinal, type:'bigint', primaryKey, nullable, extra:'', defaultValue:null
});
const index = (name, field, unique = true) => ({ name, unique, primaryKey:name === 'PRIMARY',
  columns:[{ name:field, ordinal:1, prefixLength:null }] });
const declaration = (name, table, members) => `package ${pkg};
import jakarta.persistence.*;
@Entity @Table(name = "${table}")
public class ${name} {
    @Id @Column(name = "id") private Long id;
    ${members}
}
`;
function fixture(members = '') {
  const child = { name:'child', kind:'table', engine:'InnoDB',
    columns:[column('id', 1, true, false), column('parent_id', 2, false, true)],
    indexes:[index('PRIMARY', 'id'), index('child_fk', 'parent_id', false)],
    foreignKeys:[{ name:'child_fk', referencedSchema:database, referencedTable:'parent',
      columns:[{ name:'parent_id', referencedColumn:'id', ordinal:1 }] }] };
  const parent = { name:'parent', kind:'table', engine:'InnoDB', columns:[column('id', 1, true, false)],
    indexes:[index('PRIMARY', 'id')], foreignKeys:[] };
  const catalog = { database, scope:'database', tables:[child, parent],
    coverage:{ tables:'loaded', columns:'loaded', indexes:'loaded', foreignKeys:'loaded' } };
  const sources = [{ uri:uri('Child'), text:declaration('Child', 'child', members) },
    { uri:uri('Parent'), text:declaration('Parent', 'parent', '') }];
  const selection = existingRelationshipSelection({ projectUri:'file:///fixture', foreignKey:'child_fk',
    child:{ table:'child', uri:uri('Child'), type:pkg + '.Child', property:'parentReference' },
    parent:{ table:'parent', uri:uri('Parent'), type:pkg + '.Parent', property:'children' } });
  return { plan:() => planExistingRelationship({ catalog, selection, sources }), child, parent, sources, selection };
}

test('existing-entity relationship plans two insertions and preserves the original Java text', () => {
  const { plan, sources } = fixture();
  const result = plan();
  assert.equal(result.ownership, 'association');
  assert.deepEqual(result.edits.map(edit => edit.uri), sources.map(source => source.uri));
  assert.match(result.edits[0].text, /ManyToOne\(fetch = jakarta.persistence.FetchType.LAZY, optional = true\)/);
  assert.match(result.edits[0].text, /referencedColumnName = "id", nullable = true\)/);
  assert.match(result.edits[0].text, /void setParentReference\(fixture.jpa.Parent value\)/);
  assert.match(result.edits[1].text, /OneToMany\(mappedBy = "parentReference", fetch = jakarta.persistence.FetchType.LAZY\)/);
  assert.match(result.edits[1].text, /java\.util\.List<fixture\.jpa\.Child> getChildren/);
  for (const [i, edit] of result.edits.entries()) assert.equal(sources[i].text.slice(edit.offset), '}\n');
});

test('an explicit writable scalar FK remains the sole writer and both sources keep CRLF', () => {
  const { plan, sources } = fixture('@Column(name = "parent_id") private Long parentId;');
  for (const source of sources) source.text = source.text.replaceAll('\n', '\r\n');
  const { edits, ownership } = plan();
  assert.equal(ownership, 'scalar');
  assert.match(edits[0].text, /name = "parent_id".*insertable = false, updatable = false/);
  assert.doesNotMatch(edits[0].text, /setParentReference/);
  for (const edit of edits) assert.doesNotMatch(edit.text, /(?<!\r)\n/);
});

test('two-source JPA review refuses uncertain mappings, cardinality and Java name collisions', () => {
  for (const [edit, reason] of [
    [({ child }) => { child.foreignKeys[0].referencedSchema = 'elsewhere'; }, /exact primary key/],
    [({ child }) => { child.indexes[1].unique = true; }, /non-unique/],
    [({ sources }) => { sources[0].text = sources[0].text.replace('private Long id;', 'private Long id; private Long parentId;'); }, /explicit basic columns/],
    [({ sources }) => { sources[1].text = sources[1].text.replace('public class', 'public final class'); }, /plain concrete/],
    [({ sources }) => { sources[1].text = sources[1].text.replace('private Long id;', 'private Long id; public int getChildren() { return 0; }'); }, /collide/]
  ]) {
    const scenario = fixture();
    edit(scenario);
    assert.throws(scenario.plan, reason);
  }
  assert.throws(fixture('@Column(name = "parent_id", updatable = false) private Long parentId;').plan, /sole|writable/);
});

test('metadata fingerprints record changes to the foreign key table and its indexes', () => {
  const { plan, parent, child } = fixture();
  const first = plan().fingerprint;
  parent.columns.push(column('note', 2, false, true));
  const second = plan().fingerprint;
  assert.notEqual(first, second);
  child.indexes.push(index('secondary', 'parent_id', false));
  assert.notEqual(plan().fingerprint, second);
});

function composite() {
  const sample = fixture();
  const { child, parent, sources } = sample;
  parent.columns.push(column('tenant_id', 2, true, false));
  parent.indexes[0].columns = ['tenant_id', 'id'].map((name, index) => ({ name, ordinal:index + 1, prefixLength:null }));
  child.columns.push(column('parent_tenant', 3, false, true));
  child.foreignKeys[0].columns = [
    { name:'parent_tenant', referencedColumn:'tenant_id', ordinal:1 },
    { name:'parent_id', referencedColumn:'id', ordinal:2 }
  ];
  sources[1].text = sources[1].text.replace('public class Parent', '@IdClass(Parent.Key.class)\npublic class Parent')
    .replace('private Long id;', `private Long id;
    @Id @Column(name = "tenant_id") private Long tenant;
    public static class Key implements java.io.Serializable {
      public Long id;
      public Long tenant;
    }`);
  return sample;
}

test('composite existing-entity mappings preserve FK order and one consistent write owner', () => {
  const { plan, sources } = composite();
  const association = plan();
  assert.equal(association.ownership, 'association');
  assert.match(association.edits[0].text, /@jakarta\.persistence\.JoinColumns/);
  assert.match(association.edits[0].text, /parent_tenant.*"tenant_id"[\s\S]*parent_id.*"id"/);
  sources[0].text = sources[0].text.replace('private Long id;',
    'private Long id; @Column(name = "parent_tenant") private Long parentTenant;');
  assert.throws(plan, /scalars must map all/);
  sources[0].text = sources[0].text.replace('private Long parentTenant;',
    'private Long parentTenant; @Column(name = "parent_id") private Long parentId;');
  const scalar = plan();
  assert.equal(scalar.ownership, 'scalar');
  assert.equal(scalar.edits[0].text.match(/insertable = false, updatable = false/g).length, 2);
});

test('composite existing-entity plans refuse ID-class mismatch, FK reversal, mixed nullability and unique subkeys', () => {
  for (const [change, message] of [
    [sample => { sample.sources[1].text = sample.sources[1].text.replace('public Long tenant;', 'public Integer tenant;'); }, /explicit basic columns/],
    [sample => { sample.child.foreignKeys[0].columns[0].ordinal = 2; sample.child.foreignKeys[0].columns[1].ordinal = 1; }, /types and order/],
    [sample => { sample.child.columns[2].nullable = false; }, /same nullability/],
    [sample => { sample.child.indexes[1].unique = true; }, /non-unique/]
  ]) {
    const sample = composite();
    change(sample);
    assert.throws(sample.plan, message);
  }
});

function joinScenario() {
  const remote = 'fixture_other';
  const { parent, sources } = composite();
  const local = { name:'parent', kind:'table', engine:'InnoDB', columns:[column('id', 1, true, false)],
    indexes:[index('PRIMARY', 'id')], foreignKeys:[] };
  const fields = ['owner_id', 'target_tenant', 'target_id'];
  const bridge = {
    name:'owner_tag', kind:'table', engine:'InnoDB',
    columns:fields.map((name, index) => column(name, index + 1, true, false)),
    indexes:[{ name:'PRIMARY', primaryKey:true, unique:true, columns:fields.map((name, index) =>
      ({ name, ordinal:index + 1, prefixLength:null })) }],
    foreignKeys:[
      { name:'owner_fk', referencedSchema:database, referencedTable:local.name,
        columns:[{ name:'owner_id', referencedColumn:'id', ordinal:1 }] },
      { name:'target_fk', referencedSchema:remote, referencedTable:parent.name,
        columns:[{ name:'target_tenant', referencedColumn:'tenant_id', ordinal:1 },
          { name:'target_id', referencedColumn:'id', ordinal:2 }] }
    ]
  };
  const coverage = { tables:'loaded', columns:'loaded', indexes:'loaded', foreignKeys:'loaded' };
  const catalog = (schema, table) => ({ database:schema, scope:'table', selectedTable:table.name, coverage, tables:[table] });
  const joinProof = { activeDatabase:database, join:catalog(remote, bridge), targets:[catalog(database, local), catalog(remote, parent)] };
  sources[0] = { uri:uri('Owner'), text:declaration('Owner', local.name, '') };
  sources[1].text = sources[1].text.replace('@Table(name = "parent")', '@Table(name = "parent", catalog = "' + remote + '")');
  const request = { kind:'manyToMany', projectUri:'file:///fixture', joinSchema:remote, joinTable:bridge.name,
    ownerForeignKey:'owner_fk', targetForeignKey:'target_fk',
    owner:{ uri:uri('Owner'), type:pkg + '.Owner', table:local.name, schema:database, property:'tags' },
    target:{ uri:uri('Parent'), type:pkg + '.Parent', table:parent.name, schema:remote, property:'owners' } };
  const plan = () => planExistingRelationship({ joinProof, selection:existingRelationshipSelection(request), sources });
  return { request, plan, joinProof, remote, bridge, local, parent, sources };
}

test('qualified join edits resolve same-named endpoints, composite reference columns and exact mappedBy', () => {
  const { plan, bridge } = joinScenario();
  const first = plan();
  assert.equal(first.ownership, 'join-table');
  assert.match(first.edits[0].text, /catalog = "fixture_other"/);
  assert.match(first.edits[0].text, /inverseJoinColumns = \{.*target_tenant.*tenant_id[\s\S]*target_id.*"id"/);
  assert.match(first.edits[1].text, /ManyToMany\(mappedBy = "tags"/);
  assert.doesNotMatch(first.edits[1].text, /JoinTable/);
  bridge.indexes.push(index('more_lookup', 'target_tenant', false));
  assert.notEqual(plan().fingerprint, first.fingerprint);
});

test('join edits refuse an implicit remote catalog, different endpoints, narrower uniqueness and payload', () => {
  for (const [change, message] of [
    [sample => { sample.sources[1].text = sample.sources[1].text.replace(', catalog = "fixture_other"', ''); }, /explicit matching @Table/],
    [sample => { sample.request.targetForeignKey = 'forged_fk'; }, /exact table/],
    [sample => { sample.bridge.indexes.push(index('one_per_tenant', 'target_tenant')); }, /narrower uniqueness/],
    [sample => { sample.bridge.columns.push(column('later_note', 4, false, true)); }, /only the two disjoint/]
  ]) {
    const sample = joinScenario();
    change(sample);
    assert.throws(sample.plan, message);
  }
});

test('join metadata reads only a qualified table and its observed endpoints, and rejects concurrent drift', async () => {
  const { remote, bridge, local, parent } = joinScenario();
  const tables = new Map([[database + '.' + local.name, local], [remote + '.' + parent.name, parent],
    [remote + '.' + bridge.name, bridge]]);
  const reads = [];
  let drift = false;
  async function query(sql, values) {
    assert.equal(values.length, 2);
    const name = values.join('.');
    const table = tables.get(name);
    assert.ok(table);
    reads.push(name);
    if (sql.includes('information_schema.TABLES')) return { rows:[[table.name, 'BASE TABLE', 'InnoDB', null, null]] };
    if (sql.includes('information_schema.COLUMNS')) {
      return { rows:table.columns.map(c => [table.name, c.name, c.type, c.nullable ? 'YES' : 'NO', null,
        c.primaryKey ? 'PRI' : '', c.extra, c.ordinal, null, null, null]) };
    }
    if (sql.includes('information_schema.STATISTICS')) {
      const indexes = drift && table === bridge && reads.filter(value => value === name).length > 4 ?
        [...table.indexes, index('new_lookup', 'target_tenant', false)] : table.indexes;
      return { rows:indexes.flatMap(i => i.columns.map(c => [table.name, i.name, i.unique ? 0 : 1,
        c.ordinal, c.name, c.prefixLength, 'BTREE', 'A'])) };
    }
    assert.match(sql, /information_schema\.KEY_COLUMN_USAGE/);
    return { rows:table.foreignKeys.flatMap(f => f.columns.map(c => [table.name, f.name, c.name, c.ordinal,
      f.referencedSchema, f.referencedTable, c.referencedColumn, 'RESTRICT', 'RESTRICT'])) };
  }
  const request = { joinSchema:remote, joinTable:bridge.name };
  const result = await readRelationshipJoinCatalog(query, database, request, 2);
  assert.deepEqual(result.targets.map(item => [item.database, item.selectedTable]), [[database, local.name], [remote, parent.name]]);
  assert.deepEqual(reads, [remote + '.' + bridge.name, database + '.' + local.name, remote + '.' + parent.name,
    remote + '.' + bridge.name].flatMap(value => Array(4).fill(value)));
  reads.length = 0;
  drift = true;
  await assert.rejects(readRelationshipJoinCatalog(query, database, request, 3), /changed during inspection/);
});
