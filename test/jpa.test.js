'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeJPA,compareCatalog}=require('../src/jpa/model');
const file=(name,text)=>({uri:'file:///jpa/'+name+'.java',text});
test('JPA entity, embeddable, mapped superclass, inheritance, associations and transient fields form one local mapping',()=>{
  const model=analyzeJPA([
    file('Base','package demo; import jakarta.persistence.*; @MappedSuperclass class Base { @Id @Column(name="id") Long id; @Version long version; }'),
    file('Address','package demo; import jakarta.persistence.*; @Embeddable class Address { @Column(name="postal_code") String postalCode; String city; }'),
    file('Department','package demo; import jakarta.persistence.*; @Entity @Table(name="department") class Department extends Base { String name; @OneToMany(mappedBy="department") java.util.List<Person> people; }'),
    file('Person','package demo; import jakarta.persistence.*; @Entity(name="Employee") @Table(name="person") class Person extends Base { @Column(name="display_name",nullable=false,length=80) String displayName; @Embedded Address address; @ManyToOne @JoinColumn(name="department_id") Department department; @Transient String ignored; static String constant; transient String scratch; }'),
    file('Special','package demo; import jakarta.persistence.*; @Entity class Special extends Person { @Column(name="speciality") String speciality; }'),
  ],{physicalNaming:'standard'});
  const person=model.entities.find(entity=>entity.fqn==='demo.Person');
  assert.equal(person.name,'Employee');assert.equal(person.access,'FIELD');assert.equal(person.table.physicalName,'person');
  assert.deepEqual(person.attributes.map(attribute=>attribute.name),['id','version','displayName','address','department']);
  assert.equal(person.attributes.find(attribute=>attribute.name==='id').id,true);
  assert.equal(person.attributes.find(attribute=>attribute.name==='department').columns[0].physicalName,'department_id');
  assert.equal(person.attributes.find(attribute=>attribute.name==='address').targetFqn,'demo.Address');
  const special=model.entities.find(entity=>entity.fqn==='demo.Special');
  assert.equal(special.table.physicalName,'person');assert.equal(special.inheritance,'SINGLE_TABLE');
  assert.equal(model.diagnostics.length,0);
});
test('explicit property access maps getters and skips transient/computed getters',()=>{
  const source='package demo; import jakarta.persistence.*; @Entity @Access(AccessType.PROPERTY) class Account { private Long id; private String code; @Id public Long getId(){return id;} @Column(name="external_code") public String getCode(){return code;} @Transient public String getComputed(){return "x";} public void setCode(String code){this.code=code;} }';
  const entity=analyzeJPA([file('Account',source)],{physicalNaming:'standard'}).entities[0];
  assert.equal(entity.access,'PROPERTY');assert.deepEqual(entity.attributes.map(attribute=>attribute.name),['id','code']);
  assert.equal(entity.attributes[1].columns[0].name,'external_code');
  assert.equal(source.slice(source.indexOf('getCode'),source.indexOf('getCode')+7),'getCode');
});
test('explicit imports prevent fake annotations; duplicate entities and external hierarchy remain uncertain and scope is explicit',()=>{
  const sources=[
    file('Fake','package demo; import local.Entity; @Entity class Fake { Long id; }'),
    file('A','package a; import jakarta.persistence.*; @Entity(name="Shared") class A { @Id Long id; }'),
    file('B','package b; import jakarta.persistence.*; @Entity(name="Shared") class B { @Id Long id; }'),
    file('Unknown','package a; import jakarta.persistence.*; @Entity class Unknown extends ExternalBase { String name; }'),
  ];
  const model=analyzeJPA(sources);
  assert.equal(model.entities.length,3);
  assert.equal(model.entities.find(entity=>entity.fqn==='a.A').attributesComplete,false);
  assert.equal(model.entities.find(entity=>entity.fqn==='a.Unknown').attributesComplete,false);
  assert.ok(model.issues.some(issue=>/multiple persistence units/.test(issue.message)));
  assert.equal(analyzeJPA(sources,{basePackages:['b']}).entities.length,1);
});
test('catalog comparison reports supported observed differences and keeps unknown naming/cross-schema/override mappings uncertain',()=>{
  const files=[file('Person','package demo; import jakarta.persistence.*; @Entity @Table(name="person") class Person { @Id @Column(name="id") Long id; @Column(name="display_name",nullable=false,length=80) String displayName; }')];
  const catalog={database:'app',tables:[{name:'person',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'display_name',type:'varchar(60)',primaryKey:false,nullable:true}]}],views:[]};
  const result=compareCatalog(analyzeJPA(files,{physicalNaming:'standard'}),catalog);
  assert.equal(result.matches.length,2);assert.ok(result.mismatches.some(item=>item.code==='jpa.catalog.length'));assert.ok(result.mismatches.some(item=>item.code==='jpa.catalog.nullability'));
  const unknown=compareCatalog(analyzeJPA(files),{database:'app',tables:[],views:[]});
  assert.equal(unknown.mismatches.length,0);assert.equal(unknown.unknowns.length,2);
  assert.equal(compareCatalog(analyzeJPA(files),catalog).mismatches.length,0);
  const other=analyzeJPA([file('Other','package demo; import jakarta.persistence.*; @Entity @Table(name="person",schema="other") class Other { @Id Long id; }')],{physicalNaming:'standard'});
  assert.equal(compareCatalog(other,catalog).matches.length,0);assert.match(compareCatalog(other,catalog).unknowns[0].reason,/different/);
});
test('embedded IDs flatten into database PK columns and literal overrides remain owner-specific',()=>{
  const files=[
    file('Key','package demo; import jakarta.persistence.*; @Embeddable class Key { @Column(name="country") String country; @Column(name="code") String code; }'),
    file('Record','package demo; import jakarta.persistence.*; @Entity @Table(name="records") class Record { @EmbeddedId Key id; String value; }'),
  ];
  const model=analyzeJPA(files,{physicalNaming:'standard'});
  const report=compareCatalog(model,{database:'app',tables:[{name:'records',columns:[{name:'country',type:'varchar(255)',primaryKey:true,nullable:false},{name:'code',type:'varchar(255)',primaryKey:true,nullable:false},{name:'value',type:'varchar(255)',primaryKey:false,nullable:true}]}]});
  assert.equal(report.mismatches.length,0);assert.equal(report.matches.length,3);
  const override=analyzeJPA([files[0],file('Record','package demo; import jakarta.persistence.*; @Entity class Record { @Id Long id; @Embedded @AttributeOverride(name="country",column=@Column(name="home_country")) Key key; }')]);
  assert.equal(override.entities[0].attributes.find(attribute=>attribute.name==='key').status,'known');
  assert.equal(override.entities[0].columnMappings.find(binding=>binding.property==='key.country').column.name,'home_country');
  assert.equal(override.embeddables[0].attributes.find(attribute=>attribute.name==='country').columns[0].name,'country');
});
test('unsupported multiple field declarations suppress definite missing-property coverage and known type mismatches are explicit',()=>{
  const incomplete=analyzeJPA([file('Many','package demo; import jakarta.persistence.*; @Entity class Many { @Id Long id; String first,second; }')]);
  assert.equal(incomplete.entities[0].attributesComplete,false);
  assert.ok(incomplete.issues.some(issue=>/Multiple field/.test(issue.message)));
  const entity=analyzeJPA([file('Typed','package demo; import jakarta.persistence.*; @Entity @Table(name="typed") class Typed { @Id Long id; @Column(precision=10,scale=4) java.math.BigDecimal amount; }')],{physicalNaming:'standard'});
  const report=compareCatalog(entity,{database:'app',tables:[{name:'typed',columns:[{name:'id',type:'varchar(20)',primaryKey:true,nullable:false},{name:'amount',type:'decimal(10,2)',primaryKey:false,nullable:true}]}]});
  assert.ok(report.mismatches.some(item=>item.code==='jpa.catalog.type'));
  assert.ok(report.mismatches.some(item=>item.code==='jpa.catalog.precision'));
});
test('quoted names and case variants do not become false MySQL identifier absence claims',()=>{
  const quote=String.fromCharCode(96);
  const source='package demo; import jakarta.persistence.*; @Entity @Table(name="'+quote+'MixedTable'+quote+'") class Mixed { @Id @Column(name="ID") Long id; }';
  const model=analyzeJPA([file('Mixed',source)],{physicalNaming:'standard'});
  assert.equal(model.entities[0].table.physicalName,'MixedTable');
  const report=compareCatalog(model,{database:'app',tables:[{name:'mixedtable',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false}]}]});
  assert.equal(report.mismatches.length,0);assert.equal(report.matches.length,1);assert.ok(report.unknowns.some(item=>item.code==='jpa.catalog.case'));
});
test('Hibernate formulas and custom column SQL remain unknown rather than invented physical defaults',()=>{
  const model=analyzeJPA([file('Formula','package demo; import jakarta.persistence.*; import org.hibernate.annotations.Formula; @Entity @Table(name="formula") class Formula { @Id Long id; @Formula("price*2") long computed; @Column(columnDefinition="varchar(20)",length=80) String custom; }')],{physicalNaming:'standard'});
  assert.equal(model.entities[0].attributes.find(attribute=>attribute.name==='computed').status,'unknown');
  const report=compareCatalog(model,{database:'app',tables:[{name:'formula',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'custom',type:'varchar(20)',nullable:true,primaryKey:false}]}]});
  assert.equal(report.mismatches.length,0);assert.ok(report.unknowns.some(item=>item.code==='jpa.catalog.columnDefinition'));
});

