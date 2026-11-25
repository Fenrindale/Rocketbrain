'use strict';

const { lexJava,rangeAt } = require('./java');
const { analyzeSpring } = require('./model');

const QUALIFIER = 'org.springframework.beans.factory.annotation.Qualifier';
const MARKER = '__rocketbrain_qualifier_probe__';
const VALUE = /^[A-Za-z_$][A-Za-z0-9_.$-]{0,127}$/u;
const equalPoint = (left,right) => left?.line===right?.line&&left?.character===right?.character;

// The lexical gate only finds a literal-shaped edit. Javac confirms its annotation and owning declaration.
function qualifierHole(source,offset) {
  if (!Number.isSafeInteger(offset)||offset<0||offset>source.length||source.length>512*1024||
      !source.includes('Qualifier')||/\\u+[0-9A-Fa-f]{4}/u.test(source)) return null;
  const leading=source.slice(0,offset);
  if (!/@(?:org\.springframework\.beans\.factory\.annotation\.)?Qualifier\s*\(\s*(?:value\s*=\s*)?(?:"[A-Za-z0-9_.$-]{0,128})?$/u
    .test(leading.slice(-350))) return null;
  const {tokens,issues}=lexJava(leading);
  const token=tokens.at(-1);
  const inString=token?.kind==='string'&&token.value===null&&token.end===offset&&/^"[A-Za-z0-9_.$-]{0,128}$/u.test(token.text);
  if (issues.some(issue=>!inString||issue!=='Unterminated string/character literal')) return null;
  const suffix=source.slice(offset,offset+160);
  const tail=inString?/^([A-Za-z0-9_.$-]{0,128})("[ \t]*\)|[ \t]*\))/u.exec(suffix):null;
  if (inString?!tail:!/^[ \t]*\)/u.test(suffix)) return null;
  let index=tokens.length-(inString?2:1);
  if (tokens[index]?.text==='='&&tokens[index-1]?.text==='value') index-=2;
  if (tokens[index]?.text!=='(') return null;
  const qualifier=tokens[index-1];
  if (qualifier?.text!=='Qualifier') return null;
  index-=2;
  while (tokens[index]?.text==='.'&&tokens[index-1]?.kind==='id') index-=2;
  if (tokens[index]?.text!=='@') return null;
  const name=tokens.slice(index+1,tokens.indexOf(qualifier)+1).map(part=>part.text).join('');
  if (name!=='Qualifier'&&name!==QUALIFIER) return null;
  const argumentStart=inString?token.start:offset, start=inString?argumentStart+1:offset;
  const end=inString?offset+tail[1].length:offset;
  if (end-start>128) return null;
  const closed=inString&&tail[2].startsWith('"');
  return {start,end,argumentStart,closed,inString,prefix:inString?source.slice(start,offset):''};
}

function qualifierDraft(source,hole) {
  const end=hole.end+(hole.closed?1:0), text=source.slice(0,hole.argumentStart)+JSON.stringify(MARKER)+source.slice(end);
  return {text,start:hole.argumentStart,end:hole.argumentStart+MARKER.length+2};
}

function insertion(hole,value) {
  return (hole.inString?'':'"')+value+(hole.closed?'':'"');
}

function observedBeans(runtime,profiles) {
  const active=runtime?.environment?.activeProfiles, defaults=runtime?.environment?.defaultProfiles;
  if (runtime?.endpoints?.beans?.state!=='available'||runtime.endpoints.env?.state!=='available'||
      !Array.isArray(active)||!Array.isArray(defaults)) return [];
  const observed=new Set(active.length?active:defaults);
  if (observed.size!==profiles.length||profiles.some(profile=>!observed.has(profile))) return [];
  return runtime.contexts.flatMap(context=>context.beans);
}

function selectorValues(bean) {
  return [...new Set([bean.springQualifier,...bean.aliases].filter(value=>typeof value==='string'&&VALUE.test(value)))];
}

function conditionNeedsObservation(bean) {
  return bean.reasons.length>0&&bean.reasons.flatMap(reason=>reason.split('; ')).every(reason=>
    /^Conditional(?:On\w+)? requires runtime\/classpath\/registration-order evaluation$/u.test(reason));
}

function qualifierCandidates({sources,uri,text,scopedProperties,options,attributed,hole,runtime}) {
  const site=attributed?.site, declarations=attributed?.declarations;
  if (!site||!Array.isArray(declarations)||declarations.length>500||!Number.isSafeInteger(site.annotationStart)||
      site.annotationStart<0||site.annotationStart>=hole.argumentStart) return [];
  const model=analyzeSpring(sources,scopedProperties,options);
  const qualifierStart=rangeAt(text,site.annotationStart,site.annotationStart).start;
  const sites=model.injections.filter(item=>item.uri===uri&&item.owner===site.owner&&item.name===site.name&&
    item.origin===site.origin&&item.type.name===site.type&&item.qualifier===MARKER&&
    equalPoint(item.qualifierRange?.start,qualifierStart)&&!item.contextUnresolved&&
    !item.annotations.some(annotation=>['Named','Value'].includes(annotation.shortName)||
      !annotation.known&&!annotation.name.startsWith('java.lang.')));
  if (sites.length!==1||sites[0].expression!==undefined) return [];
  const injection=sites[0], owner=model.beans.find(bean=>bean.id===injection.ownerBeanId);
  if (owner?.state!=='active') return [];

  const observed=observedBeans(runtime,model.profiles), compatible=model.beans.filter(bean=>{
    const offset=Number(bean.id.slice(bean.uri.length+1));
    return bean.state!=='inactive'&&(bean.origin==='component'||bean.autowireCandidate===true)&&declarations.some(declaration=>
      declaration.uri===bean.uri&&declaration.kind===bean.origin&&declaration.type===bean.type&&
      declaration.owner===(bean.configuration||bean.type)&&declaration.start<=offset&&offset<declaration.end);
  });
  const relevant=compatible.filter(bean=>bean.id!==owner.id);
  const results=[];
  for (const bean of relevant) {
    if (bean.nameUnknown||bean.qualifierUnknown) continue;
    if (model.beans.some(other=>other.id!==bean.id&&other.state!=='inactive'&&
      other.aliases.some(value=>bean.aliases.includes(value)))) continue;
    const hits=observed.filter(item=>bean.aliases.includes(item.name)||item.aliases.some(value=>bean.aliases.includes(value)));
    const witnessed=hits.length===1&&hits[0].type===bean.type;
    if (bean.state!=='active'&&(!witnessed||!conditionNeedsObservation(bean))) continue;
    for (const value of selectorValues(bean)) {
      if (!value.toLowerCase().startsWith(hole.prefix.toLowerCase())||
          compatible.some(other=>other.id!==bean.id&&(other.nameUnknown||other.qualifierUnknown||selectorValues(other).includes(value)))) continue;
      results.push({value,name:bean.name,type:bean.type,uri:bean.uri,range:bean.range,
        selector:value===bean.springQualifier?'qualifier':value===bean.name?'bean name':'bean alias',
        evidence:bean.state==='active'?'declared':'observed',observed:witnessed,profiles:model.profiles});
    }
  }
  return results.sort((a,b)=>a.evidence.localeCompare(b.evidence)||a.value.localeCompare(b.value)).slice(0,40);
}

module.exports = { qualifierHole,qualifierDraft,insertion,qualifierCandidates };
