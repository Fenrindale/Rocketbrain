'use strict';

const { literal,rangeAt }=require('../spring/java');
const CONFIG='io.smallrye.config.';
const KEY=/^[A-Za-z][A-Za-z0-9._-]{0,159}$/u;
const PROFILE=/^[A-Za-z][A-Za-z0-9-]{0,45}$/u;
const PRIMITIVES=new Set(['boolean','byte','short','int','long','float','double','char']);
const BOXED=new Set(['String','Boolean','Byte','Short','Integer','Long','Float','Double','Character']);
const SCALARS=new Set([...Array.from(BOXED,name=>'java.lang.'+name),'java.time.Duration']);
const QUALIFIED=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const MAX_VISITS=2048, MAX_LEAVES=512, MAX_ISSUES=64, MAX_DEPTH=12;

function profileFile(name) {
  if (name==='application.properties') return '';
  const match=/^application-(.+)\.properties$/u.exec(name);
  return match&&PROFILE.test(match[1]) ? match[1] : null;
}

function configAnnotation(annotations, name) {
  return annotations.find(annotation=>annotation.name===CONFIG+name);
}

function typeIndex(files) {
  const types=new Map();
  function add(file,type) {
    const candidates=types.get(type.fqn)||[];
    candidates.push({file,type});
    types.set(type.fqn,candidates);
    for(const child of type.nested||[])add(file,child);
  }
  for(const file of files)for(const type of file.types)add(file,type);
  return types;
}

function scopedType(raw, entry, types) {
  if (!QUALIFIED.test(raw)) return;
  const {file,type}=entry;
  const [first,...tail]=raw.split('.');
  for(let owner=type.fqn;owner && owner!==file.packageName;){
    const candidate=owner+'.'+raw;
    if(types.has(candidate))return candidate;
    const dot=owner.lastIndexOf('.');
    owner=dot<0?'':owner.slice(0,dot);
  }
  if (file.imports[first]) return [file.imports[first],...tail].join('.');
  const local=file.packageName?file.packageName+'.'+raw:raw;
  if (types.has(local)) return local;
  if (types.has(raw)||SCALARS.has(raw)||raw==='java.util.Optional')return raw;
  if (raw.includes('.'))return;
  const wildcards=file.wildcards.map(pkg=>pkg+'.'+raw).filter(candidate=>
    types.has(candidate)||SCALARS.has(candidate)||candidate==='java.util.Optional');
  if (BOXED.has(raw))wildcards.push('java.lang.'+raw);
  const candidates=[...new Set(wildcards)];
  return candidates.length===1?candidates[0]:undefined;
}

function scalar(ref, entry, types, allowOptional=true) {
  if (ref.array) return false;
  if(PRIMITIVES.has(ref.raw))return true;
  if(!ref.arguments.length)return SCALARS.has(scopedType(ref.raw,entry,types));
  const base=ref.raw.slice(0,ref.raw.indexOf('<'));
  return allowOptional&&ref.arguments.length===1&&scopedType(base,entry,types)==='java.util.Optional'&&
    !PRIMITIVES.has(ref.arguments[0].raw)&&scalar(ref.arguments[0],entry,types,false);
}

function memberKey(method,naming) {
  const named=configAnnotation(method.annotations,'WithName');
  const parent=configAnnotation(method.annotations,'WithParentName');
  if(named&&parent)return;
  if(parent)return '';
  if(named){const value=literal(named,'value');return typeof value==='string'&&KEY.test(value)?value:undefined;}
  if(!/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/u.test(method.name))return;
  if(naming==='VERBATIM')return method.name;
  return method.name.replace(/([a-z0-9])([A-Z])/g,naming==='SNAKE_CASE'?'$1_$2':'$1-$2').toLowerCase();
}