test('nested attribute and association overrides are resolved per embedding owner without template leakage',()=>{
  const model=analyzeJPA([
    file('Address','package demo; import jakarta.persistence.*; @Embeddable class Address { String city; String postalCode; }'),
    file('Contact','package demo; import jakarta.persistence.*; @Embeddable class Contact { @Embedded Address address; }'),
    file('Department','package demo; import jakarta.persistence.*; @Entity class Department { @Id Long id; }'),
    file('Assignment','package demo; import jakarta.persistence.*; @Embeddable class Assignment { @ManyToOne Department department; }'),
    file('Home','package demo; import jakarta.persistence.*; @Entity @AttributeOverride(name="contact.address.city",column=@Column(name="home_city")) class Home { @Id Long id; @Embedded @AttributeOverride(name="address.city",column=@Column(name="member_city")) Contact contact; @Embedded @AssociationOverride(name="department",joinColumns=@JoinColumn(name="home_department")) Assignment assignment; }'),
    file('Work','package demo; import jakarta.persistence.*; @Entity class Work { @Id Long id; @Embedded @AttributeOverride(name="address.city",column=@Column(name="work_city")) Contact contact; @Embedded Assignment assignment; }'),
  ],{physicalNaming:'standard'});
  const bindings=name=>model.entities.find(entity=>entity.name===name).columnMappings;
  assert.equal(bindings('Home').find(value=>value.property==='contact.address.city').column.name,'home_city');
  assert.equal(bindings('Work').find(value=>value.property==='contact.address.city').column.name,'work_city');
  assert.equal(bindings('Home').find(value=>value.property==='assignment.department').column.name,'home_department');
  assert.equal(bindings('Work').find(value=>value.property==='assignment.department').column.name,'department_id');
  assert.equal(model.embeddables.find(type=>type.name==='Address').attributes[0].columns[0].name,'city');
});

