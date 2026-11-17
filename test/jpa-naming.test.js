'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createNamingResolver}=require('../src/jpa/naming');
const {analyzeJPA,compareCatalog}=require('../src/jpa/model');
const NS='org.hibernate.boot.model.naming.';
const source=(name,body,parent='PhysicalNamingStrategyStandardImpl')=>({uri:name+'.java',text:`package n; import org.hibernate.boot.model.naming.*; import org.hibernate.engine.jdbc.env.spi.JdbcEnvironment; import java.util.Locale; public class ${name} extends ${parent} { ${body} }`});
const method=body=>`public Identifier toPhysicalColumnName(Identifier name, JdbcEnvironment env) { ${body} }`;
const resolver=(body,extra=[])=>createNamingResolver([source('Strategy',method(body)),...extra],{physical:'n.Strategy'},'standard');
test('real fixture local helper computes table, explicit columns, implicit columns and quoted names',()=>{
  const dir=path.join(__dirname,'fixtures/spring-boot-app/src/main/java/fixture/boot');
  const files=['FixturePhysicalNamingStrategy.java','FixtureImplicitNamingStrategy.java'].map(n=>({uri:n,text:fs.readFileSync(path.join(dir,n),'utf8')}));
  const r=createNamingResolver(files,{physical:'fixture.boot.FixturePhysicalNamingStrategy',implicit:'fixture.boot.FixtureImplicitNamingStrategy'},'standard');
  assert.equal(r.physical('Already_Explicit','table').physicalName,'v6_already_explicit');
  assert.equal(r.physical('displayName').physicalName,'c_display_name');
  assert.equal(r.physical('displayAlias','column',{explicit:false,propertyPath:'displayAlias'}).physicalName,'c_logical_display_alias');
  assert.deepEqual([r.physical('`QuotedValue`').physicalName,r.physical('`QuotedValue`').quoted],['QuotedValue',true]);
});
test('unknown branch is evaluated per identifier; unsupported environment call never executes',()=>{
  const r=resolver('if (name.getText().startsWith("safe")) return Identifier.toIdentifier("ok_" + name.getText()); return Identifier.toIdentifier(System.getenv("SECRET"));');
  assert.equal(r.physical('safeName').physicalName,'ok_safeName');
  const unknown=r.physical('other');assert.equal(unknown.certainty,'unknown');assert.equal(unknown.physicalName,null);assert.match(unknown.reason,/External\/static/);
});
test('field constants, assignment and string transformations remain bounded and deterministic',()=>{
  const file=source('Strategy',`private static final String PREFIX="pre_"; ${method('String text=name.getText().replace("-", "_"); text=text.substring(0, text.length()).toUpperCase(Locale.ROOT); return Identifier.toIdentifier(PREFIX + text + "_end", name.isQuoted());')}`);
  const r=createNamingResolver([file],{physical:'n.Strategy'});assert.equal(r.physical('some-name').physicalName,'pre_SOME_NAME_end');
});
test('inherits unmodified built-in methods and resolves local superclass helper implementations',()=>{
  const files=[source('Parent',method('return Identifier.toIdentifier("p_" + name.getText());')),source('Child','','Parent')];
  const r=createNamingResolver(files,{physical:'n.Child'});assert.equal(r.physical('item').physicalName,'p_item');assert.equal(r.physical('TableName','table').physicalName,'TableName');
});
test('modern Hibernate snake strategy preserves quotes and follows supported ASCII boundary behavior',()=>{
  const r=createNamingResolver([],{physical:NS+'PhysicalNamingStrategySnakeCaseImpl'});
  assert.equal(r.physical('SomeURLValue').physicalName,'someurlvalue');
  assert.equal(r.physical('fooB').physicalName,'foob');
  assert.equal(r.physical('a.Bc').physicalName,'a_bc');
  assert.equal(r.physical('`KeepMixed`').physicalName,'KeepMixed');
});
test('subclass overrides of built-in quotedIdentifier dispatch rather than inheriting a guessed answer',()=>{
  const file=source('Strategy','protected Identifier quotedIdentifier(Identifier name) { return super.unquotedIdentifier(name).quoted(); }','PhysicalNamingStrategySnakeCaseImpl');
  const r=createNamingResolver([file],{physical:'n.Strategy'});assert.equal(r.physical('`SomeName`').physicalName,'some_name');assert.equal(r.physical('`SomeName`').quoted,true);
});
test('implicit strategy changes only defaults and safely inherits other JPA naming callbacks',()=>{
  const file=source('Implicit','public Identifier determineBasicColumnName(ImplicitBasicColumnNameSource source) { return toIdentifier("logical_" + source.getAttributePath().getProperty(), source.getBuildingContext()); }','ImplicitNamingStrategyJpaCompliantImpl');
  const r=createNamingResolver([file],{implicit:'n.Implicit'},'standard');
  assert.equal(r.physical('given','column',{explicit:true,propertyPath:'value'}).physicalName,'given');
  assert.equal(r.physical('value','column',{explicit:false,propertyPath:'value'}).physicalName,'logical_value');
  assert.equal(r.physical('value','column',{explicit:false,propertyPath:'value',implicitMethod:'determineIdentifierColumnName'}).physicalName,'value');
});
test('implicit custom primary table gets entity source and transform hooks retain source context',()=>{
  const file=source('Implicit','public Identifier determinePrimaryTableName(ImplicitEntityNameSource source) { return Identifier.toIdentifier("e_" + source.getEntityNaming().getJpaEntityName()); }','ImplicitNamingStrategyJpaCompliantImpl');
  const r=createNamingResolver([file],{implicit:'n.Implicit'},'standard');assert.equal(r.physical('Thing','table',{explicit:false,entityName:'LogicalThing',entityClassName:'n.Thing'}).physicalName,'e_LogicalThing');
  const hook=source('Hook','protected String transformAttributePath(AttributePath path) { return "path_" + path.getProperty(); }','ImplicitNamingStrategyJpaCompliantImpl');
  assert.equal(createNamingResolver([hook],{implicit:'n.Hook'},'standard').physical('a','column',{explicit:false,propertyPath:'root.a'}).physicalName,'path_a');
});
test('observed or explicit profiles require exact entries; missing data is not inferred from catalog',()=>{
  const r=createNamingResolver([],{profile:{source:'observed',tables:{Thing:'actual_thing'},columns:{value:'real_value'}}});
  assert.equal(r.physical('Thing','table').physicalName,'actual_thing');assert.equal(r.physical('value').physicalName,'real_value');assert.equal(r.physical('missing').certainty,'unknown');
  assert.equal(createNamingResolver([],{profile:{source:'guessed',columns:{x:'x'}}}).physical('x').certainty,'unknown');
});
test('unknown strategy never silently falls back to the configured standard mode',()=>{
  const r=createNamingResolver([],{physical:'external.Unavailable'},'standard');assert.equal(r.physical('name').physicalName,null);assert.equal(r.physical('name').certainty,'unknown');
});
test('recursion, arbitrary regex, loops and field mutation return unknown without running Java',()=>{
  for(const body of ['return toPhysicalColumnName(name, env);','return Identifier.toIdentifier(name.getText().replaceAll("(a+)+$", "x"));','while (true) {} return name;','this.field = name; return name;','field = name; return name;'])assert.equal(resolver(body).physical('a').certainty,'unknown',body);
});
test('Java string reference equality and non-ASCII case conversion are not guessed',()=>{
  assert.equal(resolver('if (name.getText() == "same") return name; return name;').physical('same').certainty,'unknown');
  assert.equal(resolver('return Identifier.toIdentifier(name.getText().toUpperCase(Locale.ROOT));').physical('straße').certainty,'unknown');
});
test('Identifier factory retains quote text, trims Java ASCII whitespace and autoquotes illegal ASCII starts',()=>{
  assert.equal(resolver('return Identifier.toIdentifier("  $name  ");').physical('x').quoted,true);
  assert.equal(resolver('return Identifier.toIdentifier("  $name  ");').physical('x').physicalName,'$name');
  assert.equal(resolver('return name;').physical('`a``b`').physicalName,'a``b');
  assert.equal(resolver('return Identifier.toIdentifier(name.getText());').physical('이름').certainty,'unknown');
});
test('ambiguous overloaded or duplicate configured source class is unknown',()=>{
  const file=source('Strategy',method('return name;')+' public Identifier toPhysicalColumnName(Identifier name) { return name; }');
  assert.equal(createNamingResolver([file],{physical:'n.Strategy'}).physical('a').certainty,'unknown');
  assert.equal(createNamingResolver([source('Strategy',method('return name;')),source('Strategy',method('return name;'))],{physical:'n.Strategy'}).physical('a').certainty,'unknown');
});
test('Java imports cannot spoof trusted Identifier or Locale APIs',()=>{
  const file={uri:'Spoof.java',text:'package n; import evil.Identifier; import evil.Locale; import org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl; class Strategy extends PhysicalNamingStrategyStandardImpl { public Identifier toPhysicalColumnName(Identifier name, Object env) { return Identifier.toIdentifier(name.getText().toLowerCase(Locale.ROOT)); } }'};
  assert.equal(createNamingResolver([file],{physical:'n.Strategy'}).physical('SomeName').certainty,'unknown');
});
test('parent implementation still dispatches overridden local helper on configured child',()=>{
  const files=[source('Parent',method('return change(name);')+' protected Identifier change(Identifier name) { return Identifier.toIdentifier("parent_"+name.getText()); }'),source('Child','protected Identifier change(Identifier name) { return Identifier.toIdentifier("child_"+name.getText()); }','Parent')];
  assert.equal(createNamingResolver(files,{physical:'n.Child'}).physical('x').physicalName,'child_x');
});
test('super physical callback still uses virtual quoted hook on the configured child',()=>{
  const file=source('Strategy',method('return super.toPhysicalColumnName(name, env);')+' protected Identifier quotedIdentifier(Identifier name) { return Identifier.toIdentifier("special_"+name.getText(), true); }','PhysicalNamingStrategySnakeCaseImpl');
  assert.equal(createNamingResolver([file],{physical:'n.Strategy'}).physical('`Name`').physicalName,'special_Name');
});
test('private helper in a parent is lexically selected rather than overridden by a child lookalike',()=>{
  for(const call of ['change(name)','this.change(name)']){
    const files=[source('Parent',method(`return ${call};`)+' private Identifier change(Identifier name) { return Identifier.toIdentifier("parent_"+name.getText()); }'),source('Child','private Identifier change(Identifier name) { return Identifier.toIdentifier("child_"+name.getText()); }','Parent')];
    assert.equal(createNamingResolver(files,{physical:'n.Child'}).physical('x').physicalName,'parent_x');
  }
});
test('model integrates physical and implicit phases for annotation, secondary, join, XML names and default basic',()=>{
  const strategy=source('Physical',`public Identifier toPhysicalTableName(Identifier name, JdbcEnvironment env) { return Identifier.toIdentifier("t_"+name.getText()); } ${method('if(name.isQuoted()) return name; return Identifier.toIdentifier("c_"+name.getText());')}`);
  const implicit=source('Implicit','public Identifier determineBasicColumnName(ImplicitBasicColumnNameSource source) { return Identifier.toIdentifier("i_" + source.getAttributePath().getProperty()); }','ImplicitNamingStrategyJpaCompliantImpl');
  const entity={uri:'Entity.java',text:'package n; import jakarta.persistence.*; @Entity @Table(name="explicit_table") @SecondaryTable(name="extra") public class Entity { @Id @Column(name="id") Long id; String defaultName; @Column(name="`Quoted`") String quoted; @Column(name="note",table="extra") String note; }'};
  const model=analyzeJPA([entity,strategy,implicit],{physicalNaming:'standard',namingStrategy:{physical:'n.Physical',implicit:'n.Implicit'}}),e=model.entities[0];
  assert.equal(e.table.physicalName,'t_explicit_table');assert.equal(e.attributes.find(a=>a.name==='defaultName').columns[0].physicalName,'c_i_defaultName');
  assert.equal(e.columnMappings.find(b=>b.property==='note').storageTable.physicalName,'t_extra');assert.equal(e.columnMappings.find(b=>b.property==='quoted').column.physicalName,'Quoted');
});
test('unknown physical name becomes catalog unknown, not a false missing-table diagnostic',()=>{
  const model=analyzeJPA([{uri:'Entity.java',text:'package n; import jakarta.persistence.*; @Entity class Entity { @Id Long id; String value; }'}],{physicalNaming:'standard',namingStrategy:{physical:'missing.Strategy'}});
  const report=compareCatalog(model,{tables:[]});assert.equal(report.mismatches.length,0);assert.ok(report.unknowns.some(item=>/unresolved/i.test(item.reason)));
});
test('explicit schema and catalog names pass through the matching physical SPI and unknown namespace suppresses absence',()=>{
  const entity={uri:'Entity.java',text:'package n; import jakarta.persistence.*; @Entity @Table(name="things",schema="scope") class Entity { @Id Long id; }'};
  const strategy=source('Strategy','public Identifier toPhysicalSchemaName(Identifier name, JdbcEnvironment env) { return Identifier.toIdentifier("s_"+name.getText()); }');
  const model=analyzeJPA([entity,strategy],{physicalNaming:'standard',namingStrategy:{physical:'n.Strategy'}});assert.equal(model.entities[0].table.schema,'s_scope');
  const unknown=analyzeJPA([entity],{physicalNaming:'standard',namingStrategy:{profile:{source:'explicit',tables:{things:'things'},columns:{id:'id'}}}});
  assert.equal(unknown.entities[0].table.schema,undefined);assert.equal(compareCatalog(unknown,{database:'scope',tables:[]}).mismatches.length,0);
});
test('Java numeric overflow is not evaluated with JavaScript number semantics',()=>{
  assert.equal(resolver('return Identifier.toIdentifier((2147483647 + 1) + name.getText());').physical('x').certainty,'unknown');
});
test('custom implicit path hooks never rewrite inherited primary-key joins and unsupported joins remain unknown',()=>{
  const file=source('Implicit','protected String transformAttributePath(AttributePath path) { return "path_" + path.getProperty(); }','ImplicitNamingStrategyJpaCompliantImpl');
  const r=createNamingResolver([file],{implicit:'n.Implicit'},'standard');
  assert.equal(r.physical('id','column',{explicit:false,propertyPath:'id',implicitMethod:'determinePrimaryKeyJoinColumnName'}).physicalName,'id');
  assert.equal(r.physical('department_id','column',{explicit:false,propertyPath:'department_id',implicitMethod:'determineJoinColumnName'}).certainty,'unknown');
});
test('annotation and XML unnamed Id columns use Hibernate basic-column callback before physical naming',()=>{
  const strategy=source('Implicit','public Identifier determineBasicColumnName(ImplicitBasicColumnNameSource source) { return Identifier.toIdentifier("logical_"+source.getAttributePath().getProperty()); }','ImplicitNamingStrategyJpaCompliantImpl');
  const entity={uri:'Entity.java',text:'package n; import jakarta.persistence.*; @Entity class Entity { @Id Long id; }'};
  const model=analyzeJPA([entity,strategy],{physicalNaming:'standard',namingStrategy:{implicit:'n.Implicit'}});
  assert.equal(model.entities[0].columnMappings[0].column.physicalName,'logical_id');
});
test('default joins into custom-renamed PKs stay unknown until referenced naming context is proven',()=>{
  const strategy=source('Strategy',method('return Identifier.toIdentifier("c_"+name.getText());'));
  const entities={uri:'Entities.java',text:'package n; import jakarta.persistence.*; @Entity class Target { @Id Long id; } @Entity class Owner { @Id Long id; @ManyToOne Target target; }'};
  const model=analyzeJPA([entities,strategy],{physicalNaming:'standard',namingStrategy:{physical:'n.Strategy'}});
  const binding=model.entities.find(e=>e.name==='Owner').columnMappings.find(b=>b.property==='target');assert.equal(binding.status,'unknown');assert.match(binding.reason,/Default join naming/);
});