function namingStrategy(mapping,file) {
  const tokens=mapping.attributes.namingStrategy;
  if (!tokens)return 'KEBAB_CASE';
  const value=tokens.map(token=>token.text).join('');
  const full='io.smallrye.config.ConfigMapping.NamingStrategy.';
  const direct='ConfigMapping.NamingStrategy.';
  const imported='NamingStrategy.';
  const name=value.startsWith(full)?value.slice(full.length):
    file.imports.ConfigMapping===CONFIG+'ConfigMapping'&&value.startsWith(direct)?value.slice(direct.length):
    file.imports.NamingStrategy===full.slice(0,-1)&&value.startsWith(imported)?value.slice(imported.length):null;
  return ['KEBAB_CASE','SNAKE_CASE','VERBATIM'].includes(name)?name:null;
}

function analyzeConfigMappings(files) {
  const types=typeIndex(files), configuration=[], issues=[];
  let visits=0, limited=false;
  const location=(entry,member)=>({uri:entry.file.uri,range:rangeAt(entry.file.text,member.start,member.end)});
  function issue(entry,member,message){
    if(issues.length<MAX_ISSUES)issues.push({message,source:location(entry,member)});
  }
  function visit(entry,{prefix,naming,root,groups,seen}){
    const {type}=entry;
    if(seen.has(type.fqn)||groups.length>MAX_DEPTH){
      issue(entry,type,'ConfigMapping group is cyclic or exceeds its nesting limit.');return;
    }
    if(type.kind!=='interface'||type.generic||type.superTypes.length){
      issue(entry,type,'ConfigMapping needs a resolved local, non-generic group interface without inherited members.');return;
    }
    const next=new Set(seen).add(type.fqn);
    for (const method of type.methods) {
      if(++visits>MAX_VISITS||configuration.length>=MAX_LEAVES){
        if(!limited)issue(entry,method,'ConfigMapping declarations exceed their local analysis limit.');
        limited=true;return;
      }
      if(method.constructor||method.parameters.length||method.modifiers.some(value=>['default','static','private'].includes(value))||
        type.methods.some(item=>item!==method&&item.name===method.name))continue;
      const suffix=memberKey(method,naming);
      if(suffix===undefined||suffix!==''&&!KEY.test(suffix)){
        issue(entry,method,'ConfigMapping member requires an exact supported property name.');continue;
      }
      const key=[prefix,suffix].filter(Boolean).join('.');
      if(key&&!KEY.test(key)){issue(entry,method,'ConfigMapping key exceeds its supported path bound.');continue;}
      if(configAnnotation(method.annotations,'WithConverter')){
        issue(entry,method,'Custom ConfigMapping converters have no source type projection.');continue;
      }
      if(scalar(method.type,entry,types)){
        if(!suffix||!key)continue;
        configuration.push({kind:'configMapping',key,type:method.type.raw,
          hasDefault:Boolean(configAnnotation(method.annotations,'WithDefault')),
          source:location(entry,method),...(groups.length?{groups:[...groups],mappingType:root,declaringType:type.fqn}:{})});
        continue;
      }
      const name=!method.type.arguments.length&&!method.type.array?scopedType(method.type.raw,entry,types):undefined;
      const candidates=name?types.get(name):undefined;
      if(candidates?.length!==1||candidates[0].type.kind!=='interface'){
        issue(entry,method,'ConfigMapping member has no uniquely resolved local group or supported scalar type.');continue;
      }
      visit(candidates[0],{prefix:key,naming,root,groups:[...groups,method.name],seen:next});
    }
  }
  for(const entries of types.values())for(const entry of entries){
    if(limited)return {configuration,issues};
    const {file,type}=entry;
    const mapping=configAnnotation(type.annotations,'ConfigMapping');
    if(!mapping||type.kind!=='interface')continue;
    const prefix=literal(mapping,'prefix',''), naming=namingStrategy(mapping,file);
    if(entries.length!==1||typeof prefix!=='string'||prefix&&!KEY.test(prefix)||!naming||
      literal(mapping,'beanStyleGetters',false)!==false){
      issue(entry,type,'ConfigMapping needs a unique declaration and supported literal naming options.');continue;
    }
    visit(entry,{prefix,naming,root:type.fqn,groups:[],seen:new Set()});
  }
  return {configuration,issues};
}

module.exports={analyzeConfigMappings,profileFile,KEY,PROFILE};
