'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { parseJavaTokens, lexJava, matching, splitTop } = require('./java');

const ownerType = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const localType = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const memberType = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\[\])?$/u;
const label = /^[A-Za-z0-9_.$:@ -]{1,180}$/u;
const contextKey = /^context-[1-9][0-9]{0,15}$/u;
const primitive = new Set(['boolean','byte','short','int','long','char','float','double']);
const aggregates=new Set(['java.util.List','java.util.Set','java.util.Collection','java.util.Map']);
const optionalType='java.util.Optional';

function bounded(value, expression, length=256) {
  return typeof value === 'string' && value.length <= length && value.trim().length && expression.test(value);
}

function normalizeObservedInjection(raw, members=false) {
  if (!raw || !['observed','awaiting-hooks','disabled'].includes(raw.state) ||
      !Number.isSafeInteger(raw.processId) || raw.processId < 1 || !Number.isSafeInteger(raw.omitted) || raw.omitted < 0 ||
      raw.inspectionInvokedBeans !== false || raw.beanValuesRetained !== false || raw.observerExecutedSql !== false ||
      !Array.isArray(raw.events) || raw.events.length > 48 || (raw.state !== 'observed' && raw.events.length)) {
    throw Error('Invalid Spring injection resolution data.');
  }
  let previous = 0;
  const events = raw.events.map(value => {
    const { context, site } = value || {};
    if (!Number.isSafeInteger(value?.id) || value.id <= previous ||
        !bounded(context?.key,contextKey) || (context.id !== undefined && !bounded(context.id,label)) ||
        !bounded(site?.owner,ownerType) || !bounded(site.requestingBean,label) ||
        !['resolved','ambiguous','unproved',...(members?['missing','aggregated']:[])].includes(value.state) ||
        (value.state === 'resolved' ? !bounded(value.selectedBean,label) : value.selectedBean !== undefined) ||
        (value.suggestedName !== undefined && (!bounded(value.suggestedName,label)||members&&value.suggestedName!==value.selectedBean))) {
      throw Error('Invalid Spring injection event.');
    }
    let member, selection;
    if(members){
      if(!['field','method'].includes(site.kind)||!bounded(site.member,localType)||
          !bounded(site.requestedType,memberType)||!bounded(site.dependencyType,ownerType)||
          (site.kind==='field'&&(site.parameterTypes!==undefined||site.parameterIndex!==undefined||site.parameterName!==undefined))) {
        throw Error('Invalid Spring member injection site.');
      }
      const aggregate=aggregates.has(site.requestedType)||site.requestedType===site.dependencyType+'[]';
      if((!aggregate&&site.requestedType!==site.dependencyType&&site.requestedType!==optionalType)||
          (value.state==='aggregated'&&!aggregate))throw Error('Invalid Spring dependency type.');
      member={kind:site.kind,member:site.member,requestedType:site.requestedType,dependencyType:site.dependencyType};
      if(value.state==='aggregated'){
        if(!Array.isArray(value.selectedBeans)||!value.selectedBeans.length||value.selectedBeans.length>12||
            value.selectedBeans.some(name=>!bounded(name,label))||new Set(value.selectedBeans).size!==value.selectedBeans.length) {
          throw Error('Invalid Spring aggregate selections.');
        }
        selection={selectedBeans:[...value.selectedBeans]};
      }else if(value.selectedBeans!==undefined)throw Error('Unexpected Spring aggregate selections.');
    }
    let parameter;
    if(!members||site.kind==='method'){
      if(!Array.isArray(site.parameterTypes)||!site.parameterTypes.length||site.parameterTypes.length>24||
          site.parameterTypes.some(name=>!bounded(name,members?memberType:ownerType))||!Number.isInteger(site.parameterIndex)||
          site.parameterIndex<0||site.parameterIndex>=site.parameterTypes.length||
          (site.parameterName!==undefined&&!bounded(site.parameterName,localType))||
          (members&&site.parameterTypes[site.parameterIndex]!==site.requestedType)) {
        throw Error('Invalid Spring injection parameter.');
      }
      parameter={parameterIndex:site.parameterIndex,parameterTypes:[...site.parameterTypes],...(site.parameterName&&{parameterName:site.parameterName})};
    }
    previous = value.id;
    return { id:value.id, state:value.state, context:{key:context.key,...(context.id && {id:context.id})},
      site:{ owner:site.owner, requestingBean:site.requestingBean,...member,...parameter },...selection,
      ...(value.selectedBean && {selectedBean:value.selectedBean}), ...(value.suggestedName && {suggestedName:value.suggestedName}) };
  });
  return { processId:raw.processId, state:raw.state, omitted:raw.omitted, events,
    inspectionInvokedBeans:false,beanValuesRetained:false,observerExecutedSql:false };
}