test('composite identity joins keep all explicit references and incomplete composite joins never invent absent columns',()=>{
  const files=[
    file('Key','package demo; import jakarta.persistence.*; @Embeddable class Key implements java.io.Serializable { @Column(name="country_key") String country; @Column(name="local_key") String code; }'),
    file('Region','package demo; import jakarta.persistence.*; @Entity @Table(name="region") class Region { @EmbeddedId Key id; }'),
    file('Warehouse','package demo; import jakarta.persistence.*; @Entity @Table(name="warehouse") class Warehouse { @Id Long id; @ManyToOne @JoinColumns({@JoinColumn(name="country_fk",referencedColumnName="country_key"),@JoinColumn(name="code_fk",referencedColumnName="local_key")}) Region region; }'),
    file('Incomplete','package demo; import jakarta.persistence.*; @Entity @Table(name="incomplete") class Incomplete { @Id Long id; @ManyToOne @JoinColumns({@JoinColumn(referencedColumnName="country_key"),@JoinColumn(name="code_fk",referencedColumnName="local_key")}) Region region; }'),
  ];
  const model=analyzeJPA(files,{physicalNaming:'standard'}),region=model.entities.find(entity=>entity.name==='Region');
  assert.equal(region.attributesComplete,true);assert.ok(region.columnMappings.every(value=>value.column.primaryKey));
  const warehouse=model.entities.find(entity=>entity.name==='Warehouse');assert.deepEqual(warehouse.attributes.find(value=>value.name==='region').columns.map(value=>[value.name,value.referencedColumnName]),[['country_fk','country_key'],['code_fk','local_key']]);
  const partial=model.entities.find(entity=>entity.name==='Incomplete');assert.equal(partial.columnMappings.find(value=>value.property==='region').status,'unknown');
  const report=compareCatalog({...model,entities:[partial]},{database:'app',tables:[{name:'incomplete',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'code_fk',type:'varchar(255)',nullable:true}]}]});
  assert.equal(report.mismatches.length,0);assert.ok(report.unknowns.some(value=>value.property==='region'));
});

