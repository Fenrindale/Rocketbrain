'use strict';
const { lexJava, rangeAt } = require('../spring/java');
const {nested:parseNested}=require('./mapping');

const NS = new Set(['https://jakarta.ee/xml/ns/persistence/orm', 'http://xmlns.jcp.org/xml/ns/persistence/orm', 'http://java.sun.com/xml/ns/persistence/orm']);
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const mapperDoctype = /^<!DOCTYPE\s+mapper\s+PUBLIC\s+(["'])-\/\/mybatis\.org\/\/DTD Mapper 3\.0\/\/EN\1\s+(["'])https?:\/\/mybatis\.org\/dtd\/mybatis-3-mapper\.dtd\2\s*>/;
const namePattern = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const persistenceNames=new Set('Entity Embeddable MappedSuperclass Table Column Id EmbeddedId Embedded Basic Transient Version GeneratedValue Access Inheritance DiscriminatorColumn DiscriminatorValue ManyToOne OneToOne OneToMany ManyToMany JoinColumn JoinColumns JoinTable CollectionTable ElementCollection AttributeOverride AttributeOverrides AssociationOverride AssociationOverrides Convert Converts Converter IdClass SecondaryTable SecondaryTables PrimaryKeyJoinColumn PrimaryKeyJoinColumns Enumerated Temporal Lob NamedQuery NamedQueries NamedNativeQuery NamedNativeQueries OrderBy OrderColumn MapKey MapKeyColumn MapKeyJoinColumn MapKeyJoinColumns MapsId'.split(' '));
const jpa = (annotation,file) => /^(?:jakarta|javax)\.persistence\./.test(annotation.name || '') || persistenceNames.has(annotation.shortName)&&!file?.imports?.[annotation.shortName]&&file?.wildcards?.some(namespace=>['jakarta.persistence','javax.persistence'].includes(namespace))&&annotation.name===(file.packageName?file.packageName+'.':'')+annotation.shortName;

function decoded(raw, offset = 0) {
  let text = ''; const map = [], ends = [];
  for (let i = 0; i < raw.length;) {
    const start = i; let value = raw[i++];
    if (value === '&') {
      const end = raw.indexOf(';', i); if (end < 0) throw new Error('Unterminated XML entity.');
      const entity = raw.slice(i, end), builtins = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
      if (Object.hasOwn(builtins, entity)) value = builtins[entity];
      else if (/^#(?:x[\da-fA-F]+|\d+)$/.test(entity)) {
        const point = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (!(point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) throw new Error('Invalid XML character reference.');
        value = String.fromCodePoint(point);
      } else throw new Error('External/custom XML entities are not supported.');
      i = end + 1;
    }
    for (const unit of value.split('')) { text += unit; map.push(offset + start); ends.push(offset + i); }
  }
  return { text, map, ends };
}

/** Bounded local XML reader. The known mapper declaration is inert. */
function parseXml(file, { mapper = false } = {}) {
  const text = file.text; if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('ORM XML exceeds the one MiB file limit.');
  for(const char of text){const point=char.codePointAt(0);if(!(point===9||point===10||point===13||point>=32&&point<=0xd7ff||point>=0xe000&&point<=0xfffd||point>=0x10000&&point<=0x10ffff))throw new Error('Invalid literal XML character.');}
  const roots = [], stack = []; let cursor = 0, nodes = 0, sawDoctype = false;
  while (cursor < text.length) {
    if (text[cursor] !== '<') {
      let end = text.indexOf('<', cursor); if (end < 0) end = text.length;
      if(text.slice(cursor,end).includes(']]>'))throw new Error('CDATA closing delimiter outside CDATA.');
      const value = decoded(text.slice(cursor, end), cursor);
      if (mapper) Object.assign(value, { kind: 'text', start: cursor, end });
      if (stack.length) stack.at(-1).parts.push(value); else if (value.text.replace(/^\uFEFF/, '').trim()) throw new Error('Text outside the XML root.');
      cursor = end; continue;
    }
    if (text.startsWith('<!--', cursor)) { const end = text.indexOf('-->', cursor + 4); if (end < 0 || text.slice(cursor + 4, end).includes('--')) throw new Error('Malformed XML comment.'); cursor = end + 3; continue; }
    if (text.startsWith('<![CDATA[', cursor)) { const end = text.indexOf(']]>', cursor + 9); if (end < 0 || !stack.length) throw new Error('Malformed XML CDATA.'); const value = text.slice(cursor + 9, end); const part = { text: value, map: Array.from({length:value.length},(_,i)=>cursor+9+i), ends: Array.from({ length: value.length }, (_, i) => cursor + 10 + i) }; if (mapper) Object.assign(part, { kind: 'cdata', start: cursor + 9, end }); stack.at(-1).parts.push(part); cursor = end + 3; continue; }
    if (text.startsWith('<?', cursor)) { const end = text.indexOf('?>', cursor + 2); if (end < 0 || !/^<\?xml\s/.test(text.slice(cursor)) || roots.length || stack.length || text.slice(0, cursor).replace(/^\uFEFF/, '').trim()) throw new Error('XML processing instructions are not supported.'); cursor = end + 2; continue; }
    if (text.startsWith('<!', cursor)) {
      const declaration = mapper && !sawDoctype && !roots.length && !stack.length && mapperDoctype.exec(text.slice(cursor));
      if (!declaration) throw new Error('This XML declaration is unsupported; no external content is loaded.');
      sawDoctype = true;
      cursor += declaration[0].length;
      continue;
    }
    const start = cursor; let end = cursor + 1, quote;
    for (; end < text.length; end++) { const c = text[end]; if (quote) { if (c === quote) quote = undefined; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (end === text.length) throw new Error('Unterminated XML tag.');
    let body = text.slice(cursor + 1, end), closing = body.startsWith('/'), selfClosing = /\/\s*$/.test(body);
    if (closing) {
      const name = body.slice(1).trim(); if (!namePattern.test(name) || !stack.length || stack.at(-1).qualifiedName !== name) throw new Error('Unbalanced XML closing tag.');
      const node = stack.pop(); node.end = end + 1; cursor = end + 1; continue;
    }
    if (selfClosing) body = body.replace(/\/\s*$/, '');
    const match = /^([^\s]+)([\s\S]*)$/.exec(body); if (!match || !namePattern.test(match[1])) throw new Error('Invalid XML element name.');
    const attrs = {}, rawAttrs = []; let rest = match[2], consumed = 1 + match[1].length;
    while (rest.trim()) {
      const attr = /^(\s+)([^\s=]+)\s*=\s*(["'])([\s\S]*?)\3/.exec(rest);
      if (!attr || !namePattern.test(attr[2]) || Object.hasOwn(attrs, attr[2]) || attr[4].includes('<')) throw new Error('Invalid or duplicate XML attribute.');
      const valueStart = start + consumed + attr[0].indexOf(attr[3]) + 1;
      attrs[attr[2]] = decoded(attr[4].replace(/\r\n?/g,'\n').replace(/[\t\n]/g,' '), valueStart).text; rawAttrs.push(attr[2]);
      consumed += attr[0].length; rest = rest.slice(attr[0].length);
    }
    const namespaces = { ...(stack.at(-1)?.namespaces || {}) };
    for (const [key, value] of Object.entries(attrs)) if (key === 'xmlns') namespaces[''] = value; else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    const [prefix, local] = match[1].includes(':') ? match[1].split(':') : ['', match[1]];
    const namespace = namespaces[prefix];
    if (mapper ? Boolean(prefix || namespace) : !namespace || !NS.has(namespace)) throw new Error(mapper ? 'Use an unqualified MyBatis mapper.' : 'ORM elements must use a supported persistence XML namespace.');
    for (const key of rawAttrs) if (key.includes(':') && !key.startsWith('xmlns:')) { const ns = namespaces[key.split(':')[0]]; if (!ns || ns !== XSI && ns !== XMLNS) throw new Error('Foreign XML attribute namespaces are unsupported.'); }
    const node = { name: local, qualifiedName: match[1], namespace, attrs, namespaces, children: [], parts: [], start, end: end + 1 };
    if (++nodes > 20000 || stack.length >= 48) throw new Error('ORM XML nesting or element limit exceeded.');
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!selfClosing) stack.push(node); cursor = end + 1;
  }
  if (stack.length || roots.length !== 1) throw new Error('ORM XML must have exactly one balanced root element.');
  const root = roots[0];
  if (mapper ? root.name !== 'mapper' || !root.attrs.namespace : root.name !== 'entity-mappings' || !/^(?:2\.[0-2]|3\.[0-2])$/.test(root.attrs.version || '')) throw new Error(mapper ? 'Open a MyBatis XML mapper with a namespace.' : 'Unsupported ORM XML root/version.');
  return root;
}

const child = (node, name) => node.children.find(item => item.name === name);
const children = (node, name) => node.children.filter(item => item.name === name);
const content = node => node ? node.parts.map(part => part.text).join('') : '';
const fullClass = (name, pkg) => name?.includes('.') ? name : pkg ? pkg + '.' + name : name;
const java = value => ({ java: value });
function render(value) { if (value?.java !== undefined) return value.java; if (Array.isArray(value)) return '{' + value.map(render).join(',') + '}'; return typeof value === 'string' ? JSON.stringify(value) : String(value); }
function annotation(name, values, node, file) {
  const attributes = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined) attributes[key] = lexJava(render(value)).tokens;
  return { name: 'jakarta.persistence.' + name, shortName: name, attributes, start: node.start, end: node.end, _xmlSource: { uri: file.uri, range: rangeAt(file.text, node.start, node.end) } };
}
function nested(item) { return java('@' + item.name + '(' + Object.entries(item.attributes).map(([key, tokens]) => key + '=' + tokens.map(t => t.text).join('')).join(',') + ')'); }

function applyOrmMappings(files, mappingFiles = [], options = {}) {
  const issues = [], documents = [], queries = [], entries = [], converters = [], fileDefaults=new Map(); let globallyPartial = options.mappingFilesComplete === false;
  const report = (file, node, message, type) => { const issue = { uri: file.uri, range: rangeAt(file.text || '', node?.start || 0, node?.end || 0), code: 'jpa.xml.unknown', message }; issues.push(issue); if (type) { type.jpaXmlPartial = true; (type.jpaXmlIssues ||= []).push(message); } };
  const inScope = type => !options.basePackages?.length || options.basePackages.some(base => type.fqn === base || type.fqn.startsWith(base + '.'));
  const allTypes = files.flatMap(file => file.types.map(type => ({ file, type }))).filter(item => inScope(item.type));
  function validate(node, attrs, tags, file, type) {
    for (const key of Object.keys(node.attrs)) if (key !== 'xmlns' && !key.startsWith('xmlns:') && !key.includes(':') && !attrs.includes(key)) report(file, node, 'Unsupported ORM XML attribute ' + node.name + '@' + key + '.', type);
    for (const item of node.children) if (!tags.includes(item.name)) report(file, item, 'Unsupported ORM XML element ' + node.name + '/' + item.name + '.', type);
    const repeatable=new Set(['entity','mapped-superclass','embeddable','converter','named-query','named-native-query','secondary-table','primary-key-join-column','attribute-override','association-override','join-column','inverse-join-column','id','basic','version','embedded','transient','many-to-one','one-to-one','one-to-many','many-to-many','element-collection']);
    for(const name of new Set(node.children.map(item=>item.name)))if(!repeatable.has(name)&&children(node,name).length>1)report(file,node,'Duplicate singleton ORM XML element '+name+'.',type);
    if (content(node).trim() && !['package', 'access', 'schema', 'catalog', 'query', 'enumerated', 'temporal', 'discriminator-value'].includes(node.name)) report(file, node, 'Unexpected ORM XML element text in ' + node.name + '.', type);
  }
  function values(node, spec, file, type) {
    validate(node, Object.keys(spec), [], file, type); const result = {};
    for (const [key, descriptor] of Object.entries(spec)) if (Object.hasOwn(node.attrs, key)) {
      let value = node.attrs[key]; const [target, kind, enumType] = descriptor;
      if (kind === 'bool') { if (!['true','false'].includes(value)) { report(file,node,'Non-boolean ORM mapping value.',type); continue; } value = value === 'true'; }
      else if (kind === 'number') { if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) { report(file,node,'Invalid numeric ORM mapping value.',type); continue; } value = Number(value); }
      else if (kind === 'enum') { if (!/^[A-Z_]+$/.test(value)) { report(file,node,'Invalid ORM enum value.',type); continue; } value = java('jakarta.persistence.' + enumType + '.' + value); }
      result[target] = value;
    }
    return result;
  }
  const columnSpec = { name:['name'], nullable:['nullable','bool'], unique:['unique','bool'], insertable:['insertable','bool'], updatable:['updatable','bool'], 'column-definition':['columnDefinition'], table:['table'], length:['length','number'], precision:['precision','number'], scale:['scale','number'] };
  const joinSpec = { ...columnSpec, 'referenced-column-name':['referencedColumnName'] }; delete joinSpec.length; delete joinSpec.precision; delete joinSpec.scale;
  function column(node, file, type, join = false) { return annotation(join ? 'JoinColumn' : 'Column', values(node, join ? joinSpec : columnSpec, file, type), node, file); }
  function table(node, file, type, kind = 'Table') {
    validate(node, ['name','schema','catalog'], kind === 'SecondaryTable' ? ['primary-key-join-column'] : ['join-column','inverse-join-column'], file, type);
    const defaults=fileDefaults.get(file.uri)||{};
    const args = { name:node.attrs.name, schema:node.attrs.schema??defaults.schema, catalog:node.attrs.catalog??defaults.catalog };
    if (kind === 'SecondaryTable') args.pkJoinColumns = children(node,'primary-key-join-column').map(item => nested(annotation('PrimaryKeyJoinColumn', values(item, { name:['name'], 'referenced-column-name':['referencedColumnName'], 'column-definition':['columnDefinition'] },file,type),item,file)));
    else if (kind === 'JoinTable' || kind === 'CollectionTable') { args.joinColumns = children(node,'join-column').map(item=>nested(column(item,file,type,true))); if (kind === 'JoinTable') args.inverseJoinColumns = children(node,'inverse-join-column').map(item=>nested(column(item,file,type,true))); }
    return annotation(kind,args,node,file);
  }
  function overrides(node,file,type) {
    const result = [];
    for (const item of children(node,'attribute-override')) {
      validate(item,['name'],['column'],file,type); const col = child(item,'column');
      if (!item.attrs.name || !col || children(item,'column').length !== 1) { report(file,item,'Attribute override requires a name and one column.',type); continue; }
      result.push(annotation('AttributeOverride',{name:item.attrs.name,column:nested(column(col,file,type))},item,file));
    }
    for (const item of children(node,'association-override')) {
      validate(item,['name'],['join-column','join-table'],file,type); const joins=children(item,'join-column'), joinTable=child(item,'join-table');
      if (!item.attrs.name || !joins.length && !joinTable || joins.length && joinTable) { report(file,item,'Association override requires one join mapping.',type); continue; }
      result.push(annotation('AssociationOverride',{name:item.attrs.name,joinColumns:joins.length?joins.map(j=>nested(column(j,file,type,true))):undefined,joinTable:joinTable?nested(table(joinTable,file,type,'JoinTable')):undefined},item,file));
    }
    return result;
  }
  function grouped(items, one, many, node, file) { const values=items.filter(item=>item.shortName===one); return values.length>1 ? [annotation(many,{value:values.map(nested)},node,file)] : values; }
  function mergeOverrides(owner,incoming,node,file,javaFile){
    for(const [one,many]of [['AttributeOverride','AttributeOverrides'],['AssociationOverride','AssociationOverrides']]){
      const added=incoming.filter(a=>a.shortName===one);if(!added.length)continue;
      const names=new Set(added.map(a=>a.attributes.name?.[0]?.value));
      const previous=owner.annotations.filter(a=>jpa(a,javaFile)&&a.shortName===one);
      for(const a of owner.annotations.filter(a=>jpa(a,javaFile)&&a.shortName===many))previous.push(...parseNested(a.attributes.value,javaFile).filter(a=>jpa(a,javaFile)&&a.shortName===one));
      const retained=previous.filter(a=>!names.has(a.attributes.name?.[0]?.value));
      owner.annotations=owner.annotations.filter(a=>!jpa(a,javaFile)||![one,many].includes(a.shortName));
      const combined=[...retained,...added];owner.annotations.push(...grouped(combined,one,many,node,file));
    }
  }
  for (const file of mappingFiles.slice(0,40)) {
    try {
      const root = parseXml(file), pkg = content(child(root,'package')).trim();
      const metadata=child(root,'persistence-unit-metadata'), defaults=metadata&&child(metadata,'persistence-unit-defaults');
      const complete=Boolean(metadata&&child(metadata,'xml-mapping-metadata-complete'));
      if (complete) for (const {type,file:javaFile} of allTypes) { type.annotations=type.annotations.filter(a=>!jpa(a,javaFile)); for (const member of [...type.fields,...type.methods]) member.annotations=member.annotations.filter(a=>!jpa(a,javaFile)); }
      const document={uri:file.uri,version:root.attrs.version,packageName:pkg,metadataComplete:complete,managedTypes:[]}; documents.push(document);
      const before=issues.length; validate(root,['version'],['package','schema','catalog','access','entity','mapped-superclass','embeddable','converter','persistence-unit-metadata','named-query','named-native-query'],file);
      if (metadata) { validate(metadata,[],['xml-mapping-metadata-complete','persistence-unit-defaults'],file); if(defaults)validate(defaults,[],['schema','catalog','access','cascade-persist','entity-listeners'],file); }
      if(defaults&&defaults.children.some(n=>['schema','catalog','access'].includes(n.name))){report(file,defaults,'Persistence-unit defaults need an explicit persistence-unit binding; annotation physical defaults remain uncertain.');globallyPartial=true;}
      if (issues.length!==before) globallyPartial=true;
      const common={access:content(child(root,'access')||defaults&&child(defaults,'access')).trim(),schema:content(child(root,'schema')||defaults&&child(defaults,'schema')).trim(),catalog:content(child(root,'catalog')||defaults&&child(defaults,'catalog')).trim()};
      fileDefaults.set(file.uri,common);
      for (const node of root.children.filter(n=>['entity','mapped-superclass','embeddable'].includes(n.name))) { const fqn=fullClass(node.attrs.class,pkg); entries.push({file,node,pkg,common,complete,fqn,document}); document.managedTypes.push(fqn); }
      for (const node of children(root,'converter')) converters.push({file,node,pkg});
      const namedNodes=[...root.children,...root.children.flatMap(n=>['entity','mapped-superclass','embeddable'].includes(n.name)?n.children:[])].filter(n=>['named-query','named-native-query'].includes(n.name));
      for (const named of namedNodes) {
        const q=child(named,'query'); if(!q){report(file,named,'Named query has no query text.');continue;}
        const queryIssues=issues.length;validate(named,['name','lock-mode'],['query','hint'],file);validate(q,[],[],file);
        const text=q.parts.map(p=>p.text).join(''), map=q.parts.flatMap(p=>p.map), ends=q.parts.flatMap(p=>p.ends);
        queries.push({uri:file.uri,text,range:rangeAt(file.text,q.start,q.end),_map:map,_ends:ends,_literalStart:map[0]??q.start,_literalEnd:ends.at(-1)??q.end,source:named.name==='named-native-query'?'native-sql':'xml-named-query',name:named.attrs.name,forcedReason:named.name==='named-native-query'?'Native XML query is not JPQL.':issues.length!==queryIssues?'XML named-query structure is unsupported.':undefined});
      }
    } catch (error) { report(file,null,error.message); globallyPartial=true; }
  }
  if(mappingFiles.length>40){issues.push({code:'jpa.xml.unknown',message:'ORM mapping file index capped at 40 documents.'});globallyPartial=true;}
  for (const entry of entries) {
    const {file,node,pkg,common,fqn}=entry, matches=allTypes.filter(item=>item.type.fqn===fqn);
    if(matches.length!==1){report(file,node,'XML managed class source is absent or ambiguous: '+fqn);continue;}
    const {type,file:javaFile}=matches[0];
    if(entries.filter(e=>e.fqn===fqn).length!==1){report(file,node,'Overlapping XML mappings for '+fqn+' are undefined; no winner is selected.',type);continue;}
    validate(node,['class','name','access','metadata-complete','cacheable'],['table','secondary-table','attributes','inheritance','id-class','primary-key-join-column','attribute-override','association-override','named-query','named-native-query','discriminator-column','discriminator-value'],file,type);
    if(node.attrs['metadata-complete']&&!['true','false'].includes(node.attrs['metadata-complete']))report(file,node,'Invalid metadata-complete value.',type);
    if(node.attrs['metadata-complete']==='true'){type.annotations=type.annotations.filter(a=>!jpa(a,javaFile));for(const member of [...type.fields,...type.methods])member.annotations=member.annotations.filter(a=>!jpa(a,javaFile));}
    const oldAccess=type.annotations.find(a=>jpa(a,javaFile)&&a.shortName==='Access')?.attributes.value?.at(-1)?.text;
    const hasMappedMember=[...type.fields,...type.methods].some(m=>m.annotations.some(a=>jpa(a,javaFile)));
    const access=node.attrs.access||oldAccess||(!hasMappedMember?common.access:'');
    const put=(owner,item)=>{owner.annotations=owner.annotations.filter(a=>!(jpa(a,javaFile)&&a.shortName===item.shortName));owner.annotations.push(item);};
    put(type,annotation(node.name==='entity'?'Entity':node.name==='embeddable'?'Embeddable':'MappedSuperclass',{name:node.attrs.name},node,file));
    if(access){if(!['FIELD','PROPERTY'].includes(access))report(file,node,'Invalid XML access type.',type);else put(type,annotation('Access',{value:java('jakarta.persistence.AccessType.'+access)},node,file));}
    const primary=child(node,'table');
    if(primary)put(type,table(primary,file,type));
    else if(node.name==='entity'&&(common.schema||common.catalog)){
      const old=type.annotations.find(a=>jpa(a,javaFile)&&a.shortName==='Table');
      const fallback=annotation('Table',{schema:common.schema||undefined,catalog:common.catalog||undefined},node,file);
      put(type,{...fallback,attributes:{...fallback.attributes,...(old?.attributes||{})}});
    }
    const secondaries=children(node,'secondary-table').map(n=>table(n,file,type,'SecondaryTable'));
    if(secondaries.length){type.annotations=type.annotations.filter(a=>!jpa(a,javaFile)||!['SecondaryTable','SecondaryTables'].includes(a.shortName));for(const a of secondaries.length===1?secondaries:[annotation('SecondaryTables',{value:secondaries.map(nested)},node,file)])put(type,a);}
    const inherit=child(node,'inheritance');if(inherit)put(type,annotation('Inheritance',values(inherit,{strategy:['strategy','enum','InheritanceType']},file,type),inherit,file));
    const idclass=child(node,'id-class');if(idclass){validate(idclass,['class'],[],file,type);if(idclass.attrs.class)put(type,annotation('IdClass',{value:java(fullClass(idclass.attrs.class,pkg)+'.class')},idclass,file));else report(file,idclass,'Missing XML id class.',type);}
    const pkjoins=children(node,'primary-key-join-column').map(n=>annotation('PrimaryKeyJoinColumn',values(n,{name:['name'],'referenced-column-name':['referencedColumnName'],'column-definition':['columnDefinition']},file,type),n,file));
    for(const item of pkjoins.length>1?[annotation('PrimaryKeyJoinColumns',{value:pkjoins.map(nested)},node,file)]:pkjoins)put(type,item);
    const override=overrides(node,file,type);mergeOverrides(type,override,node,file,javaFile);
    const attrs=child(node,'attributes');if(attrs) {
      validate(attrs,[],['id','embedded-id','basic','version','embedded','transient','many-to-one','one-to-one','one-to-many','many-to-many','element-collection'],file,type);
      const seen=new Set();
      for(const attribute of attrs.children){
        const name=attribute.attrs.name;
        if(!name||seen.has(name)){report(file,attribute,'Missing/duplicate XML persistent attribute.',type);continue;}seen.add(name);
        const selectedAccess=attribute.attrs.access||access||(type.annotations.find(a=>jpa(a,javaFile)&&a.shortName==='Access')?.attributes.value?.at(-1)?.text)|| (type.methods.some(m=>m.annotations.some(a=>jpa(a,javaFile)&&['Id','EmbeddedId'].includes(a.shortName)))?'PROPERTY':'FIELD');
        const candidates=selectedAccess==='PROPERTY'?type.methods.filter(m=>!m.parameters.length&&[String('get'+name[0].toUpperCase()+name.slice(1)),String('is'+name[0].toUpperCase()+name.slice(1))].includes(m.name)):type.fields.filter(m=>m.name===name);
        if(candidates.length!==1){report(file,attribute,'XML attribute source/access is absent or ambiguous: '+name,type);continue;}
        const member=candidates[0], kind={'id':'Id','embedded-id':'EmbeddedId','basic':'Basic','version':'Version','embedded':'Embedded','transient':'Transient','many-to-one':'ManyToOne','one-to-one':'OneToOne','one-to-many':'OneToMany','many-to-many':'ManyToMany','element-collection':'ElementCollection'}[attribute.name];
        if(!kind)continue;
        validate(attribute,['name','access','target-entity','target-class','fetch','optional','mapped-by','orphan-removal'],['column','join-column','join-table','collection-table','attribute-override','association-override','convert','enumerated','temporal','lob','cascade','generated-value'],file,type);
        const args={};for(const [key,value]of Object.entries(attribute.attrs)){
          if(key==='fetch')args.fetch=java('jakarta.persistence.FetchType.'+value);
          else if(['optional','orphan-removal'].includes(key)){if(!['true','false'].includes(value))report(file,attribute,'Invalid boolean relation option.',type);else args[key==='optional'?'optional':'orphanRemoval']=value==='true';}
          else if(key==='mapped-by')args.mappedBy=value;
          else if(key==='target-entity'||key==='target-class')args[key==='target-entity'?'targetEntity':'targetClass']=java(fullClass(value,pkg)+'.class');
        }
        const cascade=child(attribute,'cascade');if(cascade){validate(cascade,[],['cascade-all','cascade-persist','cascade-merge','cascade-remove','cascade-refresh','cascade-detach'],file,type);args.cascade=cascade.children.map(c=>java('jakarta.persistence.CascadeType.'+c.name.slice(8).toUpperCase()));}
        member.annotations=member.annotations.filter(a=>!jpa(a,javaFile));put(member,annotation(kind,args,attribute,file));
        if(attribute.attrs.access)put(member,annotation('Access',{value:java('jakarta.persistence.AccessType.'+attribute.attrs.access)},attribute,file));
        const col=child(attribute,'column');if(col)put(member,column(col,file,type));
        const joins=children(attribute,'join-column').map(c=>column(c,file,type,true));for(const a of joins.length>1?[annotation('JoinColumns',{value:joins.map(nested)},attribute,file)]:joins)put(member,a);
        const joinTable=child(attribute,'join-table'),collectionTable=child(attribute,'collection-table');if(joinTable)put(member,table(joinTable,file,type,'JoinTable'));if(collectionTable)put(member,table(collectionTable,file,type,'CollectionTable'));
        const overs=overrides(attribute,file,type);mergeOverrides(member,overs,attribute,file,javaFile);
        const convert=child(attribute,'convert');if(convert){validate(convert,['converter','attribute-name','disable-conversion'],[],file,type);put(member,annotation('Convert',{converter:convert.attrs.converter?java(fullClass(convert.attrs.converter,pkg)+'.class'):undefined,attributeName:convert.attrs['attribute-name'],disableConversion:convert.attrs['disable-conversion']===undefined?undefined:convert.attrs['disable-conversion']==='true'},convert,file));}
        for(const [tag,annotationName,enumName]of [['enumerated','Enumerated','EnumType'],['temporal','Temporal','TemporalType']]){const e=child(attribute,tag);if(e){validate(e,[],[],file,type);const value=content(e).trim();if(!/^[A-Z_]+$/.test(value))report(file,e,'Invalid XML enum value.',type);else put(member,annotation(annotationName,{value:java('jakarta.persistence.'+enumName+'.'+value)},e,file));}}
        if(child(attribute,'lob'))put(member,annotation('Lob',{},child(attribute,'lob'),file));
        const generated=child(attribute,'generated-value');if(generated)put(member,annotation('GeneratedValue',values(generated,{strategy:['strategy','enum','GenerationType'],generator:['generator']},file,type),generated,file));
      }
    }
  }
  for(const {file,node,pkg}of converters){const fqn=fullClass(node.attrs.class,pkg),found=allTypes.filter(t=>t.type.fqn===fqn);if(found.length!==1){report(file,node,'XML converter source is absent or ambiguous: '+fqn);continue;}const {type,file:javaFile}=found[0];validate(node,['class','auto-apply'],[],file,type);const auto=node.attrs['auto-apply'];if(auto!==undefined&&!['true','false'].includes(auto))report(file,node,'Invalid XML converter auto-apply value.',type);type.annotations=type.annotations.filter(a=>!jpa(a,javaFile)||a.shortName!=='Converter');type.annotations.push(annotation('Converter',{autoApply:auto==='true'},node,file));}
  if(globallyPartial)for(const {type}of allTypes){type.jpaXmlPartial=true;(type.jpaXmlIssues||=[]).push('Mapping XML coverage is incomplete or unsupported; physical annotation defaults are not asserted.');}
  return {issues,documents,queries};
}

module.exports = { parseXml, applyOrmMappings };
