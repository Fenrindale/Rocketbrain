'use strict';
const { parseJavaFile, lexJava, literal, strings, rangeAt } = require('../spring/java');
const { analyzeQueries, completionsAt, definitionsAt } = require('./query');
const { enrichMappings } = require('./mapping');
const JPA_NAMES = new Set(['Entity','Embeddable','MappedSuperclass','Table','Column','Id','EmbeddedId','Embedded','Basic','Transient','Version','GeneratedValue','Access','Inheritance','DiscriminatorColumn','DiscriminatorValue','ManyToOne','OneToOne','OneToMany','ManyToMany','JoinColumn','JoinColumns','JoinTable','CollectionTable','ElementCollection','AttributeOverride','AttributeOverrides','AssociationOverride','AssociationOverrides','Convert','Converts','Converter','IdClass','SecondaryTable','SecondaryTables','PrimaryKeyJoinColumn','PrimaryKeyJoinColumns','Enumerated','EnumeratedValue','Temporal','Lob','MapsId','NamedQuery','NamedQueries','NamedNativeQuery','NamedNativeQueries']);
const primitive = new Set(['byte','short','int','long','float','double','boolean','char']);
const cap = value => value ? value[0].toUpperCase() + value.slice(1) : value;
const decap = value => /^[A-Z]{2}/.test(value) ? value : value[0].toLowerCase() + value.slice(1);
function accepted(annotation, file, namespace) {
  if (!annotation) return false;
  const expected = namespace + '.' + annotation.shortName;
  return annotation.name === expected || !file.imports[annotation.shortName] && file.wildcards.includes(namespace) && annotation.name === (file.packageName ? file.packageName + '.' : '') + annotation.shortName;
}
function jpa(items, name, file) {
  if (!JPA_NAMES.has(name)) return undefined;
  return items.find(item => item.shortName === name && (accepted(item,file,'jakarta.persistence') || accepted(item,file,'javax.persistence')));
}
function numeric(annotation, key, fallback) {
  const tokens = annotation?.attributes[key];
  return !tokens ? fallback : tokens.length === 1 && tokens[0].kind === 'number' && /^\d+$/.test(tokens[0].text) ? Number(tokens[0].text) : undefined;
}
function enumValue(annotation, key, fallback) {
  const tokens = annotation?.attributes[key];
  return !tokens ? fallback : tokens.length >= 3 && tokens.at(-2).text === '.' ? tokens.at(-1).text : undefined;
}
function resolveType(name, file) {
  if (!name || name.includes('.')) return name;
  return primitive.has(name) ? name : file.imports[name] || (file.packageName ? file.packageName + '.' : '') + name;
}
function physical(name, options, kind='column', context={}) {
  if(options._naming)return options._naming.physical(name,kind,context);
  if (typeof name !== 'string') return { name: null, physicalName: null, certainty: 'unknown' };
  const marker=name[0],quoted=(marker==='"'||marker===String.fromCharCode(96))&&name.at(-1)===marker;
  const unquoted=quoted?name.slice(1,-1).replaceAll(marker+marker,marker):name;
  return { name, quoted, physicalName: options.physicalNaming === 'snake_case'&&!quoted ? unquoted.replace(/([A-Z])([A-Z][a-z])/g,'$1_$2').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase() : unquoted,
    certainty: options.physicalNaming === 'unknown'||quoted&&options.physicalNaming!=='standard' ? 'unknown' : 'configured' };
}
function namespaceName(name,options,kind) {
  if(!options._naming||!name)return name;
  const result=physical(name,options,kind,{explicit:true});
  return result.certainty==='configured'?result.physicalName:undefined;
}
function offsetAt(text, position) {
  if (typeof position === 'number') return Math.max(0,Math.min(position,text.length));
  const lines = text.split('\n'); let offset=0;
  for (let i=0;i<Math.min(position.line,lines.length-1);i++) offset+=lines[i].length+1;
  return Math.min(text.length,offset+position.character);
}
function columnFor(member, file, property, options, id) {
  const annotation = jpa(member.annotations,'Column',file), join = jpa(member.annotations,'JoinColumn',file);
  const source = join || annotation;
  const name = literal(source,'name',property);
  const nullable = literal(source,'nullable',!id), explicitNullable = Boolean(source?.attributes.nullable) || id;
  return { ...physical(name,options,'column',{explicit:Boolean(source?.attributes.name),propertyPath:property,implicitMethod:join?'determineJoinColumnName':'determineBasicColumnName'}), nullable, explicitNullable, primaryKey:id,
    length:numeric(source,'length',undefined), precision:numeric(source,'precision',undefined), scale:numeric(source,'scale',undefined),
    columnDefinition:literal(source,'columnDefinition',''), insertable:literal(source,'insertable',true), updatable:literal(source,'updatable',true),
    referencedColumnName:literal(join,'referencedColumnName',null) };
}
function sourceModifiers(member,file) {
  const tokens=file.tokens, index=tokens.findIndex(token=>token.start===member.start);
  let start=index-1;
  while(start>=0 && ![';','{','}'].includes(tokens[start].text)) start--;
  return tokens.slice(start+1,index).filter(token=>token.kind==='id').map(token=>token.text);
}
function hasMultipleFieldDeclarators(record) {
  const tokens=record.file.tokens,index=tokens.findIndex(token=>token.start===record.type.start);
  let open=index+1;while(open<tokens.length&&tokens[open].text!=='{')open++;
  let depth=1,parens=0,generics=0;
  for(let i=open+1;i<tokens.length&&depth;i++) {
    const value=tokens[i].text;
    if(value==='{')depth++;
    else if(value==='}')depth--;
    if(depth!==1)continue;
    if(value==='(')parens++;
    else if(value===')')parens=Math.max(0,parens-1);
    else if(!parens&&value==='<')generics++;
    else if(!parens&&value==='>')generics=Math.max(0,generics-1);
    else if(!parens&&!generics&&value===',')return true;
  }
  return false;
}
function mappingAttributes(record, file, options, issue) {
  const type=record.type;
  const defaultMembers = record.access==='PROPERTY' ? type.methods.filter(method=>!method.parameters.length && /^(get[A-Z]|is[A-Z])/.test(method.name)) : type.fields;
  const extras = record.access==='FIELD' ? type.methods.filter(method=>enumValue(jpa(method.annotations,'Access',file),'value')==='PROPERTY' && !method.parameters.length && /^(get[A-Z]|is[A-Z])/.test(method.name)) : type.fields.filter(field=>enumValue(jpa(field.annotations,'Access',file),'value')==='FIELD');
  const attributes=[];
  for(const member of [...defaultMembers,...extras]) {
    if(jpa(member.annotations,'Transient',file) || sourceModifiers(member,file).some(value=>['static','transient'].includes(value))) continue;
    const method=type.methods.includes(member), name=method ? decap(member.name.replace(/^(get|is)/,'')) : member.name;
    const relation = ['ManyToOne','OneToOne','OneToMany','ManyToMany','ElementCollection'].find(value=>jpa(member.annotations,value,file));
    const embedded=Boolean(jpa(member.annotations,'Embedded',file)||jpa(member.annotations,'EmbeddedId',file));
    const id=Boolean(jpa(member.annotations,'Id',file)||jpa(member.annotations,'EmbeddedId',file));
    const arrayBase=member.type.raw.replace(/\[\]$/,'');
    const javaType=primitive.has(member.type.raw) ? member.type.raw : member.type.array?(primitive.has(arrayBase)?arrayBase:member.type.name)+'[]':member.type.name;
    let kind=embedded?'embedded':relation ? relation[0].toLowerCase()+relation.slice(1) : 'basic';
    const collection=['oneToMany','manyToMany','elementCollection'].includes(kind);
    let targetFqn=embedded?javaType:relation ? (collection?member.type.arguments.at(-1)?.name:javaType) : null;
    const relationAnnotation=relation?jpa(member.annotations,relation,file):null;
    if(relationAnnotation?.attributes.targetEntity) {
      const raw=relationAnnotation.attributes.targetEntity.map(token=>token.text).join('');
      targetFqn=/\.class$/.test(raw)?resolveType(raw.slice(0,-6),file):null;
    }
    let status='known';
    if(member.annotations.some(annotation=>accepted(annotation,file,'org.hibernate.annotations'))) {
      status='unknown';issue(record,'Hibernate-specific attribute mapping requires provider resolution for '+name+'.');
    }
    if(member.type.array && !/^(?:byte|char|Byte|Character|java\.lang\.(?:Byte|Character))\[\]$/.test(member.type.raw) || member.type.arguments.length && !relation) { status='unknown';issue(record,'Container/basic conversion mapping is unknown for '+name+'.'); }
    if(collection&&(/(?:^|\.)Map$/.test(member.type.name)||member.annotations.some(annotation=>/^(?:MapKey|OrderColumn)/.test(annotation.shortName)&&(accepted(annotation,file,'jakarta.persistence')||accepted(annotation,file,'javax.persistence'))))) {status='unknown';issue(record,'Map-key/ordered collection storage is outside the supported physical subset for '+name+'.');}
    const join=jpa(member.annotations,'JoinColumn',file);
    const columns=collection||embedded ? [] : [columnFor(member,file,relation ? literal(join,'name',undefined) : name,options,id)];
    const attribute={name,javaType,kind,targetFqn,collection,id,version:Boolean(jpa(member.annotations,'Version',file)),status,
      mappedBy:literal(relationAnnotation,'mappedBy',''),fetch:enumValue(relationAnnotation,'fetch',null),columns,
      uri:file.uri,range:rangeAt(file.text,member.start,member.end),declaredIn:record.fqn,storageTable:null};
    Object.defineProperty(attribute,'_jpa',{value:{member,file},enumerable:false,configurable:true});
    if(collection) attribute.elementJavaType=member.type.arguments.at(-1)?.name;
    if(relation && !collection && !join) attribute.defaultJoin=true;
    if(!attribute.defaultJoin&&columns.some(column=>!column.name || column.nullable===undefined)) { attribute.status='unknown';issue(record,'A nonliteral mapping attribute is unresolved for '+name+'.'); }
    attributes.push(attribute);
  }
  return attributes;
}
function analyzeJPA(javaFiles, supplied={}) {
  const options={physicalNaming:'unknown',basePackages:[],...supplied};
  if(!['unknown','standard','snake_case'].includes(options.physicalNaming)) options.physicalNaming='unknown';
  const files=javaFiles.filter(file=>typeof file.text==='string').map(file=>({...parseJavaFile(file),tokens:lexJava(file.text).tokens}));
  // A known same-package source type wins over an on-demand import. The
  // generic Java scanner cannot know the other compilation units when parsing
  // one file, so correct member references once the bounded source set exists.
  const localTypes=new Map();for(const file of files)for(const type of file.types)localTypes.set(type.fqn,(localTypes.get(type.fqn)||0)+1);
  for(const file of files){
    const aliases=new Map();for(const [fqn,count]of localTypes)if(count===1&&fqn.slice(0,Math.max(0,fqn.lastIndexOf('.')))===file.packageName){const name=fqn.slice(fqn.lastIndexOf('.')+1);if(!file.imports[name])aliases.set(name,fqn);}
    const bind=ref=>{if(!ref)return;const simple=ref.raw?.split(/[<\[]/)[0];if(simple&&!simple.includes('.')&&aliases.has(simple))ref.name=aliases.get(simple);for(const argument of ref.arguments||[])bind(argument);};
    for(const type of file.types)for(const member of [...type.fields,...type.methods]){bind(member.type);for(const parameter of member.parameters||[])bind(parameter.type);}
  }
  if(options.namingStrategy&&(options.namingStrategy.physical||options.namingStrategy.implicit||options.namingStrategy.profile))Object.defineProperty(options,'_naming',{value:require('./naming').createNamingResolver(files,options.namingStrategy,options.physicalNaming)});
  const xml = supplied.mappingFiles?.length||supplied.mappingFilesComplete===false ? require('./xml').applyOrmMappings(files,supplied.mappingFiles||[],options) : {issues:[],documents:[],queries:[]};
  const model={entities:[],embeddables:[],mappedSuperclasses:[],queries:[],diagnostics:[],references:[],issues:[],options,
    files:files.map(file=>({uri:file.uri,text:file.text})),scope:'local-source-model; runtime/XML/other persistence units may differ'};
  model.issues.push(...(xml.issues||[])); model.mappingQueries=xml.queries||[]; model.mappingDocuments=xml.documents||[];
  model.diagnostics.push(...(xml.issues||[]).filter(value=>value.uri&&value.range).map(value=>({...value,code:'jpa.xml.unknown',severity:'information'})));
  model.files.push(...(supplied.mappingFiles||[]).filter(file=>typeof file.text==='string').map(file=>({uri:file.uri,text:file.text})));
  const records=[];
  const issue=(record,message)=>{ record.mappingState='partial';model.issues.push({uri:record.uri,range:record.range,message}); };
  for(const file of files) for(const type of file.types) {
    if(options.basePackages.length && !options.basePackages.some(base=>type.fqn===base||type.fqn.startsWith(base+'.'))) continue;
    const entity=jpa(type.annotations,'Entity',file),embeddable=jpa(type.annotations,'Embeddable',file),mapped=jpa(type.annotations,'MappedSuperclass',file);
    if(!entity&&!embeddable&&!mapped) continue;
    const name=entity?literal(entity,'name',type.name):type.name;
    const record={name:name||type.name,entityNameKnown:name!==undefined,fqn:type.fqn,uri:file.uri,range:type.range,
      kind:entity?'entity':embeddable?'embeddable':'mappedSuperclass',attributes:[],mappingState:'supported',attributesComplete:true,
      access:null,inheritance:enumValue(jpa(type.annotations,'Inheritance',file),'strategy',null),table:null,type,file};
    const table=jpa(type.annotations,'Table',file);
    if(entity) record.table={...physical(literal(table,'name',name||type.name),options,'table',{explicit:Boolean(table?.attributes.name),entityName:name||type.name,entityClassName:type.fqn}),schema:namespaceName(literal(table,'schema',''),options,'schema'),catalog:namespaceName(literal(table,'catalog',''),options,'catalog')};
    if(type.annotations.some(annotation=>accepted(annotation,file,'org.hibernate.annotations'))) {
      record.providerMappingUnknown=true;issue(record,'Hibernate-specific entity mapping requires provider resolution.');
    }
    if(type.jpaXmlPartial) {record.providerMappingUnknown=true;record.attributesComplete=false;for(const message of type.jpaXmlIssues||['XML mapping is partial or conflicting.']) issue(record,message);}
    if(!record.entityNameKnown) issue(record,'Nonliteral entity name is unknown.');
    if(type.kind!=='class') { issue(record,'Only Java class persistence access is modeled.');record.attributesComplete=false; }
    if(hasMultipleFieldDeclarators(record)) {issue(record,'Multiple field declarators are excluded; persistent attribute coverage is partial.');record.attributesComplete=false;}
    if(file.issues.some(value=>/Unicode|Unbalanced|Unsupported annotated field/.test(value))) {issue(record,'Java source parse limitations affect this managed type.');record.attributesComplete=false;}
    records.push(record);
  }
  const unique=fqn=>{const candidates=records.filter(record=>record.fqn===fqn);return candidates.length===1?candidates[0]:null;};
  const built=new Set(),building=new Set();
  function build(record) {
    if(built.has(record)) return;
    if(building.has(record)) {issue(record,'Cyclic persistence inheritance is unresolved.');record.attributesComplete=false;return;}
    building.add(record);
    const typeStart=record.file.tokens.findIndex(token=>token.start===record.type.start);let typeEnd=typeStart;while(typeEnd<record.file.tokens.length&&record.file.tokens[typeEnd].text!=='{')typeEnd++;
    const extendsClass=record.file.tokens.slice(typeStart,typeEnd).some(token=>token.text==='extends');
    const parentNames=extendsClass?record.type.superTypes.filter(name=>name!=='java.lang.Object').slice(0,1):[];
    const parent=parentNames.length?unique(parentNames[0]):null;
    record.superFqn=parent?.fqn||null;
    record.inheritanceRootFqn=parent?.kind==='entity'?(parent.inheritanceRootFqn||parent.fqn):record.fqn;
    if(parent) build(parent);
    else if(parentNames.length) {issue(record,'External or ambiguous superclass mapping is unresolved: '+parentNames[0]);record.attributesComplete=false;}
    const explicit=enumValue(jpa(record.type.annotations,'Access',record.file),'value',null);
    if(jpa(record.type.annotations,'Access',record.file)&&!['FIELD','PROPERTY'].includes(explicit)) {record.attributesComplete=false;issue(record,'Nonliteral/unqualified @Access mode is unresolved.');}
    const fieldId=record.type.fields.some(member=>jpa(member.annotations,'Id',record.file)||jpa(member.annotations,'EmbeddedId',record.file));
    const getterId=record.type.methods.some(member=>jpa(member.annotations,'Id',record.file)||jpa(member.annotations,'EmbeddedId',record.file));
    record.access=explicit||parent?.access||(getterId&&!fieldId?'PROPERTY':'FIELD');
    if(!['FIELD','PROPERTY'].includes(record.access)||fieldId&&getterId&&!explicit) {record.access='FIELD';record.attributesComplete=false;issue(record,'Mixed/unresolved persistence access requires explicit @Access.');}
    if(parent?.kind==='entity') {
      record.inheritance=parent.inheritance||'SINGLE_TABLE';
      if(record.inheritance==='SINGLE_TABLE') record.table=parent.table;
    }
    const inherited=parent?parent.attributes.map(attribute=>{const copy={...attribute,columns:attribute.columns.map(column=>({...column}))};if(attribute._jpa) Object.defineProperty(copy,'_jpa',{value:attribute._jpa,enumerable:false,configurable:true});return copy;}):[];
    const own=mappingAttributes(record,record.file,options,issue);
    record.attributes=[...inherited.filter(attribute=>!own.some(item=>item.name===attribute.name)),...own];
    if(parent&&!parent.attributesComplete) record.attributesComplete=false;
    if(parent?.providerMappingUnknown) {record.providerMappingUnknown=true;issue(record,'Superclass XML/provider physical mapping is unresolved; inherited table/column defaults remain unknown.');}
    for(const attribute of record.attributes) if(!attribute.storageTable && record.table) attribute.storageTable=record.table;
    building.delete(record);built.add(record);
  }
  records.forEach(build);
  for(const record of records.filter(record=>record.kind==='embeddable'&&!jpa(record.type.annotations,'Access',record.file))) {
    const contexts=[...new Set(records.filter(owner=>owner.attributes.some(attribute=>attribute.kind==='embedded'&&attribute.targetFqn===record.fqn)).map(owner=>owner.access))];
    if(contexts.length===1&&contexts[0]!==record.access) {
      record.access=contexts[0];record.attributes=mappingAttributes(record,record.file,options,issue);
    } else if(contexts.length>1) {
      record.attributesComplete=false;issue(record,'Embeddable access varies between owning contexts; add explicit @Access for one physical model.');
      for(const attribute of record.attributes) attribute.status='unknown';
    }
  }
  enrichMappings(records,files,options,{jpa,accepted,resolveType,physical,namespaceName,enumValue,numeric,issue});
  for(const record of records) {
    for(const attribute of record.attributes) {
      const target=attribute.targetFqn?unique(attribute.targetFqn):null;
      if(attribute.targetFqn&&!target&&attribute.kind!=='elementCollection') {attribute.status='unknown';issue(record,'Association/embeddable target is external or ambiguous: '+attribute.targetFqn);}
      if(attribute.mappedBy&&target&&!target.attributes.some(item=>item.name===attribute.mappedBy)) model.diagnostics.push({uri:attribute.uri,range:attribute.range,code:'jpa.mapping.mappedBy',severity:target.attributesComplete?'warning':'information',message:'mappedBy '+attribute.mappedBy+' is not a persistent attribute in the local '+target.name+' model.'});
    }
    const duplicate=records.filter(other=>other.fqn===record.fqn||other!==record&&other.kind==='entity'&&record.kind==='entity'&&other.name===record.name);
    if(duplicate.length>1) {record.attributesComplete=false;record.providerMappingUnknown=true;issue(record,'Duplicate managed type/entity name may belong to multiple persistence units; binding remains ambiguous.');}
    if(record.kind==='entity'&&record.attributesComplete&&!record.attributes.some(attribute=>attribute.id)) model.diagnostics.push({uri:record.uri,range:record.range,code:'jpa.mapping.id.missing',severity:'warning',message:'No Id or EmbeddedId is present in this complete local entity hierarchy; XML/runtime overrides are not modeled.'});
    const {type,file,...plain}=record;
    if(record.kind==='entity') model.entities.push(plain);
    else if(record.kind==='embeddable') model.embeddables.push(plain);
    else model.mappedSuperclasses.push(plain);
  }
  analyzeQueries(model,files,{jpa,accepted,resolveType,offsetAt});
  return model;
}
function compareCatalog(model,catalog) {
  const report={matches:[],mismatches:[],unknowns:[],summary:{},source:'read-only database catalog',database:catalog?.database||null,scope:'declared local mapping vs currently visible catalog; no DDL or application queries executed'};
  const tables=[...(catalog?.tables||[]),...(catalog?.views||[])], managed=[...model.entities,...model.embeddables,...model.mappedSuperclasses];
  const unique=fqn=>{const values=managed.filter(item=>item.fqn===fqn);return values.length===1?values[0]:null;};
  function columns(entity,attributes,prefix='',seen=new Set(),embeddedId=false) {
    const result=[];
    for(const attribute of attributes) {
      const property=prefix+attribute.name;
      if(attribute.kind==='embedded') {
        const target=unique(attribute.targetFqn);
        if(target&&!seen.has(target.fqn)&&attribute.status==='known') result.push(...columns(entity,target.attributes,property+'.',new Set([...seen,target.fqn]),embeddedId||attribute.id));
        else report.unknowns.push({entity:entity.name,property,reason:'Embeddable/override mapping unresolved',uri:attribute.uri,range:attribute.range});
      } else if(attribute.columns.length&&attribute.status==='known') {
        for(const column of attribute.columns) result.push({attribute,column:embeddedId?{...column,primaryKey:true,nullable:false,explicitNullable:true}:column,property,table:attribute.storageTable||entity.table});
      } else if(attribute.collection&&attribute.mappedBy) continue;
      else report.unknowns.push({entity:entity.name,property,reason:'Physical mapping not supported',uri:attribute.uri,range:attribute.range});
    }
    return result;
  }
  for(const entity of model.entities) {
    if(entity.providerMappingUnknown) {report.unknowns.push({entity:entity.name,reason:'Provider-specific entity mapping is unresolved; a physical table absence is not inferred.',uri:entity.uri,range:entity.range});continue;}
    if(entity.mappingState!=='supported') report.unknowns.push({entity:entity.name,reason:'This source mapping is partial; only supported column declarations are compared.',uri:entity.uri,range:entity.range});
    if(!entity.table?.physicalName) {report.unknowns.push({entity:entity.name,reason:'Physical table name unresolved',uri:entity.uri,range:entity.range});continue;}
    if(entity.inheritance==='TABLE_PER_CLASS'&&entity.abstract) {report.unknowns.push({entity:entity.name,reason:'An abstract TABLE_PER_CLASS entity has no independent concrete table to compare.',uri:entity.uri,range:entity.range});continue;}
    const items=Array.isArray(entity.columnMappings)?entity.columnMappings.filter(binding=>{
      if(binding.status==='known'&&binding.column)return true;
      report.unknowns.push({entity:entity.name,property:binding.property,reason:binding.reason||'Physical mapping is unresolved.',uri:binding.uri,range:binding.range});return false;
    }).map(binding=>({property:binding.property,column:binding.column,table:binding.storageTable||entity.table,attribute:{javaType:binding.javaType,uri:binding.uri,range:binding.range}})):columns(entity,entity.attributes);
    for(const item of items) {
      const context={entity:entity.name,property:item.property,table:item.table?.physicalName,column:item.column.physicalName,uri:item.attribute.uri,range:item.attribute.range};
      if([item.table?.schema,item.table?.catalog].some(name=>name===undefined||name&&name!==catalog?.database)) {report.unknowns.push({...context,reason:'This column selects a different or unresolved catalog/schema from the connected metadata scope.'});continue;}
      const exact=tables.find(table=>table.name===item.table?.physicalName);
      const caseVariants=tables.filter(table=>table.name.toLowerCase()===item.table?.physicalName?.toLowerCase());
      const table=exact||(caseVariants.length===1?caseVariants[0]:null);
      const certain=Boolean(exact)&&item.table?.certainty==='configured'&&item.column.certainty==='configured';
      const declaredCertain=item.table?.certainty==='configured'&&item.column.certainty==='configured';
      if(!table) {
        (declaredCertain?report.mismatches:report.unknowns).push({...context,code:'jpa.catalog.table',reason:declaredCertain?'Declared physical table is not visible in this catalog; absence and account permissions cannot be distinguished.':'Table not matched; physical naming strategy is unknown.'});continue;
      }
      if(!exact) report.unknowns.push({...context,code:'jpa.catalog.case',reason:'A table differs only by case; server identifier-case policy was not loaded, so a definite mismatch is not inferred.'});
      // MySQL/MariaDB column identifiers are case-insensitive; table behavior
      // depends on server/filesystem settings and remains uncertain above.
      const column=table.columns.find(column=>column.name.toLowerCase()===item.column.physicalName?.toLowerCase());
      if(!column) {(certain?report.mismatches:report.unknowns).push({...context,code:'jpa.catalog.column',reason:certain?'Declared physical column is not visible in the selected table.':'Column not matched; physical naming strategy is unknown.'});continue;}
      report.matches.push({...context,certainty:certain?'configured physical mapping':'declared name matches observed catalog'});
      if(!certain) continue;
      if(item.column.columnDefinition) {report.unknowns.push({...context,code:'jpa.catalog.columnDefinition',reason:'Custom columnDefinition SQL is not parsed; only the declared column name is compared.'});continue;}
      if(item.column.primaryKey&&!column.primaryKey) report.mismatches.push({...context,code:'jpa.catalog.id',reason:'The declared Id column is not reported as a database primary key.'});
      if(item.column.explicitNullable&&item.column.nullable===false&&column.nullable===true) report.mismatches.push({...context,code:'jpa.catalog.nullability',reason:'The mapping declares non-null but the catalog allows NULL.'});
      const actualLength=/^(?:var)?char\((\d+)\)/i.exec(column.type||'');
      if(item.column.length!==undefined&&actualLength&&item.column.length!==Number(actualLength[1])) report.mismatches.push({...context,code:'jpa.catalog.length',reason:'Declared length '+item.column.length+' differs from catalog length '+actualLength[1]+'.'});
      const java=item.attribute.javaType?.replace(/^java\.lang\./,'');
      const legacyExpected={String:['char','varchar','tinytext','text','mediumtext','longtext','enum','set'],Long:['bigint'],long:['bigint'],Integer:['int','integer'],int:['int','integer'],
        Short:['smallint'],short:['smallint'],Byte:['tinyint'],byte:['tinyint'],Boolean:['bit','tinyint','boolean','bool'],boolean:['bit','tinyint','boolean','bool'],
        Float:['float','real'],float:['float','real'],Double:['double','float','real'],double:['double','float','real'],
        'java.math.BigDecimal':['decimal','numeric'],'java.time.LocalDate':['date'],'java.time.LocalDateTime':['datetime','timestamp'],'java.time.Instant':['timestamp','datetime']}[java];
      const expected=item.column.dbType?item.column.dbType.certainty==='known'?item.column.dbType.expectedFamilies:null:legacyExpected;
      if(item.column.dbType?.certainty==='unknown')report.unknowns.push({...context,code:'jpa.catalog.type.unknown',reason:item.column.dbType.reason||'The JDBC type is unresolved; the column name remains independently comparable.'});
      const actualFamily=/^[a-z]+/i.exec(column.type||'')?.[0].toLowerCase();
      if(expected&&actualFamily&&!item.column.columnDefinition&&!expected.includes(actualFamily)) report.mismatches.push({...context,code:'jpa.catalog.type',reason:'The local '+item.attribute.javaType+' default mapping expects '+expected.join('/')+' but the catalog reports '+column.type+'. Provider type overrides remain outside this model.'});
      const decimal=/^(?:decimal|numeric)\((\d+),(\d+)\)/i.exec(column.type||'');
      if(decimal&&((item.column.precision>0&&item.column.precision!==Number(decimal[1]))||(item.column.scale!==undefined&&item.column.scale!==Number(decimal[2])))) report.mismatches.push({...context,code:'jpa.catalog.precision',reason:'Explicit decimal precision/scale differs from the visible catalog definition.'});
    }
  }
  report.summary={matches:report.matches.length,mismatches:report.mismatches.length,unknowns:report.unknowns.length};
  return report;
}
module.exports={analyzeJPA,completionsAt,definitionsAt,compareCatalog,offsetAt};
