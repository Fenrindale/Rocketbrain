'use strict';

const crypto = require('node:crypto');
const {analyzeSpring} = require('./model');
const {rangeAt} = require('./java');

const FIX_CODE = 'spring.bean.ambiguous';
const QUALIFIER = 'org.springframework.beans.factory.annotation.Qualifier';
const ORIGINS = new Set(['field','constructor','method-parameter','factory-parameter']);
const QUALIFIER_TEXT = /^[A-Za-z_$][A-Za-z0-9_.$-]{0,127}$/;

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const unchangedId = (id,uri,start,length) => {
  if (!id.startsWith(uri+'#')) return id;
  const offset=Number(id.slice(uri.length+1));
  return offset>=start ? uri+'#'+(offset+length) : id;
};

function matchesQualifier(bean,value) {
  return bean.state==='unknown' && (bean.nameUnknown || bean.qualifierUnknown) ||
    bean.aliases.includes(value) || bean.qualifiers.includes(value);
}

function candidateChoices(model,injection) {
  if (!model || model.truncated || model.incomplete || !injection || injection.resolution?.state!=='ambiguous' ||
      !ORIGINS.has(injection.origin) || !injection.required || injection.qualifierPresent || injection.contextUnresolved ||
      !Number.isInteger(injection.declarationStart) || injection.declarationStart>=injection.nameStart ||
      !/^[\w.$]+$/u.test(injection.type.raw) || injection.type.array || injection.type.arguments.length ||
      injection.type.name.endsWith('.Optional') || injection.declarationModifiers?.includes('static') ||
      injection.origin==='field' && injection.declarationModifiers?.includes('final')) return [];
  const ambiguous=injection.resolution.ambiguous||[];
  const poolIds=injection.resolution.qualifierCandidates||[];
  if (ambiguous.length<2 || ambiguous.length>12 || poolIds.includes(injection.ownerBeanId)) return [];
  const pool=model.beans.filter(bean=>poolIds.includes(bean.id));
  // Constructor name matching depends on compiler metadata. Avoid proposing a
  // change where the declaration already names one of the candidates.
  if (pool.some(bean=>bean.state==='unknown' || bean.aliases.includes(injection.name))) return [];
  const choices=[];
  for (const bean of pool.filter(item=>ambiguous.includes(item.id))) {
    if (bean.state!=='active' || bean.nameUnknown || bean.qualifierUnknown) continue;
    const duplicateRegistration=model.beans.some(other=>other.id!==bean.id && other.state!=='inactive' &&
      other.aliases.some(value=>bean.aliases.includes(value)));
    if (duplicateRegistration) continue;
    const selectors=[...(typeof bean.springQualifier==='string'?[{value:bean.springQualifier,source:'qualifier'}]:[]),
      ...bean.aliases.map(value=>({value,source:'bean-name'}))];
    const selected=selectors.find(item=>QUALIFIER_TEXT.test(item.value) && pool.filter(other=>matchesQualifier(other,item.value)).length===1);
    if (selected) choices.push({beanId:bean.id,beanName:bean.name,beanType:bean.type,beanUri:bean.uri,beanRange:bean.range,
      qualifier:selected.value,qualifierSource:selected.source});
  }
  return choices;
}

function snapshotFingerprint(inputs) {
  const files=group=>group.map(file=>[file.uri,hash(file.text)]).sort((a,b)=>a[0].localeCompare(b[0]));
  return hash(JSON.stringify([files(inputs.java),files(inputs.properties),inputs.options]));
}

function prepareQualifier(model,inputs,request) {
  if (!request || typeof request.uri!=='string' || typeof request.injectionId!=='string' || typeof request.beanId!=='string')
    throw new Error('Select an ambiguous Spring injection and one of its candidates.');
  const injection=model.injections.find(item=>item.uri===request.uri && item.id===request.injectionId);
  const candidate=candidateChoices(model,injection).find(choice=>choice.beanId===request.beanId && choice.qualifier===request.qualifier);
  if (!candidate) throw new Error('The selected qualifier no longer uniquely identifies an available local Bean.');
  const file=inputs.java.find(item=>item.uri===request.uri);
  if (!file || file.text.slice(injection.nameStart,injection.nameStart+injection.name.length)!==injection.name)
    throw new Error('The exact injection declaration is unavailable or changed.');
  const offset=injection.declarationStart;
  const text='@'+QUALIFIER+'('+JSON.stringify(candidate.qualifier)+') ';
  const after=file.text.slice(0,offset)+text+file.text.slice(offset);
  const replacement=inputs.java.map(item=>item.uri===file.uri?{...item,text:after}:item);
  const verified=analyzeSpring(replacement,inputs.properties,inputs.options);
  const updated=verified.injections.find(item=>item.id===unchangedId(injection.id,file.uri,offset,text.length));
  const expected=unchangedId(candidate.beanId,file.uri,offset,text.length);
  if (verified.incomplete || updated?.name!==injection.name || updated?.qualifier!==candidate.qualifier ||
      updated?.resolution.state!=='resolved' || updated.resolution.selected.length!==1 || updated.resolution.selected[0]!==expected ||
      updated.resolution.candidates.length!==1)
    throw new Error('The proposed qualifier did not resolve exactly one local Bean in the edited source.');
  return {uri:file.uri,owner:injection.owner,injection:injection.name,origin:injection.origin,candidate,
    offset,range:rangeAt(file.text,offset,offset),text,before:file.text,after,
    beforeHash:hash(file.text),afterHash:hash(after),fingerprint:snapshotFingerprint(inputs),
    scope:'configured-local-spring-source-model'};
}

module.exports={FIX_CODE,candidateChoices,prepareQualifier,snapshotFingerprint};
