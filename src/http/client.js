'use strict';

const { isDeepStrictEqual } = require('node:util');

const maxDocumentBytes = 512 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const methods = new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const variable = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const controlledHeaders = new Set(['host','content-length','connection','transfer-encoding','expect','upgrade']);
const responseSecrets = new Set(['set-cookie','www-authenticate','proxy-authenticate','authentication-info']);
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
  const assertions = [];
  let requestLine, bodyStart = selected.source.length, marker = 0;
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
    const expectation = /^#\s*@expect\s+(.+)$/i.exec(content);
    if (expectation) {
      assertions.push(parseAssertion(expectation[1]));
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
      if (!methods.has(method)) throw Error('Start the request with a supported HTTP method and a URL.');
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
  if (headers.length>40 || assertions.length>32 || variables.size>64) throw Error('Use at most 40 headers, 32 assertions and 64 local variables.');
  const body = selected.source.slice(bodyStart);
  if (body && ['GET','HEAD'].includes(requestLine.method)) throw Error('GET and HEAD requests use no body.');
  return { ...requestLine, headers, body, assertions, variables, start:marker };
}

function parseAssertion(source) {
  const status = /^status\s+(\d{3})$/i.exec(source);
  if (status && Number(status[1])>=100 && Number(status[1])<=599) return { kind:'status',value:Number(status[1]) };
  const expression = /^(header|json)\s+([^\s]+)\s*==\s*(.+)$/i.exec(source);
  if (!expression) throw Error('Use status, header or JSON equality in @expect.');
  const kind = expression[1].toLowerCase(), name = expression[2];
  const valid = kind==='header' ? headerPattern.test(name) && !responseSecrets.has(name.toLowerCase())
    : /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]{0,5})\]){0,16}$/.test(name);
  if (!valid) throw Error('Select an observable response header or a simple JSON path.');
  let value;
  try { value=JSON.parse(expression[3]); } catch { throw Error('Use a JSON literal for equality assertions.'); }
  if (kind==='header' && typeof value!=='string') throw Error('Use a string when testing a response header.');
  return { kind,name,value };
}

async function resolveRequest(request, environment, readSecret) {
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
  try { url=new URL(expandedUrl); } catch { throw Error('Use a complete HTTP or HTTPS URL.'); }
  if (!['https:','http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash ||
      /[\r\n\t]|\{\{|\}\}/.test(expandedUrl)) throw Error('Use an HTTP or HTTPS URL without user information, fragments or unresolved variables.');
  const headers = {};
  for (const [name,value] of request.headers) {
    const resolved = await expand(value,true);
    if (/[\x00-\x1f\x7f]/.test(resolved) || bytes(resolved)>8192) throw Error('A request header has invalid characters or exceeds 8 KiB.');
    Object.defineProperty(headers,name,{value:resolved,enumerable:true});
  }
  const body = await expand(request.body,true);
  if (bytes(body)+bytes(JSON.stringify(headers))>maxDocumentBytes) throw Error('The expanded request exceeds 512 KiB.');
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
  return { method:request.method,url,headers,body,assertions:request.assertions,redact };
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

async function sendRequest(request, { signal,fetcher=fetch } = {}) {
  const started = performance.now();
  const timeout = AbortSignal.timeout(15000);
  const bounded = signal?AbortSignal.any([signal,timeout]):timeout;
  let response, captured;
  try {
    response=await fetcher(request.url,{
      method:request.method,headers:request.headers,body:request.body||undefined,
      redirect:'manual',signal:bounded
    });
    captured=await responseBody(response);
  } catch (error) {
    if (bounded.aborted) throw Error(signal?.aborted?'The HTTP request was cancelled.':'The HTTP request timed out.');
    throw Error('Unable to send the HTTP request or read its response.',{cause:error});
  }
  let json;
  if (!captured.truncated && request.assertions.some(item=>item.kind==='json')) {
    try { json=JSON.parse(captured.body); } catch { /* JSON assertions cannot pass on a non-JSON body. */ }
  }
  const assertions=request.assertions.map(({kind,name,value})=>{
    const actual=kind==='status'?response.status:kind==='header'?response.headers.get(name):jsonValue(json,name);
    return { kind,name,passed:actual!==undefined && isDeepStrictEqual(actual,value) };
  });
  const headers = [...response.headers].map(([name,value])=>
    [name,responseSecrets.has(name)?'[redacted]':request.redact(value)]);
  return { status:response.status,headers,assertions,body:request.redact(captured.body),
    truncated:captured.truncated,durationMs:Math.round(performance.now()-started) };
}

module.exports = { requestAt, resolveRequest, sendRequest };
