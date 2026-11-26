'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { parseJavaTokens, lexJava, matching, splitTop } = require('./java');

const ownerType = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const localType = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const label = /^[A-Za-z0-9_.$:@ -]{1,180}$/u;
const contextKey = /^context-[1-9][0-9]{0,15}$/u;
const primitive = new Set(['boolean','byte','short','int','long','char','float','double']);

function bounded(value, expression, length=256) {
  return typeof value === 'string' && value.length <= length && value.trim().length && expression.test(value);
}

function normalizeObservedInjection(raw) {
  if (!raw || !['observed','awaiting-hooks','disabled'].includes(raw.state) ||
      !Number.isSafeInteger(raw.processId) || raw.processId < 1 || !Number.isSafeInteger(raw.omitted) || raw.omitted < 0 ||
      raw.inspectionInvokedBeans !== false || raw.beanValuesRetained !== false || raw.observerExecutedSql !== false ||
      !Array.isArray(raw.events) || raw.events.length > 48 || (raw.state !== 'observed' && raw.events.length)) {
    throw Error('Invalid Spring constructor resolution data.');
  }
  let previous = 0;
  const events = raw.events.map(value => {
    const { context, site } = value || {};
    if (!Number.isSafeInteger(value?.id) || value.id <= previous ||
        !bounded(context?.key,contextKey) || (context.id !== undefined && !bounded(context.id,label)) ||
        !bounded(site?.owner,ownerType) || !bounded(site.requestingBean,label) ||
        !Array.isArray(site.parameterTypes) || !site.parameterTypes.length || site.parameterTypes.length > 24 ||
        site.parameterTypes.some(name => !bounded(name,ownerType)) || !Number.isInteger(site.parameterIndex) ||
        site.parameterIndex < 0 || site.parameterIndex >= site.parameterTypes.length ||
        (site.parameterName !== undefined && !bounded(site.parameterName,localType)) ||
        !['resolved','ambiguous','unproved'].includes(value.state) ||
        (value.state === 'resolved' ? !bounded(value.selectedBean,label) : value.selectedBean !== undefined) ||
        (value.suggestedName !== undefined && !bounded(value.suggestedName,label))) throw Error('Invalid Spring constructor event.');
    previous = value.id;
    return { id:value.id, state:value.state, context:{key:context.key,...(context.id && {id:context.id})},
      site:{ owner:site.owner, requestingBean:site.requestingBean, parameterIndex:site.parameterIndex,
        parameterTypes:[...site.parameterTypes], ...(site.parameterName && {parameterName:site.parameterName}) },
      ...(value.selectedBean && {selectedBean:value.selectedBean}), ...(value.suggestedName && {suggestedName:value.suggestedName}) };
  });
  return { processId:raw.processId, state:raw.state, omitted:raw.omitted, events,
    inspectionInvokedBeans:false,beanValuesRetained:false,observerExecutedSql:false };
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

module.exports={ normalizeObservedInjection, sourceParameter, readObservedSource };
