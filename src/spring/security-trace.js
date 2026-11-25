'use strict';

const METHODS = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT','OTHER']);
const HOOKS = new Set(['proxy','standard-execution','observation-execution','authorization']);
const outcomes = new Set(['unobserved','granted','denied']);
const className = value => value===null || typeof value==='string' && value.length<=192 && /^[\w.$]+$/.test(value);
const list = (value, cap) => Array.isArray(value) && value.length<=cap;
const integer = (value,min,max) => Number.isSafeInteger(value) && value>=min && value<=max;

function normalizeSecurityTrace(payload) {
  const invalid = () => { throw Error('Unsupported Spring Security trace response.'); };
  if(!payload || typeof payload.enabled!=='boolean' || !list(payload.hooks,4) ||
    payload.hooks.some(hook=>!HOOKS.has(hook)) || new Set(payload.hooks).size!==payload.hooks.length ||
    !integer(payload.dropped,0,Number.MAX_SAFE_INTEGER) || !list(payload.traces,32)) return invalid();
  const state=payload.enabled?(payload.hooks.includes('proxy')?'ready':'waiting'):'disabled';
  if(state!==payload.state || (state!=='ready'&&payload.traces.length) || (!payload.enabled&&(payload.hooks.length||payload.dropped)))return invalid();
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
    return {id:trace.id,startedAt:trace.startedAt,durationMs:trace.durationMs,method:trace.method,status:trace.status,
      completed:trace.completed,coverage:trace.coverage,selectedChain:selected,matches,configured:[...trace.configured],entered:[...trace.entered],authorizationDecision:trace.authorizationDecision};
  }).sort((a,b)=>b.id-a.id);
  return {enabled:payload.enabled,state,hooks:[...payload.hooks],dropped:payload.dropped,traces};
}

module.exports={normalizeSecurityTrace};
