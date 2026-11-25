'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {analyzeJPA,completionsAt,definitionsAt}=require('../src/jpa/model');
const {normalizeProviderProfile,providerProfileFromSnapshot}=require('../src/jpa/provider');
const files=[{uri:'file:///Person.java',text:'package example; import jakarta.persistence.*; @Entity class Person { @Id Long id; String name; java.time.LocalDate born; }'}];
const profile={id:'owned-runtime-profile',provider:'hibernate',version:'7.4.13.Final',source:'runtime-observed',observedAt:'2026-11-13T02:00:00Z',functions:{rb_upper:{state:'observed',minArgs:1,maxArgs:1,arguments:[{category:'STRING'}],returns:{javaType:'java.lang.String'}}}};
function query(text,supplied=profile,extra=[]){const file={uri:'file:///Probe.java',text:'package example; import jakarta.persistence.EntityManager; class Probe { EntityManager em; void run(){ em.createQuery('+JSON.stringify(text)+'); } }'};const model=analyzeJPA([...files,...extra,file],{providerProfile:supplied});return{model,file,query:model.queries.find(value=>value.uri===file.uri)};}
const types=query=>query.typeAnalysis.selectionTypes.map(value=>value.javaType);
test('runtime snapshot selection requires one factory or a unique explicit ID and preserves unknown return metadata',()=>{
  const factory={id:'sf1',provider:'hibernate',version:'7.4.13.Final',functions:[{name:'rb_upper',signature:'String rb_upper(STRING arg)',arguments:[{category:'STRING'}],minArgs:1,maxArgs:1,returns:{state:'unknown'},state:'observed'}]};
  const snapshot={state:'observed',observedAt:'2026-11-13T02:00:00Z',factories:[factory],authorization:'do-not-copy'};
  const p=providerProfileFromSnapshot(snapshot);assert.equal(p.enabled,true);assert.equal(p.source,'runtime-observed');assert.equal(p.functions.rb_upper.returns,null);assert.equal(JSON.stringify(p).includes('do-not-copy'),false);
  assert.equal(providerProfileFromSnapshot({...snapshot,factories:[factory,{...factory,id:'sf2'}]}),null);
  assert.equal(providerProfileFromSnapshot({...snapshot,factories:[factory,{...factory,id:'sf2'}]},'sf2').enabled,true);
  assert.equal(providerProfileFromSnapshot({...snapshot,state:'waiting'}),null);
  assert.equal(providerProfileFromSnapshot({...snapshot,state:'disconnected'}),null);
});
test('structured provider contracts type direct and FUNCTION calls and keep validity conditional',()=>{
  for(const text of ['select rb_upper(p.name) from Person p',"select function('rb_upper',p.name) from Person p"]){const q=query(text).query;assert.equal(q.status,'known');assert.equal(q.typeAnalysis.state,'known',q.typeAnalysis.coverage.unknown.join('; '));assert.deepEqual(types(q),['java.lang.String']);assert.equal(q.providerAnalysis.sourceRevisionMatched,false);assert.equal(q.providerAnalysis.usedFunctions[0].certainty,'runtime-profile-contract');assert.equal(q.typeAnalysis.validityVerified,false);}
  assert.equal(query('select rb_upper(p.id) from Person p').query.typeAnalysis.state,'invalid');
  assert.equal(query('select rb_upper(p.name,p.name) from Person p').query.typeAnalysis.state,'invalid');
});
test('registry signatures and unsupported provider versions never invent a typed return contract',()=>{
  const unknown={...profile,functions:{rb_upper:{signature:'String rb_upper(STRING arg)',state:'unknown'}}};
  assert.equal(query('select rb_upper(p.name) from Person p',unknown).query.typeAnalysis.state,'unknown');
  assert.equal(query('select rb_upper(p.name) from Person p',{...profile,version:'7.5.0.Final'}).query.typeAnalysis.state,'unknown');
  assert.equal(query('select rb_upper(p.name) from Person p',null).query.typeAnalysis.state,'unknown');
  let invoked=0;const functions={};Object.defineProperty(functions,'rb_upper',{enumerable:true,get(){invoked++;return profile.functions.rb_upper;}});normalizeProviderProfile({...profile,functions});assert.equal(invoked,0);
});
test('literal contributor builder metadata remains a source-declared activation-unverified candidate',()=>{
  const source={uri:'file:///Functions.java',text:'package example; import org.hibernate.boot.model.FunctionContributor; import org.hibernate.boot.model.FunctionContributions; import org.hibernate.query.sqm.produce.function.FunctionParameterType; import org.hibernate.type.StandardBasicTypes; class Functions implements FunctionContributor { public void contributeFunctions(FunctionContributions f) { f.getFunctionRegistry().namedDescriptorBuilder("rb_upper","upper").setExactArgumentCount(1).setParameterTypes(FunctionParameterType.STRING).setInvariantType(f.getTypeConfiguration().getBasicTypeRegistry().resolve(StandardBasicTypes.STRING)).register(); } }'};
  const {query:q}=query('select rb_upper(p.name) from Person p',{...profile,functions:{rb_upper:{state:'unknown',signature:'observed registry name'}}},[source]);
  assert.equal(q.typeAnalysis.state,'unknown');assert.deepEqual(types(q),['java.lang.String']);assert.ok(q.providerAnalysis.usedFunctions.some(value=>value.certainty==='source-declared-registration-unverified'&&value.contributor==='example.Functions'));
});
test('Hibernate temporal durations use explicit profile types and leave incompatible categories unknown',()=>{
  const q=query('select local date - local date, local datetime + 1 hour, (local date - local date) by day from Person p').query;
  assert.equal(q.typeAnalysis.state,'known',q.typeAnalysis.coverage.unknown.join('; '));assert.deepEqual(types(q),['java.time.Duration','java.time.LocalDateTime','java.lang.Long']);
  assert.equal(query('select local date - local date from Person p',null).query.typeAnalysis.state,'unknown');
  assert.equal(query('select local date - local datetime from Person p').query.typeAnalysis.state,'unknown');
});
test('aggregate FILTER and window partition/order/frame expressions are typed without claiming complete HQL grammar',()=>{
  const q=query('select sum(p.id) filter (where p.id > 1) over (partition by p.name order by p.id rows between unbounded preceding and current row) from Person p').query;
  assert.equal(q.typeAnalysis.state,'known',q.typeAnalysis.coverage.unknown.join('; '));assert.deepEqual(types(q),['java.lang.Long']);assert.ok(q.providerAnalysis.usedFeatures.includes('aggregate-filter'));assert.ok(q.providerAnalysis.usedFeatures.includes('aggregate-window'));
  assert.equal(query('select count(p) filter (where p.name) over () from Person p').query.typeAnalysis.state,'invalid');
  assert.equal(query('select count(p) over () from Person p',null).query.typeAnalysis.state,'unknown');
  assert.equal(query('select count(p) over (order by p.id rows unbounded preceding exclude ties) from Person p').query.typeAnalysis.state,'unknown');
});
test('HQL EXTRACT field and CAST target extensions return profile-specific Java types',()=>{
  const q=query('select extract(day of year from p.born), cast(p.id as BigDecimal), extract(second from current_timestamp) from Person p').query;
  assert.equal(q.typeAnalysis.state,'known',q.typeAnalysis.coverage.unknown.join('; '));assert.deepEqual(types(q),['java.lang.Integer','java.math.BigDecimal','java.lang.Float']);
});
test('Spring Data array IN bindings check elements under a selected supported provider profile',()=>{
  const repo={uri:'file:///Repo.java',text:'package example; import java.util.List; import org.springframework.data.jpa.repository.JpaRepository; import org.springframework.data.jpa.repository.Query; import org.springframework.data.repository.query.Param; interface Repo extends JpaRepository<Person,Long> { @Query("select p from Person p where p.id in :ids") List<Person> byIds(@Param("ids") Long[] ids); }'};
  const model=analyzeJPA([...files,repo],{providerProfile:profile}),q=model.queries.find(value=>value.uri===repo.uri);assert.equal(q.typeAnalysis.state,'known',q.typeAnalysis.coverage.unknown.join('; '));assert.ok(q.providerAnalysis.usedFeatures.includes('spring-data-array-binding'));
});
test('an explicit Hibernate profile types chained CTE and FROM-derived scalar outputs',()=>{
  const cte=query('with picked as (select p.id as ownerId, p.name as displayName from Person p where p.id > :start), filtered as (select t.ownerId as keyId, t.displayName as label from picked t) select f.label, f.keyId from filtered f where f.keyId >= :stop');
  assert.equal(cte.query.typeAnalysis.state,'known',cte.query.typeAnalysis.coverage.unknown.join('; '));
  assert.deepEqual(types(cte.query),['java.lang.String','java.lang.Long']);
  assert.deepEqual(cte.query.typeAnalysis.parameters.map(p=>[p.key,p.expectedTypes[0].javaType]),[[':start','java.lang.Long'],[':stop','java.lang.Long']]);
  assert.ok(cte.query.providerAnalysis.usedFeatures.includes('hql-common-table-expression'));
  assert.equal(cte.query.providerAnalysis.allRuntimeRegistrationsVerified,false);
  const reference=cte.file.text.indexOf('f.label')+'f.la'.length;
  const definition=definitionsAt(cte.model,cte.file.uri,reference);
  assert.equal(definition[0].uri,cte.file.uri);
  assert.equal(definition[0].range.start.character,cte.file.text.indexOf('as label')+'as '.length);
  assert.ok(completionsAt(cte.model,cte.file.uri,reference).some(item=>item.label==='label'));
  const derived=query('select x.displayName, x.exactId from (select p.name as displayName, p.id as exactId from Person p where p.id >= ?1) x order by x.exactId').query;
  assert.equal(derived.typeAnalysis.state,'known',derived.typeAnalysis.coverage.unknown.join('; '));
  assert.deepEqual(types(derived),['java.lang.String','java.lang.Long']);
  assert.equal(derived.typeAnalysis.parameters[0].position,1);
  assert.equal(derived.typeAnalysis.parameters[0].expectedTypes[0].javaType,'java.lang.Long');
  assert.ok(derived.providerAnalysis.usedFeatures.includes('hql-derived-relation'));
});
test('set scopes type each arm and deliberately flag arity and definite Java clashes',()=>{
  for(const operation of ['union all','intersect','except']){
    const {query:q}=query('select p.id as number from Person p where p.id >= :floor '+operation+' select p.id as number from Person p where p.id <= :ceiling order by number');
    assert.equal(q.typeAnalysis.state,'known',q.typeAnalysis.coverage.unknown.join('; '));
    assert.deepEqual(types(q),['java.lang.Long']);
    assert.deepEqual(q.typeAnalysis.parameters.map(p=>[p.key,p.expectedTypes[0].javaType]),[[':floor','java.lang.Long'],[':ceiling','java.lang.Long']]);
    assert.ok(q.providerAnalysis.usedFeatures.includes('hql-set-operation'));
  }
  for(const [right,code] of [['p.id, p.name','jpa.type.set.arity'],['p.name','jpa.type.set.column']]){
    const {query:q}=query('select p.id from Person p union select '+right+' from Person p');
    assert.equal(q.typeAnalysis.state,'invalid');
    assert.ok(q.typeAnalysis.diagnostics.some(item=>item.code===code));
  }
});
test('missing profiles and unsupported or unresolved query graphs retain scoped uncertainty',()=>{
  for(const text of ['with x as (select p.id from Person p) select x from x','with x as (select y.rid as rid from x y) select z.rid from x z',
    'with x as (select y.id as id from y y), y as (select p.id as id from Person p) select z.id from x z',
    'select x.id from (select o.id as id from Person p) x','select arbitrary_java(p.id) from Person p']){
    const q=query(text).query;
    assert.equal(q.typeAnalysis.state,'unknown',text);
    assert.equal(q.typeAnalysis.diagnostics.some(value=>value.severity==='warning'),false);
    assert.equal(q.providerAnalysis.allRuntimeRegistrationsVerified,false);
  }
  assert.equal(query('select p.id from Person p union select p.id from Person p',null).query.typeAnalysis.state,'unknown');
});
test('very deep operator ASTs stop as unknown rather than overflowing the analysis stack',()=>{
  const q=query('select '+Array(1000).fill('1').join('+')+' from Person p').query;assert.equal(q.typeAnalysis.state,'unknown');assert.ok(q.typeAnalysis.coverage.unknown.some(value=>value.includes('depth')));
});
