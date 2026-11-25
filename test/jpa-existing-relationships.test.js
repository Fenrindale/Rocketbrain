'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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
