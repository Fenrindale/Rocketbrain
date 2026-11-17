'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseJavaFile,lexJava,literal}=require('../src/spring/java');
const {parseXml,applyOrmMappings}=require('../src/jpa/xml');
const xml=text=>({uri:'file:///app/META-INF/orm.xml',text:'<?xml version="1.0"?><entity-mappings xmlns="https://jakarta.ee/xml/ns/persistence/orm" version="3.2">'+text+'</entity-mappings>'});
const source=(name,text)=>{const file={uri:'file:///app/'+name+'.java',text};return {...parseJavaFile(file),tokens:lexJava(text).tokens};};
const annot=(owner,name)=>owner.annotations.find(item=>item.shortName===name);

test('XML-only managed class and annotation overrides use the local Java source without executing code',()=>{
  const files=[source('Plain','package demo; class Plain { Long id; String label; }'),source('Old','package demo; import jakarta.persistence.*; @Entity @Table(name="wrong") class Old { @Id Long id; @Column(name="wrong_label",length=10) String label; }')];
  const result=applyOrmMappings(files,[xml('<package>demo</package><entity class="Plain"><table name="xml_plain"/><attributes><id name="id"><column name="plain_id"/></id><basic name="label"><column name="xml_label" length="70"/></basic></attributes></entity><entity class="Old"><table name="xml_old"/><attributes><basic name="label"><column name="right_label" length="90"/></basic></attributes></entity>')]);
  assert.equal(result.issues.length,0,JSON.stringify(result.issues));
  assert.ok(annot(files[0].types[0],'Entity'));assert.equal(literal(annot(files[0].types[0],'Table'),'name'),'xml_plain');
  assert.equal(literal(annot(files[1].types[0],'Table'),'name'),'xml_old');
  const column=annot(files[1].types[0].fields.find(f=>f.name==='label'),'Column');assert.equal(literal(column,'name'),'right_label');assert.equal(column.attributes.length[0].text,'90');
  assert.equal(column._xmlSource.uri,'file:///app/META-INF/orm.xml');
});

test('XML metadata-complete clears ignored annotation mappings and respects explicit PROPERTY access',()=>{
  const files=[source('Account','package demo; import jakarta.persistence.*; @Entity @Table(name="ignored") class Account { @Id Long id; String label; public Long getId(){return id;} public String getLabel(){return label;} }')];
  const result=applyOrmMappings(files,[xml('<package>demo</package><entity class="Account" access="PROPERTY" metadata-complete="true"><table name="accounts"/><attributes><id name="id"/><basic name="label"><column name="account_label"/></basic></attributes></entity>')]);
  assert.equal(result.issues.length,0);const type=files[0].types[0];assert.equal(type.fields[0].annotations.length,0);assert.ok(annot(type.methods.find(m=>m.name==='getId'),'Id'));assert.equal(annot(type,'Access').attributes.value.at(-1).text,'PROPERTY');
});

test('DTD, custom entities, foreign namespaces and malformed XML fail closed and make physical defaults uncertain',()=>{
  for(const mapping of [
    {uri:'file:///bad.xml',text:'<!DOCTYPE x [<!ENTITY xx SYSTEM "file:///private">]><entity-mappings xmlns="https://jakarta.ee/xml/ns/persistence/orm" version="3.2"/>'},
    xml('<package>&external;</package>'),
    {uri:'file:///bad.xml',text:'<entity-mappings xmlns="https://example.invalid/orm" version="3.2"/>'},
    xml('<entity class="demo.Guard"></embeddable>'),
    xml('<entity class="demo.Guard" class="demo.Other"/>'),xml('<package>demo\0</package>'),xml('<package>demo]]></package>')
  ]){
    const files=[source('Guard','package demo; import jakarta.persistence.*; @Entity class Guard { @Id Long id; }')];
    const result=applyOrmMappings(files,[mapping]);assert.ok(result.issues.length);assert.equal(files[0].types[0].jpaXmlPartial,true);
  }
  assert.throws(()=>parseXml({uri:'file:///large.xml',text:'x'.repeat(1024*1024+1)}),/limit/);
});

test('overlapping mapping files do not select a last-writer winner',()=>{
  const files=[source('Guard','package demo; import jakarta.persistence.*; @Entity @Table(name="annotated") class Guard { @Id Long id; }')];
  const first=xml('<entity class="demo.Guard"><table name="first"/></entity>'),second={...xml('<entity class="demo.Guard"><table name="second"/></entity>'),uri:'file:///other.xml'};
  const result=applyOrmMappings(files,[first,second]);assert.ok(result.issues.some(i=>/Overlapping/.test(i.message)));assert.equal(files[0].types[0].jpaXmlPartial,true);assert.equal(literal(annot(files[0].types[0],'Table'),'name'),'annotated');
});

