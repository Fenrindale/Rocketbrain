'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { analyzeJPA } = require('../src/jpa/model');
const { analyzeQueryTypes } = require('../src/jpa/types');
const { callContext, methodContext } = require('../src/jpa/type-context');
const { parseJavaFile, lexJava } = require('../src/spring/java');
const { completionsAt, definitionsAt } = require('../src/jpa/query');
const files = [
  { uri: 'file:///Person.java', text: 'package typed; import java.util.Set; import java.math.BigDecimal; import jakarta.persistence.*; @Entity class Person { @Id Long id; String name; Integer age; BigDecimal salary; Boolean enabled; @ManyToOne Department department; @ElementCollection Set<String> tags; }' },
  { uri: 'file:///Department.java', text: 'package typed; import jakarta.persistence.*; @Entity class Department { @Id Long id; String name; }' },
  { uri: 'file:///Summary.java', text: 'package typed; public class Summary { public Summary(String name,Long total) {} }' }
];
function fixture(text, extra = {}, javaTail = '') {
  const file = { uri: 'file:///Probe.java', text: 'package typed; import java.util.*; import jakarta.persistence.EntityManager; class Probe { EntityManager em; void run() { ' + javaTail + ' em.createQuery(' + JSON.stringify(text) + '); } }' };
  const model = analyzeJPA([...files, file]); const query = model.queries.find(value => value.text === text); assert.ok(query, text);
  const parsed = { ...parseJavaFile(file), tokens: lexJava(file.text).tokens }, index = parsed.tokens.findIndex(token => token.text === 'createQuery');
  const context = { ...callContext(parsed, index), ...extra };
  const result = analyzeQueryTypes(model, file, query, context);
  return { model, file, query, result };
}
const names = result => result.selectionTypes.map(type => type.javaType);

