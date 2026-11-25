'use strict';

const auditTypes=Object.freeze({
  AUTHENTICATION_SUCCESS:'Authentication succeeded',
  AUTHENTICATION_FAILURE:'Authentication failed',
  AUTHORIZATION_FAILURE:'Authorization denied',
  AUTHORIZATION_SUCCESS:'Authorization granted'
});
const allowedMinutes=[5,15,60];
const maxEvents=200;
const maxInventory=200;
const chainType=/(?:^|\.)(?:DefaultSecurityFilterChain|SecurityFilterChain|FilterChainProxy|MatcherSecurityWebFilterChain|SecurityWebFilterChain|WebFilterChainProxy)(?:$|\$)/;
const chainNames=new Set(['springSecurityFilterChain','springSecurityWebFilterChainFilter']);
const securityCondition=/(?:\.security\.|(?:^|[.#])(?:.*WebSecurity|SpringBootSecurity).*Configuration(?:$|[.#]))/;
const controls=/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;

function auditRequest(input={},now=Date.now()) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw Error('Choose a Spring Security audit time window.');
  const {minutes=15,type='',principal=''}=input;
  if (!allowedMinutes.includes(minutes)) throw Error('Choose an audit window of 5, 15 or 60 minutes.');
  if (typeof type!=='string' || type && !Object.hasOwn(auditTypes,type)) throw Error('Choose a supported security audit event type.');
  if (typeof principal!=='string' || Buffer.byteLength(principal)>180 || principal.replace(controls,'')!==principal) {
    throw Error('Use a principal filter of at most 180 bytes without control characters.');
  }
  const after=new Date(now-minutes*60000).toISOString();
  const query=new URLSearchParams({after});
  if (type) query.set('type',type);
  if (principal) query.set('principal',principal);
  return {suffix:'?'+query.toString(),selection:{minutes,after,type,filteredPrincipal:!!principal}};
}

function normalizeSecurityEvents(payload,redact=text=>text) {
  if (!payload || typeof payload!=='object' || Array.isArray(payload) || !Array.isArray(payload.events)) {
    throw Error('Unsupported Spring Boot audit events shape.');
  }
  const events=[];
  for (const event of payload.events) {
    if (typeof event?.type!=='string' || !Object.hasOwn(auditTypes,event.type) || typeof event.principal!=='string' ||
        typeof event.timestamp!=='string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.timestamp) ||
        !Number.isFinite(Date.parse(event.timestamp))) continue;
    events.push({timestamp:event.timestamp.slice(0,40),principal:redact(event.principal).replace(controls,'').slice(0,180),
      type:event.type,outcome:auditTypes[event.type]});
  }
  events.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
  return {events:events.slice(0,maxEvents),matched:events.length,returned:payload.events.length,truncated:events.length>maxEvents};
}

function securityInventory(contexts,conditions) {
  const beans=[];
  for (const context of contexts) for (const bean of context.beans) {
    const chain=chainType.test(bean.type), registration=chainNames.has(bean.name);
    if (!chain && !registration && !bean.type.startsWith('org.springframework.security.')) continue;
    beans.push({context:context.id,name:bean.name,type:bean.type,scope:bean.scope,
      kind:chain?'filter-chain':registration?'framework-registration':'security-bean'});
  }
  const order={'filter-chain':0,'framework-registration':1,'security-bean':2};
  beans.sort((a,b)=>order[a.kind]-order[b.kind] || a.context.localeCompare(b.context) || a.name.localeCompare(b.name));
  const matches=conditions.filter(item=>securityCondition.test(item.source));
  return {beans:beans.slice(0,maxInventory),conditions:matches.slice(0,maxInventory),
    beansTruncated:beans.length>maxInventory,conditionsTruncated:matches.length>maxInventory};
}

module.exports={auditTypes,allowedMinutes,auditRequest,normalizeSecurityEvents,securityInventory};
