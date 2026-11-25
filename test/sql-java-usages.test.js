'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanJavaSql } = require('../src/db/java-sql-usages');
const { analyzeJavaUsageDocument, usagesInJava, targetAtJava } = require('../src/db/sql-usage-sources');

const catalog = { database: 'app', coverage: { tables: 'loaded', columns: 'loaded' },
  tables: [{ name: 'people', kind: 'table', columns: [{ name: 'name', type: 'varchar(40)' }, { name: 'id', type: 'bigint' }] }],
  views: [] };
const options = { database: 'app', sqlMode: [] };
const target = { database: 'app', kind: 'column', table: 'people', column: 'name' };
const java = text => analyzeJavaUsageDocument(text, catalog, options);
const springFixture = fs.readFileSync(path.join(__dirname,'fixtures/spring-boot-app/src/main/java/fixture/boot/SqlUsageProbe.java'), 'utf8');

test('compiled Spring probe source exposes text block, concatenation and native repository arguments', () => {
  const scanned = scanJavaSql(springFixture);
  assert.equal(scanned.fragments.length, 3);
  assert.deepEqual(scanned.fragments.map(f => f.origin),
    ['spring-data-native-query', 'spring-jdbc-sql', 'spring-jdbc-sql']);
  assert.deepEqual(scanned.unknown, []);
  assert.ok(scanned.fragments.some(f => f.literalKinds.includes('text-block')));
  assert.ok(scanned.fragments.some(f => f.literalKinds.length === 2));
});

test('exact Java offsets survive SQL parameters, literal concatenation and Java escapes', () => {
  const text = [
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.data.jpa.repository.Query;',
    'class Source {',
    '  void read(JdbcTemplate jdbc) {',
    '    jdbc.query("SELECT p.na\\155e FROM people p WHERE p.id = ?", rowMapper);',
    '    jdbc.queryForList("SELECT " + "p.name FROM people p WHERE p.id = :id");',
    '  }',
    '  @Query(value="SELECT p.name FROM people p WHERE p.id>?1", countQuery="SELECT COUNT(p.name) FROM people p", nativeQuery=true)',
    '  Object select(long id) { return null; }',
    '}'
  ].join('\r\n');
  const report = java(text), { references, unknown } = usagesInJava(report, target, options);
  assert.deepEqual(report.unknown, []);
  assert.deepEqual(unknown, []);
  assert.equal(references.length, 4);
  assert.ok(references.every(ref => ref.language === 'java' && !ref.editEligible));
  assert.ok(references.some(ref => text.slice(ref.start, ref.end) === 'na\\155e'));
  assert.equal(references.filter(ref => text.slice(ref.start, ref.end) === 'name').length, 3);
  for (const ref of references) assert.deepEqual(targetAtJava(report, ref.start + 1, options), target);
});

test('expression builders, unproved receivers and split identifiers are reported without speculative locations', () => {
  const text = [
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'class Source {',
    '  JdbcTemplate jdbc;',
    '  void read(String supplied, Object adapter) {',
    '    this.jdbc.query(supplied, handler);',
    '    adapter.query("SELECT name FROM people");',
    '    this.jdbc.query("SELECT na" + "me FROM people", handler);',
    '    this.jdbc.query("SELECT name FROM people WHERE id = :#{#expr}", handler);',
    '    String doc = "SELECT name FROM people";',
    '  }',
    '  void shadow(Object jdbc) { jdbc.query("SELECT name FROM people"); }',
    '}'
  ].join('\n');
  const report = java(text), result = usagesInJava(report, target, options);
  assert.deepEqual(result.references, []);
  assert.deepEqual(result.unknown.map(issue => issue.code), ['java-sql-split-token']);
  assert.deepEqual(report.unknown.map(issue => issue.code).sort(),
    ['java-receiver-uncertain','java-receiver-uncertain','java-sql-dynamic','java-sql-interpolation','java-sql-unassociated']);
  const offset = text.indexOf('na" + "me');
  assert.equal(targetAtJava(report, offset + 1, options), null);
});

test('Spring Data JPQL is excluded and typed EntityManager native statements retain physical scope', () => {
  const text = [
    'import jakarta.persistence.EntityManager;',
    'import jakarta.persistence.NamedNativeQuery;',
    'import org.springframework.data.jpa.repository.Query;',
    '@NamedNativeQuery(name="named", query="SELECT name FROM people")',
    'class Source {',
    '  @Query("SELECT person FROM Person person")',
    '  Object read(EntityManager em) {',
    '    return em.createNativeQuery("SELECT name FROM people WHERE id = ?1");',
    '  }',
    '}'
  ].join('\n');
  const report = java(text), found = usagesInJava(report, target, options);
  assert.deepEqual(report.unknown, []);
  assert.deepEqual(found.references.map(ref => ref.origin), ['native-query-annotation', 'entity-manager-native-query']);
  assert.ok(found.references.every(ref => text.slice(ref.start,ref.end) === 'name'));
});

test('unknown SQL is excluded and uncertain Java replacement boundaries suppress the file', () => {
  const heading = 'import org.springframework.jdbc.core.JdbcTemplate; class Probe { void f(JdbcTemplate jdbc) {';
  const unknown = java(heading + ' jdbc.query("SELECT absent.name FROM people p"); }}');
  assert.equal(unknown.unknown[0].code, 'embedded-sql-unresolved');
  assert.deepEqual(usagesInJava(unknown, target, options).references, []);
  const unicode = java(heading + ' jdbc.query("SELECT name FROM people"); /* \\u000A */ }}');
  assert.equal(unicode.unknown[0].code, 'java-source-uncertain');
  assert.deepEqual(unicode.fragments, []);
});
