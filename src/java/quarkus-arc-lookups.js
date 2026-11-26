'use strict';

const {parseJavaTokens,lexJava,matching,splitTop}=require('../spring/java');
const javaName=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,9}$/u;
const memberName=/^[A-Za-z_$][A-Za-z0-9_$]{0,95}$/u;
const reference='(?:[ZBSCIJFD]|L[A-Za-z_$][A-Za-z0-9_$/]*;)';
const fieldDescriptor=new RegExp('^(?:\\[{0,8}'+reference+')$','u');
const methodDescriptor=new RegExp('^\\((?:\\[{0,8}'+reference+'){0,12}\\)(?:\\[{0,8}'+reference+')$','u');
const states=new Set(['disabled','waiting','ready','partial']);
const primitive={boolean:'Z',byte:'B',short:'S',char:'C',int:'I',long:'J',float:'F',double:'D'};
const javaLang=new Set(['String','Boolean','Byte','Character','Short','Integer','Long','Float','Double','Number','Object','Class']);
const PRODUCES='jakarta.enterprise.inject.Produces';

const qualified=value=>typeof value==='string'&&value.length<=160&&javaName.test(value);
const id=(value,prefix)=>typeof value==='string'&&new RegExp('^arc-'+prefix+'-[1-9][0-9]{0,15}$','u').test(value);
const list=(values,limit)=>Array.isArray(values)&&values.length<=limit;
const distinct=values=>new Set(values).size===values.length;

function normalizeArcLookups(raw){
  function invalid(){throw Error('Invalid Quarkus Arc lookup evidence.');}
  if(!raw||!states.has(raw.state)||!Number.isSafeInteger(raw.processId)||raw.processId<1||
      !list(raw.packages,4)||!raw.packages.every(qualified)||!distinct(raw.packages)||
      !list(raw.lookups,32)||raw.inspectionResolvedBeans!==false||
      raw.qualifierValuesRetained!==false||raw.beanValuesRetained!==false||
      (raw.state==='disabled'?raw.packages.length!==0:raw.packages.length===0)||
      (['disabled','waiting'].includes(raw.state)&&raw.lookups.length))invalid();
  const allowed=name=>qualified(name)&&raw.packages.some(scope=>name.startsWith(scope+'.'));
  const lookupIds=new Set(),beanScopes=new Map();
  const lookups=raw.lookups.map(event=>{
    if(!event||!id(event.id,'lookup')||lookupIds.has(event.id)||!id(event.scope,'loader')||!allowed(event.requiredType)||
        (event.qualifierTypes===null?raw.state!=='partial':
          !list(event.qualifierTypes,8)||!event.qualifierTypes.every(qualified)||!distinct(event.qualifierTypes))||
        !Number.isInteger(event.eligibleCount)||event.eligibleCount<0||event.eligibleCount>2147483647||
        event.status!==(event.eligibleCount===1?'selected':event.eligibleCount===0?'unsatisfied':'ambiguous')||
        !list(event.candidates,6)||event.candidates.length!==Math.min(6,event.eligibleCount)||
        (event.eligibleCount>6&&raw.state!=='partial'))invalid();
    lookupIds.add(event.id);
    const seen=new Set();
    const candidates=event.candidates.map(candidate=>{
      if(!candidate||!['method','field','opaque','external'].includes(candidate.kind)||
          (candidate.id===null?raw.state!=='partial':!id(candidate.id,'bean')))invalid();
      if(candidate.id){
        const scope=beanScopes.get(candidate.id);
        if((scope&&scope!==event.scope)||seen.has(candidate.id))invalid();
        beanScopes.set(candidate.id,event.scope);
        seen.add(candidate.id);
      }
      const {target}=candidate;
      if(candidate.kind==='opaque'||candidate.kind==='external'){
        if(target!==null)invalid();
        return {id:candidate.id,kind:candidate.kind,target:null};
      }
      if(!target||target.kind!==candidate.kind||!allowed(target.owner)||typeof target.member!=='string'||
          !memberName.test(target.member)||typeof target.descriptor!=='string'||target.descriptor.length>240||
          !(candidate.kind==='method'?methodDescriptor:fieldDescriptor).test(target.descriptor))invalid();
      return {id:candidate.id,kind:candidate.kind,target:{kind:target.kind,owner:target.owner,member:target.member,descriptor:target.descriptor}};
    });
    return {id:event.id,scope:event.scope,requiredType:event.requiredType,qualifierTypes:event.qualifierTypes,
      status:event.status,eligibleCount:event.eligibleCount,candidates};
  });
  return {state:raw.state,processId:raw.processId,packages:[...raw.packages],lookups,inspectionResolvedBeans:false,
    qualifierValuesRetained:false,beanValuesRetained:false};
}

