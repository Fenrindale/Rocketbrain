'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { analyzeJPA } = require('../src/jpa/model');
const { analyzeQueries, completionsAt, definitionsAt } = require('../src/jpa/query');
const { decodeExpression } = require('../src/jpa/literals');
const { lexJava } = require('../src/spring/java');

const mappings = [
  { uri: 'file:///Person.java', text: 'package demo; import jakarta.persistence.*; @Entity class Person { @Id Long id; String displayName; @Embedded Address address; @ManyToOne Department department; @Transient String ignored; }' },
  { uri: 'file:///Address.java', text: 'package demo; import jakarta.persistence.*; @Embeddable class Address { String city; }' },
  { uri: 'file:///Department.java', text: 'package demo; import jakarta.persistence.*; @Entity class Department { @Id Long id; String name; }' }
];
function repository(query, extra = '') { return { uri: 'file:///Repository.java', text: `package demo; import java.util.List; import org.springframework.data.jpa.repository.JpaRepository; import org.springframework.data.jpa.repository.Query; public interface Repository extends JpaRepository<Person,Long> { @Query(${query}) List<Person> byDepartment(String value); ${extra} }` }; }
function at(text, marker, after = 0) { const offset = text.indexOf(marker); assert.ok(offset >= 0, marker); const lines = text.slice(0, offset + after).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length }; }
function slice(text, range) { const offset = point => text.split('\n').slice(0, point.line).reduce((count, line) => count + line.length + 1, 0) + point.character; return text.slice(offset(range.start), offset(range.end)); }

