'use strict';

const { isDeepStrictEqual } = require('node:util');
const { jarName } = require('./cookie-jar');
const { parseClientCredentials,resolveClientCredentials,fetchAccessToken } = require('./oauth-client');

const maxDocumentBytes = 512 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const methods = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const graphQLAccept = 'application/graphql-response+json, application/json';
const typeReference = depth => 'kind name' + (depth ? ' ofType { '+typeReference(depth-1)+' }' : '');
const schemaQuery = `query RocketbrainSchema {
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    directives { name locations args { name defaultValue type { ${typeReference(6)} } } }
    types {
      kind name interfaces { name } possibleTypes { name } enumValues { name }
      inputFields { name defaultValue type { ${typeReference(6)} } }
      fields { name type { ${typeReference(6)} } args { name defaultValue type { ${typeReference(6)} } } }
    }
  }
}`;
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const variable = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const controlledHeaders = new Set(['host','content-length','connection','transfer-encoding','expect','upgrade']);
const responseSecrets = new Set(['set-cookie','www-authenticate','proxy-authenticate','authentication-info']);
const jsonPathPattern = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]{0,5})\]){0,16}$/;
const bytes = input => Buffer.byteLength(input,'utf8');

function splitRequests(text) {
  if (typeof text !== 'string' || bytes(text)>maxDocumentBytes || text.includes('\0')) throw Error('HTTP documents are limited to 512 KiB of text.');
  const ranges = [];
  let start = 0;
  for (const boundary of text.matchAll(/^[ \t]*###(?=[ \t\r\n]|$)[^\r\n]*(?:\r?\n|$)/gm)) {
    if (boundary.index>start) ranges.push({ start,end:boundary.index,source:text.slice(start,boundary.index) });
    start = boundary.index + boundary[0].length;
  }
  ranges.push({ start,end:text.length,source:text.slice(start) });
  if (ranges.length>100) throw Error('Use at most 100 requests in one HTTP document.');
  return ranges;
}

function requestAt(text, offset) {
  const ranges = splitRequests(text);
  const available = ranges.filter(range => offset>=range.start && offset<=range.end);
  const selected = available.at(-1);
  if (!selected) throw Error('Place the cursor inside a request.');
  const variables = new Map();
  const derivations = new Map();
  const assertions = [];
  let requestLine, bodyFile, cookieJar, oauth, bodyStart = selected.source.length, marker = 0;
  const headers = [];
  for (const line of text.slice(0,ranges[0].end).split(/\r?\n/)) {
    const declaration = /^@([A-Za-z_][A-Za-z0-9_.-]{0,79})\s*=\s*(.*)$/.exec(line);
    if (declaration) variables.set(declaration[1],declaration[2]);
    else if (line.trim() && !/^[ \t]*(?:#|\/\/)/.test(line)) break;
  }
  for (const line of selected.source.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    if (!line[0]) break;
    const raw = line[0].replace(/\r?\n$/, '');
    const content = raw.trim();
    const end = line.index + line[0].length;
    if (/^#\s*@oauth-client(?:\s|$)/i.test(content)) {
      const directive=/^#\s*@oauth-client\s+(.+)$/i.exec(content);
      if (!directive||oauth!==undefined) throw Error('Choose one @oauth-client configuration for this HTTP request.');
      oauth=parseClientCredentials(directive[1]);
      continue;
    }
    if (/^#\s*@cookie-jar(?:\s|$)/i.test(content)) {
      const directive=/^#\s*@cookie-jar\s+(\S+)$/i.exec(content);
      if (!directive||cookieJar!==undefined||!jarName.test(directive[1])) throw Error('Choose one named HTTP cookie jar.');
      cookieJar=directive[1];
      continue;
    }
    if (/^#\s*@body-file(?:\s|$)/i.test(content)) {
      const directive=/^#\s*@body-file\s+(.+)$/i.exec(content);
      if (!directive||bodyFile!==undefined) throw Error('Choose one quoted workspace-relative @body-file path.');
      try { bodyFile=JSON.parse(directive[1]); } catch { throw Error('Choose a quoted workspace-relative @body-file path.'); }
      if (typeof bodyFile!=='string'||!bodyFile||bodyFile.length>512) {
        throw Error('Choose a quoted workspace-relative @body-file path up to 512 characters.');
      }
      continue;
    }
    if (/^#\s*@derive(?:\s|$)/i.test(content)) {
      const definition=/^#\s*@derive\s+(\S+)\s+(url-component|json-string)\s+(.+)$/i.exec(content);
      const [,name,op,source]=definition || [];
      if (!definition || requestLine || !variable.test(name) || name.startsWith('secret.') || derivations.has(name)) {
        throw Error('Define distinct @derive variables before the request line.');
      }
      let template;
      try { template=JSON.parse(source); } catch { throw Error('Use a JSON string in @derive.'); }
      if (typeof template!=='string' || bytes(template)>8192) throw Error('Use a JSON string of at most 8 KiB in @derive.');
      derivations.set(name,{op:op.toLowerCase(),template});
      continue;
    }
    const expectation = /^#\s*@expect\s+(.+)$/i.exec(content);
    if (expectation) {
      assertions.push(parseAssertion(expectation[1]));
      continue;
    }
    if (/^#\s*@check(?:\s|$)/i.test(content)) {
      const check = /^#\s*@check\s+([A-Za-z][A-Za-z0-9_-]{0,63})\s+(.+)$/i.exec(content);
      if (!check || assertions.some(item=>item.kind==='check' && item.name===check[1])) {
        throw Error('Use a distinct @check name followed by a JSON expression.');
      }
      assertions.push({kind:'check',name:check[1],expression:parseResponseCheck(check[2])});
      continue;
    }
    if (/^(?:#|\/\/)/.test(content)) continue;
    if (!requestLine) {
      const declaration = /^@([A-Za-z_][A-Za-z0-9_.-]{0,79})\s*=\s*(.*)$/.exec(content);
      if (declaration) {
        if (declaration[1].startsWith('secret.')) throw Error('Store secret variables in Secret Storage.');
        variables.set(declaration[1],declaration[2]);
        continue;
      }
      if (!content) continue;
      const values = /^([A-Za-z]+)[ \t]+(\S+)(?:[ \t]+HTTP\/1\.[01])?$/.exec(content);
      const method = values?.[1].toUpperCase();
      if (!methods.has(method) && !['GRAPHQL','WEBSOCKET','GRPC'].includes(method)) {
        throw Error('Start the request with an HTTP method, GRAPHQL, WEBSOCKET or GRPC followed by a URL.');
      }
      requestLine = { method,url:values[2] };
      marker = selected.start + line.index;
      continue;
    }
    if (!content) {
      bodyStart = end;
      break;
    }
    const separator = raw.indexOf(':');
    const field = raw.slice(0,separator).trim();
    if (separator<1 || !headerPattern.test(field) || controlledHeaders.has(field.toLowerCase()) ||
        headers.some(([existing])=>existing.toLowerCase()===field.toLowerCase())) {
      throw Error('Use distinct permitted HTTP header names.');
    }
    headers.push([field,raw.slice(separator+1).trim()]);
  }
  if (!requestLine) throw Error('Place the cursor inside a request.');
  if (oauth!==undefined && (['WEBSOCKET','GRPC'].includes(requestLine.method)||
      headers.some(([name])=>name.toLowerCase()==='authorization'))) {
    throw Error('Use @oauth-client with an HTTP request and no explicit Authorization header.');
  }
  if (cookieJar!==undefined && (['WEBSOCKET','GRPC'].includes(requestLine.method)||
      headers.some(([name])=>name.toLowerCase()==='cookie'))) {
    throw Error('Use @cookie-jar with an HTTP request and no explicit Cookie header.');
  }
  if ([...derivations.keys()].some(name=>variables.has(name))) throw Error('Use separate names for local and derived HTTP variables.');
  if (headers.length>40 || assertions.length>32 || variables.size+derivations.size>64) throw Error('Use at most 40 headers, 32 assertions and 64 local variables.');
  const body = selected.source.slice(bodyStart);
  if (bodyFile!==undefined && (!['POST','PUT','PATCH','DELETE','OPTIONS'].includes(requestLine.method)||body.trim())) {
    throw Error('Use @body-file with a body-capable HTTP method and an empty inline body.');
  }
  if (body && ['GET','HEAD'].includes(requestLine.method)) throw Error('GET and HEAD requests use no body.');
  if (requestLine.method==='WEBSOCKET' && (body.trim() || assertions.length)) {
    throw Error('Open the WebSocket first, then send messages from its workbench commands.');
  }
  return { ...requestLine, headers, body, assertions, variables, derivations, start:marker,
    ...(bodyFile!==undefined&&{bodyFile}), ...(cookieJar!==undefined&&{cookieJar}), ...(oauth&&{oauth}) };
}

function parseAssertion(source) {
  const status = /^status\s+(\d{3})$/i.exec(source);
  if (status && Number(status[1])>=100 && Number(status[1])<=599) return { kind:'status',value:Number(status[1]) };
  const expression = /^(header|json)\s+([^\s]+)\s*==\s*(.+)$/i.exec(source);
  if (!expression) throw Error('Use status, header or JSON equality in @expect.');
  const kind = expression[1].toLowerCase(), name = expression[2];
  const valid = kind==='header' ? headerPattern.test(name) && !responseSecrets.has(name.toLowerCase())
    : jsonPathPattern.test(name);
  if (!valid) throw Error('Select an observable response header or a simple JSON path.');
  let value;
  try { value=JSON.parse(expression[3]); } catch { throw Error('Use a JSON literal for equality assertions.'); }
  if (kind==='header' && typeof value!=='string') throw Error('Use a string when testing a response header.');
  return { kind,name,value };
}

const numericChecks = new Map([
  ['lt',(actual,expected)=>actual<expected], ['lte',(actual,expected)=>actual<=expected],
  ['gt',(actual,expected)=>actual>expected], ['gte',(actual,expected)=>actual>=expected]
]);
const isExactNumber = value => typeof value==='number' && Number.isFinite(value) &&
  (!Number.isInteger(value) || Number.isSafeInteger(value));

function parseResponseCheck(source) {
  if (bytes(source)>4096) throw Error('HTTP response checks are limited to 4 KiB each.');
  let expression, nodes=0;
  try { expression=JSON.parse(source); } catch { throw Error('Use a valid JSON expression in @check.'); }
  const invalid=()=>{ throw Error('Use a supported operation and response selector in @check.'); };
  function validate(node,depth) {
    if (!Array.isArray(node) || ++nodes>64 || depth>8) invalid();
    const [op,selector,expected]=node;
    if (op==='all' || op==='any') {
      if (node.length<2 || node.length>17) invalid();
      for (const child of node.slice(1)) validate(child,depth+1);
      return;
    }
    if (op==='not' && node.length===2) { validate(selector,depth+1); return; }
    if (typeof selector!=='string') invalid();
    const header=selector.startsWith('header:') && selector.slice(7);
    if (selector!=='status' && !(selector.startsWith('json:') && jsonPathPattern.test(selector.slice(5))) &&
        !(header && headerPattern.test(header) && !responseSecrets.has(header.toLowerCase()))) invalid();
    if (op==='exists' && node.length===2) return;
    if (node.length!==3) invalid();
    if (numericChecks.has(op) && isExactNumber(expected) && !header) return;
    if (op==='eq' && (expected===null || ['string','boolean'].includes(typeof expected) || isExactNumber(expected))) return;
    invalid();
  }
  validate(expression,1);
  return expression;
}

function checkResponse(node,response,json) {
  const [op,selector,expected]=node;
  if (op==='not') {
    const value=checkResponse(selector,response,json);
    return value===undefined ? undefined : !value;
  }
  if (op==='all' || op==='any') {
    const decisive=op==='any';
    let unknown=false;
    for (const child of node.slice(1)) {
      const value=checkResponse(child,response,json);
      if (value===decisive) return decisive;
      unknown ||= value===undefined;
    }
    return unknown ? undefined : !decisive;
  }
  if (selector.startsWith('json:') && json===undefined) return undefined;
  const actual=selector==='status' ? response.status : selector.startsWith('header:') ?
    response.headers.get(selector.slice(7)) ?? undefined : jsonValue(json,selector.slice(5));
  if (op==='exists') return actual!==undefined;
  if (actual===undefined || typeof actual==='number' && !isExactNumber(actual)) return undefined;
  if (op==='eq') return isDeepStrictEqual(actual,expected);
  return isExactNumber(actual) ? numericChecks.get(op)(actual,expected) : undefined;
}

async function graphQLBody(body, expand) {
  const source=body.trim();
  if (!source) throw Error('Add a GraphQL operation in the request body.');
  if (!/^\{\s*"/.test(source)) return JSON.stringify({query:await expand(source,true)});
  let input;
  try { input=JSON.parse(source); } catch { throw Error('Use valid JSON for a GraphQL request envelope.'); }
  if (typeof input.query!=='string' || !input.query.trim() ||
      Object.keys(input).some(key=>!['query','operationName','variables','extensions'].includes(key))) {
    throw Error('Use a GraphQL JSON object with a query string and optional operationName, variables and extensions.');
  }
  const expanded={query:await expand(input.query,true)};
  if (input.operationName!==undefined && input.operationName!==null) {
    const name=typeof input.operationName==='string' ? await expand(input.operationName,false) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('Use a GraphQL operation name.');
    expanded.operationName=name;
  }
  let count=0, expandedBytes=bytes(expanded.query);
  async function expandValue(value,depth) {
    if (++count>4096 || depth>24) throw Error('Reduce nesting or the number of GraphQL input values.');
    if (typeof value==='string') {
      const result=await expand(value,true);
      expandedBytes+=bytes(result);
      if (expandedBytes>maxDocumentBytes) throw Error('The expanded request exceeds 512 KiB.');
      return result;
    }
    if (Array.isArray(value)) {
      const result=[];
      for (const item of value) result.push(await expandValue(item,depth+1));
      return result;
    }
    if (value && typeof value==='object') {
      const result=Object.create(null);
      for (const [key,item] of Object.entries(value)) result[key]=await expandValue(item,depth+1);
      return result;
    }
    if (typeof value==='number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw Error('Use an exact GraphQL JSON number or represent a large integer as a string.');
    }
    return value;
  }
  for (const key of ['variables','extensions']) {
    if (input[key]===undefined || input[key]===null) continue;
    if (typeof input[key]!=='object' || Array.isArray(input[key])) throw Error('Use a JSON object for GraphQL '+key+'.');
    expanded[key]=await expandValue(input[key],0);
  }
  return JSON.stringify(expanded);
}

async function resolveRequest(request, environment, readSecret, {schema=false,readBodyFile,captureValues}={}) {
  const graphQL=request.method==='GRAPHQL', webSocket=request.method==='WEBSOCKET', grpc=request.method==='GRPC';
  if (schema && !graphQL) throw Error('Select a GRAPHQL request to inspect its schema.');
  const secrets = new Map();
  const values = new Map(Object.entries(environment || {}));
  if (values.size>64 || [...values.entries()].some(([name,value])=>!variable.test(name) ||
      name.startsWith('secret.') || typeof value!=='string' || bytes(value)>8192)) {
    throw Error('Use at most 64 named environment string variables.');
  }
  for (const [name,value] of request.variables) {
    if (name.startsWith('secret.')) throw Error('Store secret variables in Secret Storage.');
    values.set(name,value);
  }
  async function expand(input, allowSecret, chain = []) {
    let result = '', end = 0;
    for (const match of input.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_.-]{0,79})\}\}/g)) {
      const name = match[1];
      if (chain.length>=8 || chain.includes(name)) throw Error('A request variable contains a recursive reference.');
      result += input.slice(end,match.index);
      if (name.startsWith('secret.')) {
        if (!allowSecret) throw Error('Secret variables may be used in headers or body.');
        if (!secrets.has(name)) {
          const value = await readSecret(name.slice(7));
          if (typeof value!=='string' || !value || bytes(value)>8192) throw Error('Set the secret variable before sending the request.');
          secrets.set(name,value);
        }
        result += secrets.get(name);
      } else if (captureValues && name.startsWith('capture.')) {
        if (!captureValues.has(name)) throw Error('Choose an earlier workflow capture for ' + name + '.');
        result += captureValues.get(name);
      } else if (request.derivations?.has(name)) {
        const {op,template}=request.derivations.get(name);
        const expanded=await expand(template,false,[...chain,name]);
        try { result+=op==='url-component' ? encodeURIComponent(expanded) : JSON.stringify(expanded); }
        catch { throw Error('Use valid Unicode text in an HTTP URL component.'); }
      } else {
        if (!values.has(name)) throw Error('Missing HTTP variable ' + name + '.');
        result += await expand(values.get(name),allowSecret,[...chain,name]);
      }
      end = match.index + match[0].length;
      if (bytes(result)>maxDocumentBytes) throw Error('The expanded request exceeds 512 KiB.');
    }
    result += input.slice(end);
    if (bytes(result)>maxDocumentBytes) throw Error('The expanded request exceeds 512 KiB.');
    return result;
  }
  const expandedUrl = await expand(request.url,false);
  let url;
  const allowedProtocols=grpc?['grpc:','grpcs:']:webSocket?['ws:','wss:']:['http:','https:'];
  const permittedUrl=grpc?'gRPC grpc:// or grpcs://':webSocket?'WebSocket ws:// or wss://':'HTTP or HTTPS';
  try { url=new URL(expandedUrl); } catch { throw Error('Use a complete '+permittedUrl+' URL.'); }
  if (!allowedProtocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash ||
      /[\r\n\t]|\{\{|\}\}/.test(expandedUrl)) throw Error('Use a '+permittedUrl+' URL without user information, fragments or unresolved variables.');
  const headers = {};
  let protocols=[], proto;
  for (const [name,value] of request.headers) {
    const key=name.toLowerCase();
    if (grpc && key==='proto') {
      proto=await expand(value,false);
      continue;
    }
    if (webSocket && key.startsWith('sec-websocket-')) {
      if (key!=='sec-websocket-protocol') throw Error('The WebSocket client controls its handshake headers.');
      const resolved=await expand(value,false);
      protocols=resolved.split(',',17).map(item=>item.trim());
      if (/[\x00-\x1f\x7f]/.test(resolved) || protocols.length>16 ||
          protocols.some(item=>!headerPattern.test(item) || item.length>128) || new Set(protocols).size!==protocols.length) {
        throw Error('Use distinct WebSocket subprotocol names.');
      }
      continue;
    }
    const resolved=await expand(value,true);
    if (/[\x00-\x1f\x7f]/.test(resolved) || bytes(resolved)>8192) throw Error('A request header has invalid characters or exceeds 8 KiB.');
    Object.defineProperty(headers,name,{value:resolved,enumerable:true});
  }
  if (graphQL) {
    const names=Object.keys(headers).map(name=>name.toLowerCase());
    const contentType=Object.keys(headers).find(name=>name.toLowerCase()==='content-type');
    if (!contentType) headers['Content-Type']='application/json';
    else if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(headers[contentType])) {
      throw Error('Use application/json for GraphQL request bodies.');
    }
    if (!names.includes('accept')) headers.Accept=graphQLAccept;
  }
  let body;
  if (schema) body=JSON.stringify({query:schemaQuery,operationName:'RocketbrainSchema'});
  else if (graphQL) body=await graphQLBody(request.body,expand);
  else if (request.bodyFile!==undefined) {
    if (!readBodyFile) throw Error('Open this request from a trusted local workspace to attach a body file.');
    if (!Object.keys(headers).some(name=>name.toLowerCase()==='content-type')) headers['Content-Type']='application/octet-stream';
    const available=maxDocumentBytes-bytes(JSON.stringify(headers));
    if (available<0) throw Error('The expanded request exceeds 512 KiB.');
    body=await readBodyFile(request.bodyFile,available);
    if (!Buffer.isBuffer(body)) throw Error('The selected request body file did not return exact bytes.');
  }
  else body=await expand(request.body,true);
  if (bytes(body)+bytes(JSON.stringify(headers))>maxDocumentBytes) throw Error('The expanded request exceeds 512 KiB.');
  const oauth=request.oauth&&await resolveClientCredentials(request.oauth,url,expand);
  const alternatives = new Set();
  for (const secret of secrets.values()) {
    alternatives.add(secret);
    alternatives.add(Buffer.from(secret).toString('base64'));
    alternatives.add(JSON.stringify(secret).slice(1,-1));
    try { alternatives.add(encodeURIComponent(secret)); } catch { /* Raw value is still covered. */ }
  }
  const patterns = [...alternatives].sort((a,b)=>b.length-a.length)
    .map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  if (patterns.join('').length>65536) throw Error('Reduce the total size of interpolated HTTP secrets.');
  const redactions = patterns.length ? new RegExp(patterns.join('|'),'g') : null;
  const redact = value => redactions ? String(value).replace(redactions,'[redacted]') : String(value);
  const ready={ method:request.method,url,headers,body,assertions:request.assertions,redact,
    ...(request.cookieJar!==undefined&&{cookieJar:request.cookieJar}), ...(oauth&&{oauth}) };
  if (grpc) {
    if (!proto) throw Error('Set the Proto header to a .proto file in this workspace.');
    if (request.assertions.length) throw Error('HTTP assertions require an HTTP response.');
    return { ...ready,proto };
  }
  if (webSocket) return { ...ready,protocols };
  if (graphQL) return { ...ready,method:'POST',assertions:schema?[]:request.assertions,graphql:schema?'schema':'operation' };
  return ready;
}

async function responseBody(response) {
  if (!response.body) return { body:'',truncated:false };
  const reader = response.body.getReader(), parts = [];
  let count=0;
  try {
    for (;;) {
      const { value,done } = await reader.read();
      if (done) return { body:Buffer.concat(parts,count).toString('utf8'),truncated:false };
      const remaining = maxResponseBytes-count;
      if (value.length>remaining) {
        parts.push(Buffer.from(value.subarray(0,remaining)));
        await reader.cancel();
        return { body:Buffer.concat(parts,maxResponseBytes).toString('utf8'),truncated:true };
      }
      count+=value.length;
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function jsonValue(value, path) {
  for (const part of path.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)) {
    const name=part[1] ?? part[2];
    if (value===null || typeof value!=='object' || !Object.hasOwn(value,name)) return undefined;
    value=value[name];
  }
  return value;
}

async function sendRequest(request, { signal,fetcher=fetch,cookieSession,beforeAuthenticatedRequest } = {}) {
  const started = performance.now();
  const timeout = AbortSignal.timeout(15000);
  const bounded = signal?AbortSignal.any([signal,timeout]):timeout;
  const interrupted=()=>Error(signal?.aborted?'The HTTP request was cancelled.':'The HTTP request timed out.');
  let token;
  if (request.oauth) {
    try { token=await fetchAccessToken(request.oauth,{fetcher,signal:bounded}); }
    catch(error) { throw bounded.aborted?interrupted():error; }
    if (bounded.aborted) throw interrupted();
    await beforeAuthenticatedRequest?.();
  }
  const headers={...request.headers};
  if (cookieSession?.header) headers.Cookie=cookieSession.header;
  if (token) headers.Authorization='Bearer '+token;
  if ((token||cookieSession?.header)&&bytes(request.body)+bytes(JSON.stringify(headers))>maxDocumentBytes) {
    throw Error('The authenticated HTTP request exceeds 512 KiB.');
  }
  let response, captured;
  try {
    response=await fetcher(request.url,{
      method:request.method,headers,body:request.body||undefined,
      redirect:'manual',signal:bounded
    });
    captured=await responseBody(response);
  } catch (error) {
    if (bounded.aborted) throw interrupted();
    throw Error('Unable to send the HTTP request or read its response.',{cause:error});
  }
  cookieSession?.capture(response.headers.getSetCookie?.()||[]);
  const redact=value=>{
    let masked=request.redact(value);
    if (token) masked=masked.replaceAll(token,'[redacted]').replaceAll(encodeURIComponent(token),'[redacted]');
    return cookieSession ? cookieSession.redact(masked) : masked;
  };
  let json;
  if (!captured.truncated && (request.graphql || request.assertions.some(item=>item.kind==='json' || item.kind==='check'))) {
    try { json=JSON.parse(captured.body); } catch { /* JSON assertions cannot pass on a non-JSON body. */ }
  }
  const assertions=request.assertions.map(({kind,name,value,expression})=>{
    if (kind==='check') return {kind,name,passed:checkResponse(expression,response,json)===true};
    const actual=kind==='status'?response.status:kind==='header'?response.headers.get(name):jsonValue(json,name);
    return { kind,name,passed:actual!==undefined && isDeepStrictEqual(actual,value) };
  });
  const responseHeaders = [...response.headers].map(([name,value])=>
    [name,responseSecrets.has(name)?'[redacted]':redact(value)]);
  const result={ status:response.status,headers:responseHeaders,assertions,body:redact(captured.body),
    truncated:captured.truncated,durationMs:Math.round(performance.now()-started),
    ...(cookieSession&&{cookies:cookieSession.info()}), ...(token&&{authenticated:'oauth-client-credentials'}) };
  if (request.graphql) {
    const graphqlResponse=!!json && typeof json==='object' && !Array.isArray(json) &&
      (Object.hasOwn(json,'data') || Array.isArray(json.errors));
    result.graphql={ kind:request.graphql,graphqlResponse,hasData:graphqlResponse && Object.hasOwn(json,'data'),
      errors:Array.isArray(json?.errors)?json.errors.length:0 };
  }
  return result;
}

module.exports = { splitRequests, requestAt, resolveRequest, sendRequest, jsonValue, jsonPathPattern };