const normalizeObservedMembers=raw=>normalizeObservedInjection(raw,true);

function sourceMember(file,site){
  if(typeof file?.text!=='string'||Buffer.byteLength(file.text,'utf8')>262144||!site||
      !bounded(site.owner,ownerType)||!bounded(site.member,localType)||!['field','method'].includes(site.kind)||
      !bounded(site.requestedType,memberType)||!bounded(site.dependencyType,ownerType))return;
  const lexical=lexJava(file.text);
  if(lexical.issues.length)return;
  const parsed=parseJavaTokens(file,lexical,{nestedTypes:true});
  if(parsed.issues.some(issue=>/Unbalanced/u.test(issue)))return;
  const types=[...parsed.types];
  for(let index=0;index<types.length;index++)types.push(...(types[index].nested||[]));
  const binary=type=>{
    const length=parsed.packageName?parsed.packageName.length+1:0;
    return type.fqn.slice(0,length)+type.fqn.slice(length).replaceAll('.','$');
  };
  const owners=types.filter(type=>binary(type)===site.owner);
  if(owners.length!==1)return;
  const declaration=owners[0];
  const resolve=name=>{
    if(!bounded(name,ownerType))return;
    if(primitive.has(name))return name;
    const local=types.filter(type=>type.fqn===name||type.name===name||
      (parsed.packageName&&type.fqn===parsed.packageName+'.'+name));
    if(local.length>1)return;
    if(local.length===1)return binary(local[0]);
    if(Object.hasOwn(parsed.imports,name))return parsed.imports[name];
    if(name.includes('.'))return name;
    if(!parsed.wildcards.length)return name==='String'?'java.lang.String':
      parsed.packageName?parsed.packageName+'.'+name:name;
  };
  const typeOf=type=>{
    const base=type.raw.split(/[<\[]/u)[0];
    const raw=resolve(base);
    if(!raw||type.raw.endsWith('[][]'))return;
    if(type.raw===base+'[]')return {requested:raw+'[]',dependency:raw};
    if(type.raw===base)return {requested:raw,dependency:raw};
    if((raw!==optionalType&&!aggregates.has(raw))||type.arguments.length!==(raw==='java.util.Map'?2:1))return {requested:raw};
    if(raw==='java.util.Map'&&resolve(type.arguments[0].raw)!=='java.lang.String')return {requested:raw};
    const dependency=resolve(type.arguments.at(-1).raw);
    return dependency?{requested:raw,dependency}:undefined;
  };
  const injected=member=>member.annotations.some(item=>['org.springframework.beans.factory.annotation.Autowired','jakarta.inject.Inject'].includes(item.name));
  const matchingType=type=>{
    const names=typeOf(type);
    return names?.requested===site.requestedType&&names.dependency===site.dependencyType;
  };
  let targets;
  if(site.kind==='field'){
    targets=declaration.fields.filter(field=>field.name===site.member&&injected(field)&&matchingType(field.type));
  }else{
    if(!Array.isArray(site.parameterTypes)||!Number.isInteger(site.parameterIndex)||
        site.parameterIndex<0||site.parameterIndex>=site.parameterTypes.length)return;
    targets=declaration.methods.filter(method=>{
      if(method.constructor||method.name!==site.member||!injected(method)||method.parameters.length!==site.parameterTypes.length)return false;
      const open=lexical.tokens.findIndex(token=>token.start>=method.end);
      const close=lexical.tokens[open]?.text==='('?matching(lexical.tokens,open):-1;
      if(close<0||splitTop(lexical.tokens.slice(open+1,close)).length!==method.parameters.length)return false;
      return method.parameters.every((parameter,index)=>typeOf(parameter.type)?.requested===site.parameterTypes[index])&&
        matchingType(method.parameters[site.parameterIndex].type);
    }).map(method=>method.parameters[site.parameterIndex]);
    if(site.parameterName)targets=targets.filter(parameter=>parameter.name===site.parameterName);
  }
  if(targets.length!==1)return;
  const {start,end,name}=targets[0];
  return {start,end,name,sameSourceRevisionVerified:false};
}

function sourceParameter(file, site) {
  if (typeof file?.text !== 'string' || Buffer.byteLength(file.text,'utf8')>262144 || !site ||
      !bounded(site.owner,ownerType) || !Array.isArray(site.parameterTypes) ||
      !Number.isInteger(site.parameterIndex) || site.parameterIndex < 0 || site.parameterIndex >= site.parameterTypes.length) return undefined;
  const lexical = lexJava(file.text);
  if (lexical.issues.length) return undefined;
  const parsed = parseJavaTokens(file,lexical);
  if (parsed.issues.some(issue => /Unbalanced/u.test(issue))) return undefined;
  const owners = parsed.types.filter(type => type.kind==='class' && type.fqn===site.owner);
  if (owners.length !== 1) return undefined;

  function resolve(parameter) {
    const raw = parameter.type.raw;
    if (!bounded(raw,ownerType)) return undefined;
    if (raw.includes('.') || primitive.has(raw)) return raw;
    if (Object.hasOwn(parsed.imports,raw)) return parsed.imports[raw];
    if (parsed.types.some(type => type.name===raw) || !parsed.wildcards.length) {
      return parsed.packageName ? parsed.packageName + '.' + raw : raw;
    }
  }

  const constructors = owners[0].methods.filter(method => {
    if (!method.constructor || method.parameters.length !== site.parameterTypes.length) return false;
    const open = lexical.tokens.findIndex(token=>token.start>=method.end);
    const close = lexical.tokens[open]?.text==='(' ? matching(lexical.tokens,open) : -1;
    if (close<0 || splitTop(lexical.tokens.slice(open+1,close)).length!==method.parameters.length) return false;
    return method.parameters.every((parameter,index)=>resolve(parameter)===site.parameterTypes[index]);
  });
  if (constructors.length!==1) return undefined;
  const parameter=constructors[0].parameters[site.parameterIndex];
  if (site.parameterName && site.parameterName!==parameter.name) return undefined;
  return { start:parameter.start,end:parameter.end,name:parameter.name,sameSourceRevisionVerified:false };
}

async function readObservedSource(file) {
  const handle = await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const before = await handle.stat({bigint:true});
    if(!before.isFile() || before.size>262144n) throw Error('Select a bounded local Java source file.');
    const buffer = Buffer.alloc(Number(before.size));
    let count=0;
    while(count<buffer.length) {
      const read=await handle.read(buffer,count,buffer.length-count,count);
      if(!read.bytesRead) break;
      count+=read.bytesRead;
    }
    const current=await fs.lstat(file,{bigint:true}), opened=await handle.stat({bigint:true});
    if(count!==buffer.length || !current.isFile() ||
        ['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==current[key]||before[key]!==opened[key])) {
      throw Error('Java source changed during inspection.');
    }
    return { text:new TextDecoder('utf-8',{fatal:true}).decode(buffer), sha256:createHash('sha256').update(buffer).digest('hex') };
  } finally { await handle.close(); }
}

module.exports={ normalizeObservedInjection, normalizeObservedMembers, sourceParameter, sourceMember, readObservedSource };