test('flat JPQL association join aliases complete/navigate persistent paths across files', () => {
  const file = repository('"select p from Person p join p.department d where d.name = :value"');
  const model = analyzeJPA([...mappings, file]);
  assert.equal(model.queries[0].status, 'known');
  assert.equal(model.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
  assert.ok(completionsAt(model, file.uri, at(file.text, 'p.department', 2)).some(item => item.label === 'department'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.department', 4)).some(item => item.uri === 'file:///Person.java'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'd.name', 3)).some(item => item.uri === 'file:///Department.java'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'from Person', 7)).some(item => item.uri === 'file:///Person.java'));
});

test('embedded property chains navigate and missing complete properties receive mapped source ranges', () => {
  const file = repository('"select p from Person p where p.address.city = :value and p.missingProperty = :other"');
  const model = analyzeJPA([...mappings, file]);
  assert.ok(completionsAt(model, file.uri, at(file.text, 'p.address.city', 10)).some(item => item.label === 'city'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.address.city', 12)).some(item => item.uri === 'file:///Address.java'));
  const diagnostic = model.diagnostics.find(item => item.code === 'jpa.jpql.property.missing');
  assert.ok(diagnostic); assert.equal(slice(file.text, diagnostic.range), 'missingProperty'); assert.equal(model.queries[0].status, 'invalid');
});

test('Java escape decoding maps JPQL diagnostics to the original escaped source spelling', () => {
  const file = repository('"select p from Person p where p.missing\\u0050roperty = :value"');
  const model = analyzeJPA([...mappings, file]);
  assert.match(model.queries[0].text, /missingProperty/);
  const diagnostic = model.diagnostics.find(item => item.code === 'jpa.jpql.property.missing');
  assert.ok(diagnostic); assert.equal(slice(file.text, diagnostic.range), 'missing\\u0050roperty');
});

test('native SQL, dynamic Java, structural Unicode, CTEs and provider functions remain unknown without property warnings', () => {
  for (const query of ['"select p.missing from Person p", nativeQuery=true', '"select p from " + entityName', '"select p from Person p where p.missing=\\u0022"', '"with q as (select p.missing from Person p) select q from q"', '"select providerMagic(p.missing) from Person p"']) {
    const model = analyzeJPA([...mappings, repository(query)]);
    assert.equal(model.queries[0].status, 'unknown', query);
    assert.equal(model.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false, query);
  }
});

test('literal-only concatenations and parentheses bind paths while preserving gaps and split identifiers', () => {
  const file = repository('("select p from Person p where p.dis" + ("playName = :value"))');
  const model = analyzeJPA([...mappings, file]);
  assert.equal(model.queries[0].status, 'known'); assert.equal(model.queries[0].text, 'select p from Person p where p.displayName = :value');
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'playName', 3)).some(item => item.uri === 'file:///Person.java'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.dis', 3)).some(item => item.uri === 'file:///Person.java'));
  assert.deepEqual(completionsAt(model, file.uri, at(file.text, ' + ', 1)), []);
  assert.deepEqual(definitionsAt(model, file.uri, at(file.text, ' + ', 1)), []);
  assert.deepEqual(completionsAt(model, file.uri, at(file.text, 'p.dis', 4)), [], 'a completion must not replace through Java delimiters');
  const invalid = repository('"select p from Person p where p.miss" + "ing = :value"'), bad = analyzeJPA([...mappings, invalid]);
  assert.deepEqual(bad.diagnostics.filter(item => item.code === 'jpa.jpql.property.missing').map(item => slice(invalid.text, item.range)), ['miss', 'ing']);
});

test('text blocks normalize CRLF, strip incidental/trailing whitespace, then decode escapes and continuations', () => {
  const expression = '"""\r\n    select p from Person p   \r\n      where p.displayName = \'Alex\'\\s  \r\n    """';
  const decoded = decodeExpression(lexJava(expression).tokens);
  assert.equal(decoded.text, "select p from Person p\n  where p.displayName = 'Alex' \n");
  const continued = '"""\n    select p from Person p where p.dis' + '\\' + '\n    playName = :value\n    """';
  assert.equal(decodeExpression(lexJava(continued).tokens).text, 'select p from Person p where p.displayName = :value\n');
  const sameLineClosing = '"""\n\tselect p from Person p"""';
  assert.equal(decodeExpression(lexJava(sameLineClosing).tokens).text, 'select p from Person p');
  assert.equal(decodeExpression(lexJava('"""\n    a\\141\\t\\r\\n\\s\n    """').tokens).text, 'aa\t\r\n \n');
  assert.equal(decodeExpression(lexJava('"""missing opening newline"""').tokens), null);
  assert.equal(decodeExpression(lexJava('"""\n    first' + '\\' + '  \n    second\n    """').tokens), null, 'incidental whitespace stripping must not legalize an illegal source escape');
  assert.equal(decodeExpression(lexJava('"select p" + variable').tokens), null);
  assert.equal(decodeExpression(lexJava('"a".formatted()').tokens), null);
});

test('text block references and diagnostics retain original source and stripped indentation receives no completion', () => {
  const file = repository('"""\n        select p from Person p\n        where p.address.city = :city and p.missingProperty = :value\n        """');
  const model = analyzeJPA([...mappings, file]);
  assert.equal(model.queries[0].status, 'invalid');
  assert.equal(slice(file.text, model.diagnostics.find(item => item.code === 'jpa.jpql.property.missing').range), 'missingProperty');
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.address.city', 12)).some(item => item.uri === 'file:///Address.java'));
  const completion = completionsAt(model, file.uri, at(file.text, 'p.address.city', 10)).find(item => item.label === 'city');
  assert.ok(completion); assert.equal(slice(file.text, completion.range), 'city');
  assert.deepEqual(completionsAt(model, file.uri, at(file.text, '\n        where', 4)), []);
});

test('correlated EXISTS/IN subqueries resolve outer references, three scopes and alias shadowing', () => {
  const file = repository('"select p from Person p where exists (select d from Department d where d.id = p.department.id and exists (select p from Department p where p.name = d.name)) and p.id in (select q.id from Person q where q.department = p.department)"');
  const model = analyzeJPA([...mappings, file]);
  assert.equal(model.queries[0].status, 'known', model.queries[0].reason);
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.name', 3)).some(item => item.uri === 'file:///Department.java'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.department.id', 4)).some(item => item.uri === 'file:///Person.java'));
  assert.ok(completionsAt(model, file.uri, at(file.text, 'p.name', 2)).some(item => item.label === 'name'));
  assert.equal(completionsAt(model, file.uri, at(file.text, 'p.name', 2)).some(item => item.label === 'displayName'), false);
  assert.ok(completionsAt(model, file.uri, at(file.text, 'q.department', 2)).some(item => item.label === 'displayName'));
});

test('missing paths inside nested scopes keep precise ranges and do not leak sibling aliases', () => {
  const file = repository('"select p from Person p where exists (select d from Department d where d.missing = p.displayName)"');
  const model = analyzeJPA([...mappings, file]);
  assert.equal(model.queries[0].status, 'invalid');
  const diagnostic = model.diagnostics.find(item => item.code === 'jpa.jpql.property.missing');
  assert.equal(slice(file.text, diagnostic.range), 'missing'); assert.match(diagnostic.message, /Department/);
  const sibling = repository('"select p from Person p where exists (select d from Department d) and exists (select q from Person q where d.bad = q.displayName)"');
  const unresolved = analyzeJPA([...mappings, sibling]);
  assert.equal(unresolved.queries[0].status, 'unknown');
  assert.equal(unresolved.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
});

test('standard functions CASE constructor aggregate GROUP HAVING ORDER bind paths without claiming expression types', () => {
  for (const text of [
    'select new demo.Summary(p.displayName, coalesce(p.department.name, :fallback)) from Person p',
    "select case when length(p.displayName) > 2 then upper(p.displayName) else lower(p.displayName) end from Person p",
    'select p.department.name, count(p.id), max(p.id) from Person p group by p.department.name having count(p.id) > :minimum order by p.department.name desc',
    'select substring(trim(p.displayName), 1, 2) from Person p where abs(p.id) > 0'
  ]) {
    const file = repository(JSON.stringify(text)), model = analyzeJPA([...mappings, file]);
    assert.equal(model.queries[0].status, 'known', model.queries[0].reason);
    if (text.includes('p.displayName')) assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.displayName', 4)).length);
  }
  const bad = repository('"select count(p.missing) from Person p where p.id in (select q.id from Person q)"');
  assert.equal(analyzeJPA([...mappings, bad]).queries[0].status, 'invalid');
});

test('JOIN ON FETCH collection aliases and collection member declarations bind managed element types', () => {
  const files = mappings.map(file => file.uri === 'file:///Department.java' ? { ...file, text: file.text.replace('String name;', 'String name; @OneToMany(mappedBy="department") java.util.List<Person> people;') } : file);
  for (const text of [
    'select p from Person p left join p.department d on d.name = :name where d.id > 0',
    'select p from Person p join fetch p.department where p.id > 0',
    'select p from Department d join d.people p where p.displayName = :name',
    'select p from Department d, in(d.people) p where p.displayName = :name'
  ]) {
    const file = repository(JSON.stringify(text)), model = analyzeJPA([...files, file]);
    assert.equal(model.queries[0].status, 'known', model.queries[0].reason);
    if (text.includes('p.displayName')) assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.displayName', 4)).some(item => item.uri === 'file:///Person.java'));
  }
});

test('bulk UPDATE and DELETE bind targets, assignment paths and correlated subqueries without executing them', () => {
  for (const text of [
    'update Person p set p.displayName = concat(p.displayName, :suffix) where p.department in (select d from Department d where d.name = :name)',
    'delete from Person p where exists (select d from Department d where d.id = p.department.id)'
  ]) {
    const file = repository(JSON.stringify(text)), model = analyzeJPA([...mappings, file]);
    assert.equal(model.queries[0].status, 'known', model.queries[0].reason);
    assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.department', 4)).some(item => item.uri === 'file:///Person.java'));
    assert.ok(model.queries[0].parameters.every(item => slice(file.text, item.range) === item.name));
  }
  const bad = repository('"update Person p set p.nonexistent = :value"');
  assert.equal(analyzeJPA([...mappings, bad]).queries[0].status, 'invalid');
  const unqualified = repository('"update Person p set nonexistent = :value"');
  assert.equal(analyzeJPA([...mappings, unqualified]).queries[0].status, 'invalid');
});

test('TREAT checks a known managed subtype and navigates/completes subtype-specific fields', () => {
  const files = [
    { uri: 'file:///Asset.java', text: 'package demo; import jakarta.persistence.*; @Entity class Asset { @Id Long id; String label; }' },
    { uri: 'file:///DocumentAsset.java', text: 'package demo; import jakarta.persistence.*; @Entity class DocumentAsset extends Asset { String format; }' }
  ];
  const file = repository('"select a from Asset a where treat(a as DocumentAsset).format = :format"');
  const model = analyzeJPA([...files, file]);
  assert.equal(model.queries[0].status, 'known', model.queries[0].reason);
  assert.ok(definitionsAt(model, file.uri, at(file.text, ').format', 4)).some(item => item.uri === 'file:///DocumentAsset.java'));
  assert.ok(completionsAt(model, file.uri, at(file.text, ').format', 2)).some(item => item.label === 'format'));
  const invalid = repository('"select a from Asset a where treat(a as Person).missing = :format"');
  const unknown = analyzeJPA([...files, ...mappings, invalid]);
  assert.equal(unknown.queries[0].status, 'unknown'); assert.equal(unknown.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
});

test('XML named queries use supplied entity-decoded offset maps for definitions completion and diagnostics', () => {
  const xml = { uri: 'file:///orm.xml', text: '<entity-mappings><named-query name="people"><query>select p from Person p where p.id &gt; 0 and p.missing = :name</query></named-query></entity-mappings>' };
  const start = xml.text.indexOf('select p'), raw = xml.text.slice(start, xml.text.indexOf('</query>')), map = [], ends = []; let text = '';
  for (let i = 0; i < raw.length;) { const first = i; if (raw.startsWith('&gt;', i)) { text += '>'; i += 4; } else text += raw[i++]; map.push(start + first); ends.push(start + i); }
  const model = analyzeJPA(mappings); model.files.push(xml); model.mappingQueries = [{ uri: xml.uri, text, source: 'xml-named-query', name: 'people', range: { start: at(xml.text, 'select p'), end: at(xml.text, '</query>') }, _map: map, _ends: ends }];
  analyzeQueries(model, [], {});
  assert.equal(model.queries[0].status, 'invalid');
  assert.ok(definitionsAt(model, xml.uri, at(xml.text, 'p.id', 3)).some(item => item.uri === 'file:///Person.java'));
  assert.ok(completionsAt(model, xml.uri, at(xml.text, 'p.missing', 2)).some(item => item.label === 'displayName'));
  assert.equal(slice(xml.text, model.diagnostics.find(item => item.code === 'jpa.jpql.property.missing').range), 'missing');
  const unsupported = { ...model, queries: [], diagnostics: [], references: [], mappingQueries: [{ ...model.mappingQueries[0], forcedReason: 'XML query language is unresolved.' }] };
  analyzeQueries(unsupported, [], {});
  assert.deepEqual(completionsAt(unsupported, xml.uri, at(xml.text, 'p.missing', 2)), []);
});

test('malformed, deeply nested and provider syntax suppress speculative missing-property diagnostics', () => {
  for (const text of ['select p.missing from Person p where exists (select q from Person q', 'select p.missing from Person p union select q from Person q', 'select p.missing from Person p where p.id in [' + '1]', 'select p.missing from Person p where ' + '('.repeat(34) + 'p.id = 1' + ')'.repeat(34)]) {
    const model = analyzeJPA([...mappings, repository(JSON.stringify(text))]);
    assert.equal(model.queries[0].status, 'unknown'); assert.equal(model.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
  }
});

test('duplicate/external entity names and partial attribute sets do not become false missing warnings', () => {
  const file = repository('"select p from Person p where p.notKnown = :value"');
  const duplicate = { uri: 'file:///Duplicate.java', text: 'package other; import jakarta.persistence.*; @Entity(name="Person") class Duplicate { @Id Long id; }' };
  const duplicateModel = analyzeJPA([...mappings, duplicate, file]);
  assert.equal(duplicateModel.queries[0].status, 'unknown'); assert.equal(duplicateModel.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
  const external = analyzeJPA([...mappings, repository('"select x from External x where x.missing = :value"')]);
  assert.equal(external.queries[0].status, 'unknown'); assert.equal(external.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
  const partial = mappings.map(item => item.uri === 'file:///Person.java' ? { ...item, text: item.text.replace('class Person', 'class Person extends ExternalBase') } : item);
  const partialModel = analyzeJPA([...partial, file]);
  assert.equal(partialModel.diagnostics.some(item => item.code === 'jpa.jpql.property.missing'), false);
});

test('verified EntityManager receivers are analyzed, unrelated createQuery calls are ignored', () => {
  const file = { uri: 'file:///Service.java', text: 'package demo; import jakarta.persistence.EntityManager; class Service { EntityManager em; Custom fake; void run() { em.createQuery("select p from Person p where p.missingProperty = :value", Person.class); fake.createQuery("select p.missing from Person p"); em.createNativeQuery("select * from Person"); } }' };
  const model = analyzeJPA([...mappings, file]);
  assert.equal(model.queries.filter(query => query.source === 'entity-manager-query').length, 1);
  assert.equal(model.queries.filter(query => query.source === 'native-sql').length, 1);
  assert.equal(model.diagnostics.filter(item => item.code === 'jpa.jpql.property.missing').length, 1);
});

test('basic Spring Data direct and explicit underscore paths have cross-file definitions', () => {
  const file = repository('"select p from Person p"', 'List<Person> findByDisplayName(String name); List<Person> findByAddress_City(String city); List<Person> findByDisplayNameAndIgnored(String value);');
  const model = analyzeJPA([...mappings, file]);
  const derived = model.queries.filter(query => query.source === 'spring-data-derived');
  assert.deepEqual(derived.map(query => query.status), ['known', 'known', 'unknown']);
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'findByDisplayName', 8)).some(item => item.uri === 'file:///Person.java'));
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'findByAddress_City', 16)).some(item => item.uri === 'file:///Address.java'));
});

test('real Boot project repository and invalid EntityManager example produce source references/counterexample', () => {
  const directory = path.join(__dirname, 'fixtures/spring-boot-app/src/main/java/fixture/boot');
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.java')).map(name => { const file = path.join(directory, name); return { uri: pathToFileURL(file).href, text: fs.readFileSync(file, 'utf8') }; });
  const model = analyzeJPA(files, { basePackages: ['fixture.boot'], physicalNaming: 'standard' });
  const repository = files.find(file => file.uri.endsWith('/PersonRepository.java'));
  assert.ok(completionsAt(model, repository.uri, at(repository.text, 'p.department', 2)).some(item => item.label === 'department'));
  assert.ok(definitionsAt(model, repository.uri, at(repository.text, 'd.name', 3)).some(item => item.uri.endsWith('/Department.java')));
  assert.ok(model.diagnostics.some(item => item.code === 'jpa.jpql.property.missing' && item.uri.endsWith('/ProbeService.java') && item.message.includes('missingProperty')));
});

test('actual advanced Boot query sources and orm.xml bind complex paths and retain the nested invalid counterexample', () => {
  const directory = path.join(__dirname, 'fixtures/spring-boot-app/src/main/java/fixture/boot');
  if (!fs.existsSync(path.join(directory, 'AdvancedProbeService.java'))) return;
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.java')).map(name => { const file = path.join(directory, name); return { uri: pathToFileURL(file).href, text: fs.readFileSync(file, 'utf8') }; });
  const xmlPath = path.join(__dirname, 'fixtures/spring-boot-app/src/main/resources/META-INF/orm.xml');
  const mappingFiles = [{ uri: pathToFileURL(xmlPath).href, text: fs.readFileSync(xmlPath, 'utf8') }];
  const model = analyzeJPA(files, { basePackages: ['fixture.boot'], physicalNaming: 'standard', mappingFiles });
  const file = files.find(item => item.uri.endsWith('/AdvancedProbeService.java'));
  const queries = model.queries.filter(query => query.uri === file.uri);
  for (const marker of ['exists (select p.id from Department p', 'group by d.name having count(p)', 'select case when', 'select new fixture.boot.PersonSummary', 'left join p.department d on', 'join fetch p.department', 'join d.people p', 'join c.tags t', 'treat(a as DocumentAsset).format', 'update Person p', 'delete from Person p']) {
    const query = queries.find(item => item.text?.includes(marker)); assert.ok(query, marker); assert.equal(query.status, 'known', query.reason);
    assert.equal(query.validityVerified, false);
  }
  assert.equal(queries.find(query => query.text?.includes('missingNested')).status, 'invalid');
  assert.equal(model.diagnostics.filter(item => item.uri === file.uri && item.code === 'jpa.jpql.property.missing').length, 1);
  assert.ok(definitionsAt(model, file.uri, at(file.text, 'p.name = d.name', 3)).some(target => target.uri.endsWith('/Department.java')));
  assert.ok(model.queries.some(query => query.source === 'xml-named-query' && query.name === 'XmlEntry.byPrefix' && query.status === 'known'));
});

test('query scans respect configured package scope and do not mix unrelated application sources', () => {
  const file = repository('"select p from Person p where p.missingProperty = :value"');
  const outside = { uri: 'file:///Outside.java', text: 'package outside; import org.springframework.data.jpa.repository.Query; interface Outside { @Query("select x from Other x where x.bad = :value") Object query(); }' };
  const model = analyzeJPA([...mappings, file, outside], { basePackages: ['demo'] });
  assert.equal(model.queries.some(query => query.uri === outside.uri), false);
  assert.equal(model.diagnostics.some(item => item.uri === outside.uri), false);
  assert.ok(model.diagnostics.some(item => item.uri === file.uri && item.code === 'jpa.jpql.property.missing'));
});

test('JPQL string literal contents do not receive alias property completions', () => {
  const file = repository('"select p from Person p where p.displayName = \'p.department\'"');
  const model = analyzeJPA([...mappings, file]);
  assert.deepEqual(completionsAt(model, file.uri, at(file.text, "'p.department'", 5)), []);
  assert.ok(completionsAt(model, file.uri, at(file.text, 'p.displayName', 2)).some(item => item.label === 'displayName'));
});