test('IdClass validates local field names and secondary/JOINED/TABLE_PER_CLASS columns retain their actual tables',()=>{
  const model=analyzeJPA([
    file('Key','package demo; class Key implements java.io.Serializable { String tenant; String code; }'),
    file('License','package demo; import jakarta.persistence.*; @Entity @IdClass(Key.class) @SecondaryTable(name="license_details",pkJoinColumns={@PrimaryKeyJoinColumn(name="tenant_fk",referencedColumnName="tenant_key"),@PrimaryKeyJoinColumn(name="code_fk",referencedColumnName="license_key")}) class License { @Id @Column(name="tenant_key") String tenant; @Id @Column(name="license_key") String code; @Column(table="license_details") String note; @Column(table="undeclared") String unsupported; }'),
    file('Vehicle','package demo; import jakarta.persistence.*; @Entity @Table(name="vehicle") @Inheritance(strategy=InheritanceType.JOINED) class Vehicle { @Id @Column(name="vehicle_id") Long id; String name; }'),
    file('Truck','package demo; import jakarta.persistence.*; @Entity @Table(name="truck") @PrimaryKeyJoinColumn(name="truck_id",referencedColumnName="vehicle_id") class Truck extends Vehicle { int payload; }'),
    file('Payment','package demo; import jakarta.persistence.*; @Entity @Table(name="abstract_payment") @Inheritance(strategy=InheritanceType.TABLE_PER_CLASS) abstract class Payment { @Id Long id; long amount; }'),
    file('Cash','package demo; import jakarta.persistence.*; @Entity @Table(name="cash") class Cash extends Payment { String register; }'),
  ],{physicalNaming:'standard'});
  const license=model.entities.find(value=>value.name==='License');assert.equal(license.identity.certainty,'known');
  assert.equal(license.columnMappings.find(value=>value.property==='note').storageTable.name,'license_details');
  assert.equal(license.columnMappings.find(value=>value.property==='unsupported').status,'unknown');
  assert.deepEqual(license.columnMappings.filter(value=>value.property==='<secondary-id>').map(value=>value.column.name),['tenant_fk','code_fk']);
  const truck=model.entities.find(value=>value.name==='Truck');assert.equal(truck.superFqn,'demo.Vehicle');assert.equal(truck.inheritanceRootFqn,'demo.Vehicle');
  assert.equal(truck.columnMappings.find(value=>value.property==='name').storageTable.name,'vehicle');assert.equal(truck.columnMappings.find(value=>value.property==='payload').storageTable.name,'truck');
  assert.equal(truck.columnMappings.find(value=>value.property==='<joined-id>').column.name,'truck_id');
  const cash=model.entities.find(value=>value.name==='Cash');assert.ok(cash.columnMappings.every(value=>value.storageTable.name==='cash'));
  const payment=model.entities.find(value=>value.name==='Payment');assert.equal(payment.abstract,true);assert.equal(compareCatalog({...model,entities:[payment]},{database:'app',tables:[]}).mismatches.length,0);
});

