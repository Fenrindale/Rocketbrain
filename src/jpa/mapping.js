'use strict';
const { literal } = require('../spring/java');

function closeAt(tokens,index) {
  const pairs={'(':')','{':'}','[':']','<':'>'},close=pairs[tokens[index]?.text];let depth=0;
  for(let i=index;i<tokens.length;i++){if(tokens[i].text===tokens[index].text)depth++;else if(tokens[i].text===close&&!--depth)return i;}return -1;
}
function split(tokens) {
  const out=[];let begin=0,depth=0;
  for(let i=0;i<tokens.length;i++){if(['(','{','[','<'].includes(tokens[i].text))depth++;else if([')','}',']','>'].includes(tokens[i].text))depth--;else if(!depth&&tokens[i].text===','){out.push(tokens.slice(begin,i));begin=i+1;}}
  out.push(tokens.slice(begin));return out.filter(part=>part.length);
}
function nested(tokens=[],file) {
  const output=[];
  for(let i=0;i<tokens.length;i++) {
    if(tokens[i].text!=='@'||tokens[i+1]?.kind!=='id')continue;
    const start=i;let name=tokens[++i].text;
    while(tokens[i+1]?.text==='.'&&tokens[i+2]?.kind==='id'){name+='.'+tokens[i+2].text;i+=2;}
    const attributes={};let end=i;
    if(tokens[i+1]?.text==='('){end=closeAt(tokens,i+1);if(end<0)continue;for(const part of split(tokens.slice(i+2,end))){if(part[0]?.kind==='id'&&part[1]?.text==='=')attributes[part[0].text]=part.slice(2);else attributes.value=part;}i=end;}
    const shortName=name.split('.').at(-1),resolved=name.includes('.')?name:file.imports[shortName]||(file.packageName?file.packageName+'.':'')+name;
    output.push({name:resolved,shortName,attributes,start:tokens[start].start,end:tokens[end].end});
  }
  return output;
}
const JAVA_LANG=new Set(['String','Long','Integer','Short','Byte','Boolean','Float','Double','Character','Object','Number','Void']);
function typeName(name,file) { if(!name)return null;if(name.includes('.'))return name;if(JAVA_LANG.has(name))return 'java.lang.'+name;if(['byte','short','int','long','boolean','float','double','char'].includes(name))return name;return file.imports[name]||(file.packageName?file.packageName+'.':'')+name; }
function classValue(annotation,key,file) {const raw=annotation?.attributes[key]?.map(token=>token.text).join('');return /\.class$/.test(raw||'')?typeName(raw.slice(0,-6),file):null;}