test('typed aggregates use Java projection types and numeric CASE/coalesce promotion', () => {
  const aggregates = fixture('select count(p), sum(p.id), avg(p.id), min(p.name), max(p.id) from Person p').result;
  assert.equal(aggregates.state, 'known', aggregates.coverage.unknown.join('; '));
  assert.deepEqual(names(aggregates), ['java.lang.Long','java.lang.Long','java.lang.Double','java.lang.String','java.lang.Long']);
  const numeric = fixture("select p.id + 1, p.id + 0.5, case when p.id > 1 then p.id else 0L end, coalesce(p.name, 'none') from Person p").result;
  assert.equal(numeric.state, 'known', numeric.coverage.unknown.join('; ')); assert.deepEqual(names(numeric), ['java.lang.Long','java.lang.Double','java.lang.Long','java.lang.String']);
});
test('function contracts and operator predicates reject known domain mismatches', () => {
  for (const text of ['select p.name + 1 from Person p','select length(p.id) from Person p','select p from Person p where p.department = p.id','select p from Person p where p.name','select p from Person p where p.id in (select d.name from Department d)','update Person p set p.department = \'wrong\'']) {
    const result = fixture(text).result; assert.equal(result.state, 'invalid', text + ': ' + result.coverage.unknown.join('; ')); assert.ok(result.diagnostics.some(item => item.severity === 'warning'), text);
  }
});
test('DTO construction checks real local constructor parameter signatures', () => {
  const valid = fixture('select new typed.Summary(p.name, count(p)) from Person p group by p.name').result;
  assert.equal(valid.state, 'known', valid.coverage.unknown.join('; ')); assert.deepEqual(names(valid), ['typed.Summary']);
  assert.equal(fixture('select new typed.Summary(p.name, p.name) from Person p').result.state, 'invalid');
  assert.equal(fixture('select new external.Summary(p.name, p.id) from Person p').result.state, 'unknown');
});
test('typed query result targets distinguish scalar, entity and multi-select Object arrays', () => {
  assert.equal(fixture('select p.name from Person p', { resultType: 'java.lang.Long' }).result.state, 'invalid');
  assert.equal(fixture('select p from Person p', { resultType: 'typed.Person' }).result.state, 'known');
  assert.equal(fixture('select p.name, p.id from Person p', { resultType: 'java.lang.Object[]' }).result.state, 'known');
  assert.equal(fixture('select p.name, p.id from Person p', { resultType: 'java.lang.String' }).result.state, 'invalid');
});
test('parameter constraints validate static Java bindings and retain source positions', () => {
  const valid = fixture('select p from Person p where p.id = :id', { bindings: [{ name: 'id', javaType: 'long', source: 'unit-static', state: 'known' }] }).result;
  assert.equal(valid.state, 'known'); assert.equal(valid.parameters[0].state, 'known'); assert.equal(valid.parameters[0].expectedTypes[0].javaType, 'java.lang.Long');
  const invalid = fixture('select p from Person p where p.id = :id', { bindings: [{ name: 'id', javaType: 'java.lang.String', source: 'unit-static', state: 'known' }] }).result;
  assert.equal(invalid.state, 'invalid'); assert.ok(invalid.diagnostics.some(item => item.code === 'jpa.type.parameter.binding'));
  assert.equal(fixture('select p from Person p where p.id = :same and p.name = :same').result.state, 'invalid');
});
test('IN collection bindings, MEMBER OF and correlated entity subqueries use element types', () => {
  const collection = fixture('select p from Person p where p.id in :ids', { bindings: [{ name: 'ids', javaType: 'java.util.List<java.lang.Long>', source: 'unit-static', state: 'known' }] }).result;
  assert.equal(collection.state, 'known', collection.coverage.unknown.join('; '));
  assert.equal(fixture('select p from Person p where p.id in :ids', { bindings: [{ name: 'ids', javaType: 'java.util.List<java.lang.String>', source: 'unit-static', state: 'known' }] }).result.state, 'invalid');
  const array = fixture('select p from Person p where p.id in :ids', { parameterContract:'spring-data-method',bindings: [{ name:'ids',javaType:'java.lang.Long[]',source:'spring-data-param-annotation',state:'known' }] }).result;
  assert.equal(array.state,'unknown');assert.equal(array.diagnostics.some(item=>item.severity==='warning'),false,'unsupported array/collection adaptation must not become a false invalid query');
  assert.equal(fixture("select p from Person p where 'hello' member of p.tags").result.state, 'known');
  assert.equal(fixture('select p from Person p where p.department in (select d from Department d where d.id = p.department.id)').result.state, 'known');
});
test('LIKE, BETWEEN, Boolean conditions and functions type every supported predicate child', () => {
  const result = fixture("select upper(p.name), substring(p.name, 1, 2), abs(p.id), size(p.tags) from Person p where p.enabled = true and p.age between 1 and 10 and p.name like :name").result;
  assert.equal(result.state, 'known', result.coverage.unknown.join('; ')); assert.deepEqual(names(result), ['java.lang.String','java.lang.String','java.lang.Long','java.lang.Integer']);
  assert.equal(fixture("select p from Person p where p.id like 'hello'").result.state, 'invalid');
});
test('integral division, provider functions and unresolved types stay unknown without an invalid verdict', () => {
  for (const text of ['select p.id / 2 from Person p','select current_date - current_date from Person p',"select function('vendor', p.id) from Person p",'select x from External x where x.id = 1','select constructor from Person p']) {
    const result = fixture(text).result; assert.equal(result.state, 'unknown', text); assert.equal(result.diagnostics.some(item => item.severity === 'warning'), false);
  }
  assert.equal(fixture('select p.name as __proto__ from Person p order by __proto__').result.state,'known');
});
test('Java type metadata reads class result arguments and chained static setParameter calls', () => {
  const file = { uri:'file:///Context.java',text:'package typed; import java.util.*; import jakarta.persistence.EntityManager; class Context { EntityManager em; void run() { List<Long> ids=List.of(1L,2L); em.createQuery("select p.name from Person p where p.id in :ids",String.class).setParameter("ids",ids); em.createQuery("select p from Person p where p.id=:id").setParameter("id","bad"); } }' };
  const parsed = { ...parseJavaFile(file), tokens:lexJava(file.text).tokens }, calls=parsed.tokens.map((token,index)=>token.text==='createQuery'?index:-1).filter(index=>index>=0);
  const first=callContext(parsed,calls[0]),second=callContext(parsed,calls[1]); assert.equal(first.resultType,'java.lang.String'); assert.equal(first.bindings[0].javaType,'java.util.List<java.lang.Long>'); assert.equal(second.bindings[0].javaType,'java.lang.String');
});
test('Spring Data @Param and positional method types are sourced without assuming compiler parameter flags', () => {
  const file={uri:'file:///Repository.java',text:'package typed; import java.util.List; import org.springframework.data.repository.query.Param; interface Repository { List<String> names(@Param("id") Long id); List<String> implicit(Long id); }'};
  const parsed=parseJavaFile(file), methods=parsed.types[0].methods;
  assert.deepEqual(methodContext(parsed,methods[0]).bindings.map(value=>[value.name??value.position,value.javaType,value.state]),[['id','java.lang.Long','known'],[1,'java.lang.Long','known']]);
  assert.equal(methodContext(parsed,methods[1]).bindings[0].state,'unknown');
});
test('converter relational metadata does not replace Java domain projection types', () => {
  const {model,file,query}=fixture('select p.name from Person p');
  model.entities.find(value=>value.name==='Person').attributes.find(value=>value.name==='name').converter={domainType:'java.lang.String',databaseType:'java.lang.Integer'};
  const result=analyzeQueryTypes(model,file,query,{resultType:'java.lang.String'});assert.equal(result.state,'known');assert.deepEqual(names(result),['java.lang.String']);
});
test('a parenthesized IN parameter accepts scalar or collection bindings without false invalid types', () => {
  for (const javaType of ['java.lang.Long','java.util.List<java.lang.Long>']) assert.equal(fixture('select p from Person p where p.id in (:id)',{bindings:[{name:'id',javaType,source:'static',state:'known'}]}).result.state,'known');
  assert.equal(fixture('select p from Person p where p.id in (:id)',{bindings:[{name:'id',javaType:'java.lang.String',source:'static',state:'known'}]}).result.state,'invalid');
});
test('unresolved declarations and unsupported direct collection projections do not acquire complete typed coverage', () => {
  for(const text of ['select p from Person p join p.name n','select p from Person p, External x','select p.tags from Person p']) {
    const result=fixture(text).result;assert.equal(result.state,'unknown',text);assert.equal(result.coverage.allSupportedComponentsChecked,false);
  }
});
function at(text, marker, advance=0) { const index=text.indexOf(marker);assert.ok(index>=0,marker);const lines=text.slice(0,index+advance).split('\n');return{line:lines.length-1,character:lines.at(-1).length}; }
test('finite cross-file Java query candidates keep source navigation and conservative shared completions', () => {
  const parts={uri:'file:///Parts.java',text:'package typed; public class Parts { public static final String BASE="select p from Person p where p.name"; }'};
  const usage={uri:'file:///Use.java',text:'package typed; import jakarta.persistence.EntityManager; class Use { EntityManager em; void run(boolean choice) { final String sql=choice?Parts.BASE+" = :name":Parts.BASE+" like :name"; em.createQuery(sql).setParameter("name","Alex"); } }'};
  const model=analyzeJPA([...files,parts,usage]),queries=model.queries.filter(value=>value.uri===usage.uri);
  assert.equal(queries.length,2);assert.ok(queries.every(value=>value.dynamicResolution.state==='finite'&&value.typeAnalysis.state==='known'&&value.executedUserCode===false));
  assert.ok(definitionsAt(model,parts.uri,at(parts.text,'p.name',3)).some(value=>value.uri==='file:///Person.java'));
  assert.ok(completionsAt(model,parts.uri,at(parts.text,'p.name',2)).some(value=>value.label==='name'));
  assert.deepEqual(completionsAt(model,usage.uri,at(usage.text,'Parts.BASE',6)),[]);
});
test('Spring Data entityName templates read original Java annotations and ignore XML entity-name overrides', () => {
  const declared=files.map(value=>value.uri==='file:///Person.java'?{...value,text:value.text.replace('@Entity class Person','@Entity(name="OriginalPerson") class Person')}:value);
  const repository={uri:'file:///Repo.java',text:'package typed; import org.springframework.data.jpa.repository.JpaRepository; import org.springframework.data.jpa.repository.Query; interface Repo extends JpaRepository<Person,Long> { @Query("select p from #{#entityName} p") Person find(); }'};
  const xml={uri:'file:///orm.xml',text:'<entity-mappings xmlns="https://jakarta.ee/xml/ns/persistence/orm" version="3.2"><entity class="typed.Person" name="XmlPerson"/></entity-mappings>'};
  const model=analyzeJPA([...declared,repository],{mappingFiles:[xml]}),query=model.queries.find(value=>value.uri===repository.uri);
  assert.ok(query);assert.equal(query.text,'select p from OriginalPerson p');assert.equal(query.status,'unknown');assert.equal(query.typeAnalysis.state,'unknown');
});
test('actual type fixture matches positive Java projections, all nine typed counterexamples and restricted SpEL candidates', () => {
  const directory=path.join(__dirname,'fixtures/spring-boot-app/src/main/java/fixture/boot');
  const actual=fs.readdirSync(directory).filter(name=>name.endsWith('.java')).map(name=>{const file=path.join(directory,name);return{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')};});
  const xml=path.join(__dirname,'fixtures/spring-boot-app/src/main/resources/META-INF/orm.xml');
  const model=analyzeJPA(actual,{basePackages:['fixture.boot'],mappingFiles:[{uri:pathToFileURL(xml).href,text:fs.readFileSync(xml,'utf8')}]}),queries=model.queries.filter(value=>value.uri.endsWith('/TypeProbeService.java'));
  const aggregate=queries.find(value=>value.text?.startsWith('select count(p), sum'));
  assert.equal(aggregate.typeAnalysis.state,'known');assert.deepEqual(names(aggregate.typeAnalysis),['java.lang.Long','java.lang.Long','java.lang.Double','java.lang.String','java.lang.Long']);
  const dto=queries.find(value=>value.text?.includes('TypedSummary(p.displayName, count(p))'));assert.equal(dto.typeAnalysis.state,'known',dto.typeAnalysis.coverage.unknown.join('; '));
  assert.equal(queries.filter(value=>value.typeAnalysis?.state==='invalid').length,9);
  const finite=queries.filter(value=>value.dynamicResolution?.state==='finite');assert.equal(finite.length,2);assert.ok(finite.every(value=>value.typeAnalysis.state==='known'));
  const repository=model.queries.filter(value=>value.uri.endsWith('/TypedPersonRepository.java'));assert.ok(repository.length>=7);assert.ok(repository.every(value=>value.typeAnalysis?.state==='known'));
  const badSpel=queries.filter(value=>value.symbolicParameters?.some(parameter=>parameter.state==='unknown'));assert.equal(badSpel.length,2);assert.ok(badSpel.every(value=>value.typeAnalysis.state==='unknown'));
});