test('explicit collection and join tables compare owner, inverse and value columns without inventing nullability',()=>{
  const model=analyzeJPA([
    file('Department','package demo; import jakarta.persistence.*; @Entity @Table(name="departments") class Department { @Id Long id; }'),
    file('Record','package demo; import jakarta.persistence.*; @Entity @Table(name="records") class Record { @Id Long id; @ElementCollection @CollectionTable(name="record_tags",joinColumns=@JoinColumn(name="record_id")) @Column(name="tag") java.util.Set<String> tags; @ManyToMany @JoinTable(name="record_departments",joinColumns=@JoinColumn(name="record_id"),inverseJoinColumns=@JoinColumn(name="department_id")) java.util.Set<Department> departments; }'),
  ],{physicalNaming:'standard'});
  const record=model.entities.find(value=>value.name==='Record');assert.equal(record.attributes.find(value=>value.name==='tags').targetFqn,null);assert.equal(record.attributes.find(value=>value.name==='tags').elementJavaType,'java.lang.String');
  const tables=[{name:'records',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false}]},{name:'record_tags',columns:[{name:'record_id',type:'bigint',nullable:true},{name:'tag',type:'varchar(255)',nullable:true}]},{name:'record_departments',columns:[{name:'record_id',type:'bigint',nullable:true},{name:'department_id',type:'bigint',nullable:true}]}];
  const report=compareCatalog({...model,entities:[record]},{database:'app',tables});assert.equal(report.mismatches.length,0);assert.equal(report.matches.length,5);
});

test('converter generic descriptors, explicit enum/temporal/LOB storage and disabled autoApply are metadata-only',()=>{
  const model=analyzeJPA([
    file('FlagConverter','package demo; import jakarta.persistence.*; @Converter(autoApply=true) class FlagConverter implements AttributeConverter<Boolean,String> { public String convertToDatabaseColumn(Boolean value){ throw new Error("must not execute"); } public Boolean convertToEntityAttribute(String value){return false;} }'),
    file('State','package demo; enum State { NEW, ACTIVE }'),
    file('Item','package demo; import jakarta.persistence.*; @Entity class Item { @Id Long id; Boolean flag; @Convert(disableConversion=true) Boolean rawFlag; @Enumerated(EnumType.STRING) State state; @Temporal(TemporalType.DATE) java.util.Date registered; @Lob String text; @Lob byte[] data; }'),
  ],{physicalNaming:'standard'});
  const item=model.entities[0],types=Object.fromEntries(item.columnMappings.map(value=>[value.property,value.column.dbType]));
  assert.equal(types.flag.source,'converter');assert.equal(types.flag.relationalJavaType,'java.lang.String');assert.equal(types.flag.valueTransformation,'not-executed');
  assert.equal(types.rawFlag.source,'basic');assert.equal(types.state.mode,'STRING');assert.deepEqual(types.registered.expectedFamilies,['date']);
  assert.ok(types.text.expectedFamilies.includes('longtext'));assert.ok(types.data.expectedFamilies.includes('longblob'));
  const report=compareCatalog(model,{database:'app',tables:[{name:'Item',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'flag',type:'varchar(255)'},{name:'rawFlag',type:'bit'},{name:'state',type:'enum'},{name:'registered',type:'date'},{name:'text',type:'longtext'},{name:'data',type:'longblob'}]}]});
  assert.equal(report.mismatches.length,0);
});