test('XML named query entity references preserve decoded and CDATA source offsets',()=>{
  const file=xml('<named-query name="byName"><query>select p from Person p where p.label &lt;&gt; \'x\' and <![CDATA[p.label <> \'😀\']]></query></named-query>');
  const {queries}=applyOrmMappings([], [file]);assert.equal(queries.length,1);const query=queries[0];assert.match(query.text,/p.label <> 'x'/);assert.match(query.text,/😀/);assert.equal(query._map.length,query.text.length);assert.equal(query._ends.length,query.text.length);
  const less=query.text.indexOf('<');assert.equal(file.text.slice(query._map[less],query._ends[less]),'&lt;');const emoji=query.text.indexOf('😀');assert.equal(file.text.slice(query._map[emoji],query._ends[emoji+1]),'😀');
});

test('prefixed ORM namespaces and nested XML override annotations are normalized',()=>{
  const files=[source('Person','package demo; import jakarta.persistence.*; @Entity class Person { @Id Long id; @Embedded Address home; }')];
  const file={uri:'file:///prefixed.xml',text:'<o:entity-mappings xmlns:o="https://jakarta.ee/xml/ns/persistence/orm" version="3.2"><o:entity class="demo.Person"><o:attributes><o:embedded name="home"><o:attribute-override name="city"><o:column name="home_city"/></o:attribute-override></o:embedded></o:attributes></o:entity></o:entity-mappings>'};
  const result=applyOrmMappings(files,[file]);assert.equal(result.issues.length,0);const override=annot(files[0].types[0].fields.find(f=>f.name==='home'),'AttributeOverride');assert.equal(literal(override,'name'),'city');assert.match(override.attributes.column.map(t=>t.text).join(''),/home_city/);
});

test('unsupported and duplicate XML mappings never silently preserve definite physical defaults',()=>{
  for(const body of ['<entity class="demo.Person"><table name="a"/><table name="b"/></entity>','<entity class="demo.Person"><attributes><basic name="name"><column name="a"/><column name="b"/></basic></attributes></entity>','<entity class="demo.Person"><attributes><basic name="absent"/></attributes></entity>','<entity class="demo.Person"><sql-result-set-mapping name="unmodeled"/></entity>']){
    const files=[source('Person','package demo; import jakarta.persistence.*; @Entity class Person { @Id Long id; String name; }')];const result=applyOrmMappings(files,[xml(body)]);assert.ok(result.issues.length,body);assert.equal(files[0].types[0].jpaXmlPartial,true,body);
  }
});

test('the combined model compares the XML physical names and keeps malformed XML from creating false absence findings',()=>{
  const {analyzeJPA,compareCatalog}=require('../src/jpa/model');
  const javaFiles=[{uri:'file:///app/Entry.java',text:'package demo; class Entry { Long id; String label; }'}];
  const mapping=xml('<entity class="demo.Entry" name="XmlEntry" access="FIELD" metadata-complete="true"><table name="xml_entries"/><attributes><id name="id"/><basic name="label"><column name="xml_label" length="90"/></basic></attributes></entity>');
  const model=analyzeJPA(javaFiles,{physicalNaming:'standard',mappingFiles:[mapping]});assert.equal(model.entities.length,1);assert.equal(model.entities[0].name,'XmlEntry');
  const comparison=compareCatalog(model,{database:'app',tables:[{name:'xml_entries',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'xml_label',type:'varchar(90)',nullable:true}]}]});assert.equal(comparison.mismatches.length,0);assert.equal(comparison.matches.length,2);
  const partial=analyzeJPA([{uri:'file:///app/A.java',text:'package demo; import jakarta.persistence.*; @Entity class A { @Id Long id; }'}],{physicalNaming:'standard',mappingFiles:[xml('<entity class="demo.A"><unmodeled/></entity>')]});
  assert.equal(compareCatalog(partial,{tables:[]}).mismatches.length,0);assert.ok(partial.diagnostics.some(d=>d.code==='jpa.xml.unknown'));
});

test('file schema defaults apply to listed tables while an explicit annotation schema takes precedence',()=>{
  const files=[source('A','package demo; import jakarta.persistence.*; @Entity @Table(name="a",schema="explicit") class A { @Id Long id; }'),source('B','package demo; class B { Long id; }')];
  const result=applyOrmMappings(files,[xml('<schema>default_schema</schema><entity class="demo.A"/><entity class="demo.B"><table name="b"/><attributes><id name="id"/></attributes></entity>')]);assert.equal(result.issues.length,0);assert.equal(literal(annot(files[0].types[0],'Table'),'schema'),'explicit');assert.equal(literal(annot(files[1].types[0],'Table'),'schema'),'default_schema');
});

test('class XML overrides replace the same annotation path and preserve different paths',()=>{
  const files=[source('A','package demo; import jakarta.persistence.*; @Entity @AttributeOverrides({@AttributeOverride(name="home.city",column=@Column(name="old_city")),@AttributeOverride(name="home.postal",column=@Column(name="postal"))}) class A { @Id Long id; @Embedded Address home; }')];
  const result=applyOrmMappings(files,[xml('<entity class="demo.A"><attribute-override name="home.city"><column name="xml_city"/></attribute-override></entity>')]);assert.equal(result.issues.length,0);const outer=annot(files[0].types[0],'AttributeOverrides');const tokens=outer.attributes.value.map(t=>t.text).join('');assert.match(tokens,/xml_city/);assert.match(tokens,/postal/);assert.doesNotMatch(tokens,/old_city/);
});