function enrichMappings(records,files,options,helpers) {
  const {jpa,accepted,physical,namespaceName,enumValue,numeric,issue}=helpers;
  const managed=fqn=>{const values=records.filter(record=>record.fqn===fqn);return values.length===1?values[0]:null;};
  const allTypes=files.flatMap(file=>file.types.map(type=>({type,file})));
  const localType=fqn=>{const values=allTypes.filter(value=>value.type.fqn===fqn);return values.length===1?values[0]:null;};
  const many=(annotations,name,container,file)=>{
    const direct=annotations.filter(annotation=>jpa([annotation],name,file));
    for(const wrapper of annotations.filter(annotation=>jpa([annotation],container,file)))direct.push(...nested(wrapper.attributes.value,file).filter(annotation=>jpa([annotation],name,file)));
    return direct;
  };
  const inner=(annotation,key,name,file)=>nested(annotation?.attributes[key]||[],file).filter(value=>jpa([value],name,file));
  const note=(record,message)=>issue(record,message);
  function table(annotation,fallback,role='primary') {
    const value={...physical(literal(annotation,'name',fallback),options,'table',{explicit:Boolean(annotation?.attributes.name)}),schema:namespaceName(literal(annotation,'schema',''),options,'schema'),catalog:namespaceName(literal(annotation,'catalog',''),options,'catalog'),role,mappingStatus:'known'};
    if(!value.name||value.schema===undefined||value.catalog===undefined)value.mappingStatus='unknown';
    if(annotation?._xmlSource)value.source=annotation._xmlSource;
    return value;
  }
  function column(annotation,name,id=false,implicitMethod='determineBasicColumnName') {
    const value={...physical(literal(annotation,'name',name),options,'column',{explicit:Boolean(annotation?.attributes.name),propertyPath:name,implicitMethod}),nullable:literal(annotation,'nullable',!id),explicitNullable:Boolean(annotation?.attributes.nullable)||id,primaryKey:id,
      length:numeric(annotation,'length',undefined),precision:numeric(annotation,'precision',undefined),scale:numeric(annotation,'scale',undefined),columnDefinition:literal(annotation,'columnDefinition',''),
      insertable:literal(annotation,'insertable',true),updatable:literal(annotation,'updatable',true),referencedColumnName:literal(annotation,'referencedColumnName',null),tableName:literal(annotation,'table',''),mappingStatus:'known'};
    if(!value.name||value.nullable===undefined||value.tableName===undefined)value.mappingStatus='unknown';
    if(annotation?._xmlSource)value.source=annotation._xmlSource;
    return value;
  }
  const normalize=name=>({int:'java.lang.Integer',long:'java.lang.Long',short:'java.lang.Short',byte:'java.lang.Byte',boolean:'java.lang.Boolean',float:'java.lang.Float',double:'java.lang.Double',char:'java.lang.Character'}[name]||name);
  const families=name=>({
    'java.lang.String':['char','varchar','tinytext','text','mediumtext','longtext','enum','set'],'java.lang.Character':['char','varchar'],
    'java.lang.Long':['bigint'],'java.lang.Integer':['int','integer'],'java.lang.Short':['smallint'],'java.lang.Byte':['tinyint'],'java.lang.Boolean':['bit','tinyint','boolean','bool'],
    'java.lang.Float':['float','real'],'java.lang.Double':['double','float','real'],'java.math.BigDecimal':['decimal','numeric'],
    'java.math.BigInteger':['decimal','numeric','bigint'],'java.time.LocalDate':['date'],'java.time.LocalTime':['time'],'java.time.LocalDateTime':['datetime','timestamp'],'java.time.Instant':['timestamp','datetime'],
    'java.sql.Date':['date'],'java.sql.Time':['time'],'java.sql.Timestamp':['timestamp','datetime'],'byte[]':['binary','varbinary','tinyblob','blob','mediumblob','longblob']
  })[normalize(name)];
  const converters=[];
  for(const {type,file} of allTypes) {
    const annotation=jpa(type.annotations,'Converter',file);if(!annotation)continue;
    const start=file.tokens.findIndex(token=>token.start===type.start);let end=start;while(end<file.tokens.length&&file.tokens[end].text!=='{')end++;
    const header=file.tokens.slice(start+1,end);let generic;
    for(let i=0;i<header.length;i++)if(header[i].text==='AttributeConverter'&&header[i+1]?.text==='<'){
      const qualified=header.slice(Math.max(0,i-4),i+1).map(token=>token.text).join('');
      if(!file.wildcards.some(value=>['jakarta.persistence','javax.persistence'].includes(value))&&!['jakarta.persistence.AttributeConverter','javax.persistence.AttributeConverter'].includes(file.imports.AttributeConverter)&&!/(jakarta|javax)\.persistence\.AttributeConverter$/.test(qualified))continue;
      const close=closeAt(header,i+1);if(close>0)generic=split(header.slice(i+2,close)).map(tokens=>tokens.map(token=>token.text).join(''));
    }
    converters.push({fqn:type.fqn,autoApply:literal(annotation,'autoApply',false),attributeType:generic?.length===2?typeName(generic[0],file):null,relationalJavaType:generic?.length===2?typeName(generic[1],file):null,uri:file.uri,range:type.range});
  }
  function typeDescriptor(attribute,annotations,file,conversionOverride) {
    const javaType=attribute.collection?attribute.elementJavaType:attribute.javaType;
    const descriptor={javaType,relationalJavaType:javaType,certainty:'known',source:'basic',expectedFamilies:families(javaType)||null};
    const unknown=reason=>({...descriptor,certainty:'unknown',expectedFamilies:null,reason});
    if(annotations.some(annotation=>accepted(annotation,file,'org.hibernate.annotations')))return unknown('Provider-specific attribute type or formula is not executed.');
    const enumerated=jpa(annotations,'Enumerated',file),temporal=jpa(annotations,'Temporal',file),lob=jpa(annotations,'Lob',file);
    const conversion=conversionOverride?.annotation||conversionOverride||jpa(annotations,'Convert',file),conversionFile=conversionOverride?.file||file;
    if(conversion?.attributes.disableConversion&&literal(conversion,'disableConversion',undefined)===undefined)return unknown('The conversion disable flag is not literal.');
    if(enumerated||localType(javaType)?.type.kind==='enum') {
      if(conversion&&!literal(conversion,'disableConversion',false))return unknown('Convert and Enumerated cannot be combined portably.');
      const enumType=localType(javaType);
      if(!enumerated&&enumType?.type.fields.some(field=>jpa(field.annotations,'EnumeratedValue',enumType.file)))return unknown('EnumeratedValue enum field requires provider interpretation.');
      const mode=enumValue(enumerated,'value','ORDINAL');
      if(!['STRING','ORDINAL'].includes(mode))return unknown('The enum storage mode is not literal.');
      return {...descriptor,source:'enumerated',mode,relationalJavaType:mode==='STRING'?'java.lang.String':'java.lang.Integer',expectedFamilies:mode==='STRING'?['char','varchar','enum']:['tinyint','smallint','int','integer']};
    }
    if(temporal) {
      if(conversion&&!literal(conversion,'disableConversion',false))return unknown('Convert and Temporal cannot be combined portably.');
      const mode=enumValue(temporal,'value',null),expected={DATE:['date'],TIME:['time'],TIMESTAMP:['timestamp','datetime']}[mode];
      return expected?{...descriptor,source:'temporal',mode,expectedFamilies:expected}:unknown('The temporal storage mode is not literal.');
    }
    let converter;
    if(conversion&&literal(conversion,'disableConversion',false)!==true) {
      const fqn=classValue(conversion,'converter',conversionFile);const candidates=converters.filter(value=>value.fqn===fqn);converter=candidates.length===1?candidates[0]:null;
      if(!fqn||!converter)return unknown('Explicit AttributeConverter generic declaration is unavailable or ambiguous.');
    } else if(!conversion&&!attribute.id&&!attribute.version&&attribute.kind==='basic'||!conversion&&attribute.kind==='elementCollection') {
      const uncertain=converters.some(value=>value.autoApply!==false&&(!value.attributeType||value.autoApply!==true&&normalize(value.attributeType)===normalize(javaType)));
      if(uncertain)return unknown('An unresolved autoApply converter could affect this attribute.');
      const matches=converters.filter(value=>value.autoApply===true&&normalize(value.attributeType)===normalize(javaType));
      if(matches.length>1)return unknown('Multiple autoApply AttributeConverters match this Java type.');converter=matches[0];
    }
    if(converter) {
      if(attribute.id||attribute.version||!['basic','elementCollection'].includes(attribute.kind))return unknown('Conversion of identifiers, versions or relationships is not portable.');
      if(!converter.relationalJavaType||normalize(converter.attributeType)!==normalize(javaType))return unknown('AttributeConverter type parameters do not match this attribute.');
      return {...descriptor,source:'converter',converter:converter.fqn,relationalJavaType:converter.relationalJavaType,expectedFamilies:families(converter.relationalJavaType)||null,valueTransformation:'not-executed',converterDeclaration:{uri:converter.uri,range:converter.range}};
    }
    if(lob) {
      if(['java.lang.String','char[]','java.lang.Character[]'].includes(javaType))return {...descriptor,source:'lob',expectedFamilies:['clob','nclob','tinytext','text','mediumtext','longtext']};
      if(['byte[]','java.lang.Byte[]'].includes(javaType))return {...descriptor,source:'lob',expectedFamilies:['blob','tinyblob','mediumblob','longblob']};
      return unknown('The LOB Java type is outside the supported string/byte-array declarations.');
    }
    if(!descriptor.expectedFamilies)return unknown('The provider JDBC mapping for this basic Java type is unresolved.');
    return descriptor;
  }
  function overrideMap(annotations,file,prefix='') {
    const result=new Map();
    for(const kind of ['Attribute','Association'])for(const annotation of many(annotations,kind+'Override',kind+'Overrides',file)) {
      const name=literal(annotation,'name',null),key=typeof name==='string'?prefix+name:null;
      const value={kind:kind.toLowerCase(),annotation,file,known:Boolean(key)};
      if(result.has(key))value.known=false;
      result.set(key,value);
    }
    return result;
  }
  function conversionMap(annotations,file,prefix='') {
    const result=new Map();for(const annotation of many(annotations,'Convert','Converts',file)){const name=literal(annotation,'attributeName','');if(name)result.set(prefix+name,{annotation,file});}return result;
  }
  const prepared=new Set(),secondaryMetadata=new Map();
  function prepare(record) {
    if(prepared.has(record))return;prepared.add(record);
    const parent=managed(record.superFqn);if(parent)prepare(parent);
    record.abstract=(()=>{const index=record.file.tokens.findIndex(token=>token.start===record.type.start);return record.file.tokens.slice(Math.max(0,index-5),index).some(token=>token.text==='abstract');})();
    if(record.kind==='entity') {
      if(!record.inheritance)record.inheritance=parent?.kind==='entity'?parent.inheritance:'SINGLE_TABLE';
      if(parent?.kind==='entity'&&record.inheritance==='SINGLE_TABLE')record.table=parent.table;
      record.tables=parent?.kind==='entity'&&record.inheritance==='JOINED'?[...parent.tables]:[];
      if(record.table&&!record.tables.some(value=>value.physicalName===record.table.physicalName))record.tables.push({...record.table,role:'primary',mappingStatus:record.table.name?'known':'unknown'});
      const secondary=many(record.type.annotations,'SecondaryTable','SecondaryTables',record.file).map(annotation=>({table:table(annotation,null,'secondary'),annotation,file:record.file}));
      secondaryMetadata.set(record,secondary);record.secondaryTables=secondary.map(value=>value.table);
      record.tables.push(...record.secondaryTables);
    } else record.tables=[];
    const inherited=parent?parent._physicalOverrides:new Map();
    record._physicalOverrides=new Map([...inherited,...overrideMap(record.type.annotations,record.file)]);
  }
  records.forEach(prepare);
  function selectTable(owner,name,fallback) {
    if(name==='')return fallback;
    const values=owner.tables.filter(value=>value.name===name||value.physicalName===name);
    return values.length===1?values[0]:{...physical(typeof name==='string'?name:null,options,'table'),mappingStatus:'unknown',role:'unresolved',reason:'Column.table does not uniquely select a declared primary/secondary table.'};
  }
  function baseTable(owner,attribute,fallback) {
    if(['collection','join'].includes(fallback?.role))return fallback;
    if(owner.inheritance==='TABLE_PER_CLASS')return owner.table||fallback;
    const declaring=managed(attribute.declaredIn);
    if(owner.inheritance==='JOINED'&&declaring?.kind==='entity')return declaring.table;
    return attribute.storageTable||fallback;
  }
  const idCache=new Map();
  function ids(record,seen=new Set()) {
    if(!record||record.providerMappingUnknown||seen.has(record.fqn))return[];if(idCache.has(record))return idCache.get(record);
    const result=[];
    for(const attribute of record.attributes.filter(value=>value.id)) {
      if(attribute.kind==='embedded') {
        const target=managed(attribute.targetFqn);if(target&&!target.providerMappingUnknown)for(const nestedAttribute of target.attributes.filter(value=>value.kind==='basic')) {
          const meta=nestedAttribute._jpa;if(!meta)continue;
          const localOverrides=overrideMap(attribute._jpa?.member.annotations||[],attribute._jpa?.file||record.file);
          const override=record._physicalOverrides.get(attribute.name+'.'+nestedAttribute.name)||localOverrides.get(nestedAttribute.name);
          const declaration=override?.known?inner(override.annotation,'column','Column',override.file)[0]:jpa(meta.member.annotations,'Column',meta.file);
          const col=column(declaration,nestedAttribute.name,true);col.dbType=typeDescriptor(nestedAttribute,meta.member.annotations,meta.file);
          result.push({property:attribute.name+'.'+nestedAttribute.name,column:col,javaType:nestedAttribute.javaType});
        }
      } else if(attribute.kind==='basic') {
        const meta=attribute._jpa;if(!meta)continue;const override=record._physicalOverrides?.get(attribute.name);
        const declaration=override?.known&&override.kind==='attribute'?inner(override.annotation,'column','Column',override.file)[0]:jpa(meta.member.annotations,'Column',meta.file);
        const col=column(declaration,attribute.name,true);if(override&&(!override.known||!declaration))col.mappingStatus='unknown';col.dbType=typeDescriptor(attribute,meta.member.annotations,meta.file);result.push({property:attribute.name,column:col,javaType:attribute.javaType});
      } else {
        const meta=attribute._jpa,target=managed(attribute.targetFqn),targetIds=ids(target,new Set([...seen,record.fqn]));
        const declarations=meta?joinDeclarations(meta.member.annotations,meta.file):[];
        for(let i=0;i<declarations.length;i++){const declaration=declarations[i],ref=literal(declaration,'referencedColumnName',targetIds.length===1?targetIds[0].column.name:null),matched=targetIds.find(value=>value.column.name===ref);const col=column(declaration,null,true);if(matched)col.dbType=matched.column.dbType;result.push({property:attribute.name,column:col,javaType:matched?.javaType});}
      }
    }
    idCache.set(record,result);return result;
  }
  function joinDeclarations(annotations,file,name='JoinColumn',container='JoinColumns') {return many(annotations,name,container,file);}
  function joinColumns(declarations,targetIds,prefix,primaryKey=false) {
    // Hibernate's default joins may consume a referenced *physical* identifier.
    // Until that full source context is modeled, do not infer a second custom
    // transformation from a renamed target PK's original logical spelling.
    const protectDefault=(col,target)=>options._naming&&target?.column?.physicalName!==target?.column?.name?{...col,mappingStatus:'unknown',reason:'Default join naming for a custom-renamed referenced identifier requires additional Hibernate naming context.'}:col;
    if(!declarations.length) {
      if(primaryKey&&!prefix&&targetIds.length)return targetIds.map(target=>protectDefault({...column(null,target.column.name,true,'determinePrimaryKeyJoinColumnName'),mappingStatus:target.column.mappingStatus,referencedColumnName:target.column.name,dbType:target.column.dbType},target));
      if(targetIds.length!==1)return[];
      return[protectDefault({...column(null,prefix?prefix+'_'+targetIds[0].column.name:targetIds[0].column.name,primaryKey,'determineJoinColumnName'),referencedColumnName:targetIds[0].column.name,dbType:targetIds[0].column.dbType},targetIds[0])];
    }
    return declarations.map(declaration=>{
      const ref=literal(declaration,'referencedColumnName',targetIds.length===1?targetIds[0].column.name:null),target=targetIds.find(value=>value.column.name===ref);
      const col=column(declaration,declarations.length===1&&targetIds.length===1?(prefix?prefix+'_'+targetIds[0].column.name:targetIds[0].column.name):null,primaryKey,'determineJoinColumnName');
      col.referencedColumnName=ref;col.dbType=target?.column.dbType||{certainty:'unknown',expectedFamilies:null,reason:'Referenced identifier column is unresolved.'};
      if(targetIds.length>1&&(!literal(declaration,'name',null)||!ref))col.mappingStatus='unknown';return literal(declaration,'name',null)?col:protectDefault(col,target);
    });
  }
  function add(bindings,owner,attribute,property,col,storageTable,status='known',reason) {
    const known=status==='known'&&col?.mappingStatus!=='unknown'&&storageTable?.mappingStatus!=='unknown';
    bindings.push({property,column:col||null,storageTable,javaType:attribute.javaType,id:attribute.id,status:known?'known':'unknown',reason:known?undefined:reason||col?.reason||storageTable?.reason||'This attribute/table mapping is unresolved.',uri:attribute.uri,range:attribute.range});
  }
  function expand(owner,attributes,bindings,prefix='',fallback=owner.table,overrides=owner._physicalOverrides,seen=new Set(),embeddedId=false,conversions=new Map()) {
    for(const attribute of attributes) {
      const property=prefix+attribute.name,meta=attribute._jpa;
      if(!meta){add(bindings,owner,attribute,property,null,fallback,'unknown','Source mapping metadata is unavailable.');continue;}
      const {member,file}=meta,annotations=member.annotations;
      const override=overrides.get(property),unknownOverride=overrides.has(null)||override&&(!override.known||override.kind==='attribute'&&inner(override.annotation,'column','Column',override.file).length!==1);
      const currentTable=baseTable(owner,attribute,fallback);
      if(owner.derivedIdentityUnknown&&(attribute.id||jpa(annotations,'MapsId',file))) {add(bindings,owner,attribute,property,null,currentTable,'unknown','MapsId derived identity requires additional coupled identity resolution.');continue;}
      if(attribute.kind==='embedded') {
        const target=managed(attribute.targetFqn);
        if(!target||target.providerMappingUnknown||seen.has(target.fqn)||attribute.status!=='known'||override){add(bindings,owner,attribute,property,null,currentTable,'unknown','Embeddable target/access or XML/provider mapping is external, recursive, or the override does not name a basic/association leaf.');continue;}
        const targetOverrides=overrideMap(target.type.annotations,target.file,property+'.'),memberOverrides=overrideMap(annotations,file,property+'.');
        const combined=new Map([...targetOverrides,...memberOverrides,...overrides]);
        const memberConversions=conversionMap(annotations,file,property+'.');
        expand(owner,target.attributes,bindings,property+'.',currentTable,combined,new Set([...seen,target.fqn]),embeddedId||attribute.id,new Map([...memberConversions,...conversions]));
        continue;
      }
      if(attribute.collection||jpa(annotations,'JoinTable',file)||override?.kind==='association'&&inner(override.annotation,'joinTable','JoinTable',override.file).length) {
        if(attribute.mappedBy)continue;
        const collection=attribute.kind==='elementCollection',joinTable=override?.kind==='association'?inner(override.annotation,'joinTable','JoinTable',override.file)[0]:null;
        const declaration=joinTable||jpa(annotations,collection?'CollectionTable':'JoinTable',file);
        if(!declaration||unknownOverride||attribute.status!=='known') {add(bindings,owner,attribute,property,null,currentTable,'unknown','Explicit collection/join table metadata is required for this physical model.');continue;}
        const storage=table(declaration,null,collection?'collection':'join');attribute.tableMapping=storage;
        if(!owner.tables.some(value=>value.physicalName===storage.physicalName&&value.role===storage.role))owner.tables.push(storage);
        const ownerCols=joinColumns(inner(declaration,'joinColumns','JoinColumn',file),ids(owner),owner.name,false);
        if(!ownerCols.length)add(bindings,owner,attribute,property+'.<owner>',null,storage,'unknown','Composite owner join columns must be explicit.');
        for(const col of ownerCols)add(bindings,owner,attribute,property+'.<owner>',col,storage);
        if(collection) {
          const target=managed(attribute.targetFqn);
          if(target?.kind==='embeddable')expand(owner,target.attributes,bindings,property+'.',storage,new Map([...overrideMap(annotations,file,property+'.'),...overrides]),new Set([...seen,target.fqn]),false);
          else {
            const col=column(jpa(annotations,'Column',file),attribute.name,false);col.dbType=typeDescriptor(attribute,annotations,file,conversions.get(property));
            add(bindings,owner,attribute,property,col,storage,attribute.status);
          }
        } else {
          const target=managed(attribute.targetFqn),inverse=joinColumns(inner(declaration,'inverseJoinColumns','JoinColumn',file),ids(target),target?.name||'',false);
          if(!inverse.length)add(bindings,owner,attribute,property+'.<inverse>',null,storage,'unknown','Inverse identifier/join columns are unresolved.');
          for(const col of inverse)add(bindings,owner,attribute,property+'.<inverse>',col,storage);
        }
        continue;
      }
      if(attribute.kind!=='basic') {
        if(attribute.mappedBy)continue;
        const target=managed(attribute.targetFqn),declarations=override?.kind==='association'?inner(override.annotation,'joinColumns','JoinColumn',override.file):joinDeclarations(annotations,file);
        const cols=joinColumns(declarations,ids(target),attribute.name,embeddedId||attribute.id);
        if(!prefix)attribute.columns=cols;
        if(!cols.length){if(!prefix)attribute.status='unknown';add(bindings,owner,attribute,property,null,currentTable,'unknown','Default/composite join identity is unresolved.');}
        for(const col of cols)add(bindings,owner,attribute,property,col,selectTable(owner,col.tableName,currentTable),unknownOverride||override&&override.kind!=='association'?'unknown':attribute.status==='unknown'&&target?'unknown':'known');
        continue;
      }
      const declaration=override?.kind==='attribute'&&override.known?inner(override.annotation,'column','Column',override.file)[0]:jpa(annotations,'Column',file);
      const col=column(declaration,attribute.name,embeddedId||attribute.id);col.dbType=typeDescriptor(attribute,annotations,file,conversions.get(property));
      attribute.dbType=col.dbType;
      if(!prefix)attribute.columns=[col];
      add(bindings,owner,attribute,property,col,selectTable(owner,col.tableName,currentTable),unknownOverride||override&&override.kind!=='attribute'?'unknown':attribute.status,unknownOverride?'An override path/name is nonliteral or duplicated.':undefined);
    }
  }
  for(const record of records) {
    for(const attribute of record.attributes) {
      const meta=attribute._jpa;if(!meta)continue;
      const raw=meta.member.type.raw,base=raw.replace(/\[\]$/,'');
      if(JAVA_LANG.has(base))attribute.javaType='java.lang.'+base+(meta.member.type.array?'[]':'');
      if(attribute.kind==='elementCollection'&&!managed(attribute.targetFqn))attribute.targetFqn=null;
      if(record.inheritance==='TABLE_PER_CLASS')attribute.storageTable=record.table;
    }
    record.derivedIdentityUnknown=record.attributes.some(attribute=>attribute._jpa&&jpa(attribute._jpa.member.annotations,'MapsId',attribute._jpa.file));
    const idClass=jpa(record.type.annotations,'IdClass',record.file),idAttrs=record.attributes.filter(attribute=>attribute.id);
    if(idClass) {
      const name=classValue(idClass,'value',record.file),target=localType(name),names=idAttrs.map(attribute=>attribute.name);
      record.identity={kind:'id-class',className:name,attributes:names,certainty:target&&names.length>0&&idAttrs.every(attribute=>target.type.fields.some(field=>field.name===attribute.name&&normalize(JAVA_LANG.has(field.type.raw)?'java.lang.'+field.type.raw:field.type.name)===normalize(attribute.javaType)))?'known':'unknown'};
      if(record.identity.certainty==='unknown')note(record,'IdClass declaration is external or does not contain every declared identity attribute.');
    } else record.identity={kind:idAttrs.some(attribute=>attribute.kind==='embedded')?'embedded-id':idAttrs.length===1?'simple':'composite',attributes:idAttrs.map(attribute=>attribute.name),certainty:idAttrs.length?'known':'unknown'};
    if(record.kind!=='entity')continue;
    const bindings=[];
    expand(record,record.attributes,bindings,'',record.table,record._physicalOverrides,new Set([record.fqn]),false,conversionMap(record.type.annotations,record.file));
    const primaryIds=ids(record);
    if(record.inheritance==='JOINED'&&managed(record.superFqn)?.kind==='entity') {
      const declarations=joinDeclarations(record.type.annotations,record.file,'PrimaryKeyJoinColumn','PrimaryKeyJoinColumns');
      const cols=joinColumns(declarations,primaryIds,'',true);
      for(const col of cols)add(bindings,record,{name:'<joined-id>',javaType:col.dbType?.javaType,uri:record.uri,range:record.range,id:true},'<joined-id>',col,record.table);
      if(!cols.length)bindings.push({property:'<joined-id>',status:'unknown',reason:'Composite primary-key join columns must be explicit.',storageTable:record.table,uri:record.uri,range:record.range});
    }
    for(const secondary of secondaryMetadata.get(record)||[]) {
      const cols=joinColumns(inner(secondary.annotation,'pkJoinColumns','PrimaryKeyJoinColumn',secondary.file),primaryIds,'',true);
      for(const col of cols)add(bindings,record,{name:'<secondary-id>',javaType:col.dbType?.javaType,uri:record.uri,range:record.range,id:true},'<secondary-id>',col,secondary.table);
      if(!cols.length)bindings.push({property:'<secondary-id>',status:'unknown',reason:'Secondary-table identity is unresolved.',storageTable:secondary.table,uri:record.uri,range:record.range});
    }
    record.columnMappings=bindings;
    if(bindings.some(binding=>binding.status==='unknown'||binding.column?.dbType?.certainty==='unknown'))note(record,'Some physical attribute/table/type mappings remain unresolved; independently known bindings are retained.');
  }
  for(const record of records){delete record._physicalOverrides;for(const attribute of record.attributes)delete attribute._jpa;}
}

module.exports={enrichMappings,nested};