test('ambiguous/custom converters keep names comparable but never invent a JDBC type mismatch',()=>{
  const source=name=>file(name,'package demo; import jakarta.persistence.*; @Converter(autoApply=true) class '+name+' implements AttributeConverter<Boolean,String> {}');
  const model=analyzeJPA([source('A'),source('B'),file('Item','package demo; import jakarta.persistence.*; @Entity @Table(name="items") class Item { @Id Long id; Boolean flag; @Convert(converter=External.class) String external; }')],{physicalNaming:'standard'});
  const report=compareCatalog(model,{database:'app',tables:[{name:'items',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'flag',type:'blob'},{name:'external',type:'blob'}]}]});
  assert.equal(report.mismatches.length,0);assert.equal(report.matches.length,3);assert.equal(report.unknowns.filter(value=>value.code==='jpa.catalog.type.unknown').length,2);
});

test('nonliteral/fake nested overrides and MapsId remain local unknowns instead of default column absence',()=>{
  const model=analyzeJPA([
    file('Address','package demo; import jakarta.persistence.*; @Embeddable class Address { String city; }'),
    file('Owner','package demo; import jakarta.persistence.*; import local.Column; @Entity @Table(name="owners") class Owner { @Id Long id; @Embedded @AttributeOverride(name="city",column=@Column(name="fake")) Address address; String known; }'),
    file('Derived','package demo; import jakarta.persistence.*; @Entity class Derived { @Id Long id; @ManyToOne @MapsId Owner owner; String label; }'),
  ],{physicalNaming:'standard'});
  const owner=model.entities.find(value=>value.name==='Owner');assert.equal(owner.columnMappings.find(value=>value.property==='address.city').status,'unknown');
  const derived=model.entities.find(value=>value.name==='Derived');assert.equal(derived.columnMappings.find(value=>value.property==='id').status,'unknown');assert.equal(derived.columnMappings.find(value=>value.property==='label').status,'known');
  const report=compareCatalog({...model,entities:[owner]},{database:'app',tables:[{name:'owners',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'known',type:'varchar(255)'}]}]});
  assert.equal(report.mismatches.length,0);assert.ok(report.unknowns.some(value=>value.property==='address.city'));
});

test('partial XML mapping propagates through entity inheritance but stays scoped to embedded bindings',()=>{
  const files=[file('Base','package demo; import jakarta.persistence.*; @Entity @Table(name="base_table") class Base { @Id Long id; }'),file('Child','package demo; import jakarta.persistence.*; @Entity class Child extends Base { String label; }')];
  const xml={uri:'file:///META-INF/parent.xml',text:'<entity-mappings xmlns="https://jakarta.ee/xml/ns/persistence/orm" version="3.2"><entity class="demo.Base"><table name="xml_base"/><unsupported/></entity></entity-mappings>'};
  const inherited=analyzeJPA(files,{physicalNaming:'standard',mappingFiles:[xml]});
  assert.equal(inherited.entities.find(value=>value.name==='Child').providerMappingUnknown,true);
  assert.equal(compareCatalog(inherited,{database:'app',tables:[]}).mismatches.length,0);
  assert.ok(inherited.diagnostics.some(value=>value.uri===xml.uri&&value.code==='jpa.xml.unknown'&&value.severity==='information'));
  const embedded=analyzeJPA([file('Address','package demo; import jakarta.persistence.*; @Embeddable class Address { String city; }'),file('Home','package demo; import jakarta.persistence.*; @Entity @Table(name="homes") class Home { @Id Long id; @Embedded Address address; String label; }')],{physicalNaming:'standard',mappingFiles:[{uri:'file:///META-INF/embedded.xml',text:'<entity-mappings xmlns="https://jakarta.ee/xml/ns/persistence/orm" version="3.2"><embeddable class="demo.Address"><unsupported/></embeddable></entity-mappings>'}]});
  const home=embedded.entities[0];assert.equal(home.columnMappings.find(value=>value.property==='address').status,'unknown');
  const report=compareCatalog(embedded,{database:'app',tables:[{name:'homes',columns:[{name:'id',type:'bigint',primaryKey:true,nullable:false},{name:'label',type:'varchar(255)'}]}]});
  assert.equal(report.mismatches.length,0);assert.equal(report.matches.length,2);assert.ok(report.unknowns.some(value=>value.property==='address'));
});

