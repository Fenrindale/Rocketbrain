'use strict';

const METHODS = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT','OTHER']);
const providerHook = 'authentication-provider-manager';
const HOOKS = new Set(['proxy','standard-execution','observation-execution','authorization','method-before','method-after','method-roles','method-manager',providerHook]);
const outcomes = new Set(['unobserved','granted','denied']);
const className = value => value===null || typeof value==='string' && value.length<=192 && /^[\w.$]+$/.test(value);
const list = (value, cap) => Array.isArray(value) && value.length<=cap;
const integer = (value,min,max) => Number.isSafeInteger(value) && value>=min && value<=max;

const roleEvidence=new Set(['role-hierarchy','direct-authorities','custom-hierarchy']);
const methodCoverage=new Set(['disabled','unavailable','observed','partial']);
const methodSources=new Map([['no-result',['abstained']],['framework-result',['granted','denied']],
  ['manager-threw-denial',['denied']],['incomplete',['unobserved']]]);
const roles = value => list(value,12) && value.every(role=>typeof role==='string'&&/^[A-Za-z][A-Za-z0-9_:.\-]{0,63}$/.test(role)) && new Set(value).size===value.length;

const providerOutcomes=new Set(['skipped','abstained','returned','rejected','error','support-error','unobserved']);
const managerOutcomes=new Set(['returned','rejected','error','unobserved']);
const authenticationCoverage=new Set(['observed','unobserved','partial','unavailable']);
function authenticationEvidence(trace, hooked, invalid){
  const coverage=trace.authenticationCoverage;
  if(!authenticationCoverage.has(coverage)||!list(trace.authenticationManagers,6)||(coverage==='unavailable')===hooked||
    (['unobserved','unavailable'].includes(coverage)&&trace.authenticationManagers.length)||
    (coverage==='observed'&&!trace.authenticationManagers.length))return invalid();
  const managers=trace.authenticationManagers.map((manager,index)=>{
    if(!manager||manager.index!==index+1||typeof manager.managerId!=='string'||!/^manager-[1-9][0-9]{0,15}$/.test(manager.managerId)||
      manager.managerType===null||!className(manager.managerType)||!managerOutcomes.has(manager.outcome)||
      typeof manager.delegated!=='boolean'||typeof manager.complete!=='boolean'||!className(manager.parentType)||
      (!manager.delegated&&manager.parentType!==null)||(manager.delegated&&manager.complete)||
      (manager.outcome==='unobserved'&&manager.complete)||!list(manager.providers,12))return invalid();
    const providers=manager.providers.map((provider,pos)=>{
      if(!provider||provider.index!==pos+1||provider.providerType===null||!className(provider.providerType)||
        !providerOutcomes.has(provider.outcome)||(manager.complete&&provider.outcome==='unobserved'))return invalid();
      return {index:provider.index,providerType:provider.providerType,outcome:provider.outcome};
    });
    const selected=manager.selectedProvider;
    if(selected!==null&&(!manager.complete||manager.outcome!=='returned'||!integer(selected,1,providers.length)||
      providers[selected-1].outcome!=='returned'||providers.filter(provider=>provider.outcome==='returned').length!==1))return invalid();
    if(manager.complete&&manager.outcome==='returned'&&selected===null)return invalid();
    return {index:manager.index,managerId:manager.managerId,managerType:manager.managerType,outcome:manager.outcome,
      selectedProvider:selected,delegated:manager.delegated,parentType:manager.parentType,complete:manager.complete,providers};
  });
  if(coverage==='observed'&&managers.some(manager=>!manager.complete))return invalid();
  return {authenticationCoverage:coverage,authenticationManagers:managers};
}

function methodEvidence(event, disclosure, invalid) {
  if(!event || !['before','after'].includes(event.phase) || !className(event.manager) || !className(event.delegateManager) || !className(event.owner) || !className(event.method) ||
    (event.parameterTypes!==null && (!list(event.parameterTypes,8) || event.parameterTypes.some(type=>
      typeof type!=='string'||type.length>192||!/^[\w.$\[\]]+$/.test(type)))) ||
    !methodSources.get(event.decisionSource)?.includes(event.decision) ||
    (event.decisionSource==='manager-threw-denial' && event.phase!=='before') ||
    !list(event.roleSources,3) || event.roleSources.some(source=>!roleEvidence.has(source)) ||
    new Set(event.roleSources).size!==event.roleSources.length || !roles(event.checkedRoles) || !roles(event.matchedRoles) ||
    event.matchedRoles.some(role=>!event.checkedRoles.includes(role)) ||
    (event.checkedRoles.length && (!disclosure || !event.roleSources.length))) return invalid();
  return {phase:event.phase,manager:event.manager,delegateManager:event.delegateManager,owner:event.owner,method:event.method,
    parameterTypes:event.parameterTypes===null?null:[...event.parameterTypes],
    decision:event.decision,decisionSource:event.decisionSource,roleSources:[...event.roleSources],
    checkedRoles:[...event.checkedRoles],matchedRoles:[...event.matchedRoles]};
}