function sourceTypeDescriptor(type,parsed){
  if(type.raw==='void')return 'V';
  const match=/^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)((?:\[\]){0,8})$/u.exec(type.raw);
  if(!match)return;
  const [,name,array]=match, dimensions='['.repeat(array.length/2);
  if(Object.hasOwn(primitive,name))return dimensions+primitive[name];
  const local=parsed.types.filter(type=>type.name===name||type.fqn===name||
    (parsed.packageName&&type.fqn===parsed.packageName+'.'+name));
  if(local.length>1)return;
  let resolved=local[0]?.fqn;
  if(local.length===1&&local[0].owner){
    const packageLength=parsed.packageName?parsed.packageName.length+1:0;
    resolved=resolved.slice(0,packageLength)+resolved.slice(packageLength).replaceAll('.','$');
  }
  if(!resolved&&Object.hasOwn(parsed.imports,name))resolved=parsed.imports[name];
  if(!resolved&&name.includes('.'))resolved=name;
  if(!resolved&&!parsed.wildcards.length)resolved=javaLang.has(name)?'java.lang.'+name:
    parsed.packageName?parsed.packageName+'.'+name:name;
  return resolved?dimensions+'L'+resolved.replaceAll('.','/')+';':undefined;
}

function arcDeclaration(file,target,requiredAnnotation){
  if(typeof file?.text!=='string'||Buffer.byteLength(file.text)>262144||!target||!qualified(target.owner)||
      typeof target.member!=='string'||!memberName.test(target.member)||!['method','field'].includes(target.kind))return;
  const lexical=lexJava(file.text);
  if(lexical.issues.length)return;
  const parsed=parseJavaTokens(file,lexical,{nestedTypes:true});
  if(parsed.issues.some(issue=>/Unbalanced/u.test(issue)))return;
  const types=[...parsed.types];
  for(let index=0;index<types.length;index++)types.push(...types[index].nested);
  const owners=types.filter(type=>{
    const packageLength=parsed.packageName?parsed.packageName.length+1:0;
    const binary=type.fqn.slice(0,packageLength)+type.fqn.slice(packageLength).replaceAll('.','$');
    return binary===target.owner;
  });
  if(owners.length!==1)return;
  const declarations=(target.kind==='method'?owners[0].methods:owners[0].fields).filter(member=>{
    if(member.constructor===true||member.name!==target.member||
        requiredAnnotation&&!member.annotations.some(annotation=>annotation.name===requiredAnnotation))return false;
    const symbols={...parsed,types};
    const type=sourceTypeDescriptor(member.type,symbols);
    if(!type)return false;
    if(target.kind==='field')return type===target.descriptor;
    const open=lexical.tokens.findIndex(token=>token.start>=member.end);
    const close=lexical.tokens[open]?.text==='('?matching(lexical.tokens,open):-1;
    if(close<0 || splitTop(lexical.tokens.slice(open+1,close)).filter(part=>part.length).length!==member.parameters.length)return false;
    const parameters=member.parameters.map(parameter=>sourceTypeDescriptor(parameter.type,symbols));
    return parameters.every(Boolean)&&'('+parameters.join('')+')'+type===target.descriptor;
  });
  if(declarations.length!==1)return;
  const {name,start,end}=declarations[0];
  return {name,start,end,sameSourceRevisionVerified:false};
}

const arcProducerSource=(file,target)=>arcDeclaration(file,target,PRODUCES);
const arcObservedMethodSource=(file,target,annotation)=>arcDeclaration(file,{...target,kind:'method'},annotation);

module.exports={normalizeArcLookups,arcProducerSource,arcObservedMethodSource};