test('unreadable mapping-file coverage, nonliteral converter flags and incompatible IdClass types stay uncertain',()=>{
  const source=file('Item','package demo; import jakarta.persistence.*; @Entity class Item { @Id Long id; String label; }');
  const incomplete=analyzeJPA([source],{physicalNaming:'standard',mappingFilesComplete:false});assert.equal(incomplete.entities[0].providerMappingUnknown,true);assert.equal(compareCatalog(incomplete,{database:'app',tables:[]}).mismatches.length,0);
  const converted=analyzeJPA([file('FlagConverter','package demo; import jakarta.persistence.*; @Converter(autoApply=ENABLED) class FlagConverter implements AttributeConverter<Boolean,String> {}'),file('Flag','package demo; import jakarta.persistence.*; @Entity class Flag { @Id Long id; Boolean flag; @Convert(disableConversion=DISABLE) Boolean other; }')],{physicalNaming:'standard'});
  assert.ok(converted.entities[0].columnMappings.filter(value=>value.property!=='id').every(value=>value.column.dbType.certainty==='unknown'));
  const idClass=analyzeJPA([file('BadKey','package demo; class BadKey { Long code; }'),file('License','package demo; import jakarta.persistence.*; @Entity @IdClass(BadKey.class) class License { @Id String code; }')]);assert.equal(idClass.entities[0].identity.certainty,'unknown');
});

test('overridden inherited identifier columns drive default association and secondary primary-key joins',()=>{
  const model=analyzeJPA([
    file('Base','package demo; import jakarta.persistence.*; @MappedSuperclass class Base { @Id Long id; }'),
    file('Owner','package demo; import jakarta.persistence.*; @Entity @AttributeOverride(name="id",column=@Column(name="owner_key")) @SecondaryTable(name="owner_detail") class Owner extends Base { @Column(table="owner_detail") String detail; }'),
    file('Ref','package demo; import jakarta.persistence.*; @Entity class Ref { @Id Long id; @ManyToOne Owner owner; }'),
    file('Key','package demo; class Key { String country; String code; }'),
    file('Composite','package demo; import jakarta.persistence.*; @Entity @IdClass(Key.class) @SecondaryTable(name="composite_detail") class Composite { @Id @Column(name="country_key") String country; @Id @Column(name="local_key") String code; @Column(table="composite_detail") String detail; }'),
  ],{physicalNaming:'standard'});
  const owner=model.entities.find(value=>value.name==='Owner'),ref=model.entities.find(value=>value.name==='Ref'),composite=model.entities.find(value=>value.name==='Composite');
  assert.equal(owner.columnMappings.find(value=>value.property==='<secondary-id>').column.name,'owner_key');
  assert.equal(ref.columnMappings.find(value=>value.property==='owner').column.name,'owner_owner_key');
  assert.deepEqual(composite.columnMappings.filter(value=>value.property==='<secondary-id>').map(value=>value.column.name),['country_key','local_key']);
});