function normalizeSecurityTrace(payload) {
  const invalid = () => { throw Error('Unsupported Spring Security trace response.'); };
  if(!payload || typeof payload.enabled!=='boolean' || !list(payload.hooks,HOOKS.size) ||
    payload.hooks.some(hook=>!HOOKS.has(hook)) || new Set(payload.hooks).size!==payload.hooks.length ||
    !integer(payload.dropped,0,Number.MAX_SAFE_INTEGER) || !list(payload.traces,32)) return invalid();
  const state=payload.enabled?(payload.hooks.includes('proxy')?'ready':'waiting'):'disabled';
  if(state!==payload.state || (state!=='ready'&&payload.traces.length) || (!payload.enabled&&(payload.hooks.length||payload.dropped)))return invalid();
  const extended=payload.methodTraceEnabled!==undefined||payload.roleDisclosureEnabled!==undefined;
  const methodEnabled=payload.methodTraceEnabled===true, disclosure=payload.roleDisclosureEnabled===true;
  if((extended&&(typeof payload.methodTraceEnabled!=='boolean'||typeof payload.roleDisclosureEnabled!=='boolean')) ||
    (methodEnabled&&!payload.enabled) || (!methodEnabled&&(disclosure||payload.hooks.some(hook=>hook.startsWith('method-'))))) return invalid();
  const providerEnabled=payload.authenticationProviderTraceEnabled===true, providerHooked=payload.hooks.includes(providerHook);
  if((payload.authenticationProviderTraceEnabled!==undefined&&typeof payload.authenticationProviderTraceEnabled!=='boolean')||
    (providerEnabled&&!payload.enabled)||(providerHooked&&!providerEnabled))return invalid();
  const ids=new Set();
  const traces=payload.traces.map(trace=>{
    if(!trace || !integer(trace.id,1,Number.MAX_SAFE_INTEGER) || ids.has(trace.id) ||
      typeof trace.startedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(trace.startedAt)||!Number.isFinite(Date.parse(trace.startedAt)) ||
      !integer(trace.durationMs,0,3600000) || !METHODS.has(trace.method) ||
      (trace.status!==null&&!integer(trace.status,100,599)) || typeof trace.completed!=='boolean' ||
      (!trace.completed&&trace.status!==null) || !['observed','partial'].includes(trace.coverage) || !outcomes.has(trace.authorizationDecision) ||
      !list(trace.matches,16) || !list(trace.configured,32) || !list(trace.entered,32) || trace.entered.length>trace.configured.length ||
      !trace.configured.every(className) || !trace.entered.every((type,index)=>type===trace.configured[index])) return invalid();
    ids.add(trace.id);
    const matches=trace.matches.map((match,index)=>{
      if(!match || match.index!==index+1 || !className(match.chainType) || !className(match.matcherType) || typeof match.matched!=='boolean' ||
        (match.matched&&index!==trace.matches.length-1)) return invalid();
      return {index:match.index,chainType:match.chainType,matcherType:match.matcherType,matched:match.matched};
    });
    const selected=matches.find(item=>item.matched)?.index??null;
    if(trace.selectedChain!==selected || (trace.coverage==='observed' && trace.configured.length && (selected===null||!trace.entered.length)))return invalid();
    let methods;
    if(extended){
      if(!methodCoverage.has(trace.methodCoverage)||!list(trace.methodDecisions,8)||
        (trace.methodCoverage!=='disabled')!==methodEnabled ||
        (['disabled','unavailable'].includes(trace.methodCoverage)&&trace.methodDecisions.length))return invalid();
      const methodDecisions=trace.methodDecisions.map(event=>methodEvidence(event,disclosure,invalid));
      if(methodDecisions.some(event=>!payload.hooks.includes('method-'+event.phase)||
        event.roleSources.length&&!payload.hooks.includes('method-roles')||
        event.delegateManager&&!payload.hooks.includes('method-manager')))return invalid();
      methods={methodCoverage:trace.methodCoverage,methodDecisions};
    }
    const authentication=providerEnabled?authenticationEvidence(trace,providerHooked,invalid):undefined;
    return {id:trace.id,startedAt:trace.startedAt,durationMs:trace.durationMs,method:trace.method,status:trace.status,
      completed:trace.completed,coverage:trace.coverage,selectedChain:selected,matches,configured:[...trace.configured],entered:[...trace.entered],authorizationDecision:trace.authorizationDecision,...methods,...authentication};
  }).sort((a,b)=>b.id-a.id);
  return {enabled:payload.enabled,state,hooks:[...payload.hooks],dropped:payload.dropped,traces,
    ...(extended?{methodTraceEnabled:methodEnabled,roleDisclosureEnabled:disclosure}:{}),
    ...(providerEnabled?{authenticationProviderTraceEnabled:true}:{})};
}

module.exports={normalizeSecurityTrace};
