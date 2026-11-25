'use strict';
const http = require('node:http');
const https = require('node:https');
const { validateRuntimeUrl } = require('../spring/runtime-client');

class ObserverError extends Error { constructor(code, message) { super(message); this.code = code; } }
const consoleTypes = new Set(['java.lang.String','java.lang.Long','java.lang.Integer','java.lang.Short','java.lang.Byte','java.lang.Boolean',
  'java.lang.Double','java.lang.Float','java.math.BigDecimal','java.math.BigInteger','java.time.LocalDate','java.time.LocalTime',
  'java.time.LocalDateTime','java.time.Instant','java.util.UUID']);
const consoleKey = /^(:[A-Za-z_][A-Za-z0-9_]{0,63}|\?(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-6]))$/;

function consoleInput(query,factoryId) {
  if (typeof query!=='string' || !query.trim() || query.length>4096 || Buffer.byteLength(query)>16384 || query.includes('\0'))
    throw new ObserverError('INVALID_QUERY','Use a JPQL SELECT of at most 4,096 characters.');
  if (typeof factoryId!=='string' || !/^factory-[1-9]\d{0,15}$/.test(factoryId))
    throw new ObserverError('INVALID_FACTORY','Select an explicit observed persistence factory.');
}

function consoleResponse(result,factoryId,state,limit=100) {
  const invalid = () => { throw new ObserverError('INVALID_SCHEMA','Observer returned invalid JPQL console metadata.'); };
  if (['rejected','failed'].includes(result.state)) {
    if (typeof result.code!=='string' || !/^[a-z_]{1,64}$/.test(result.code)) return invalid();
    return {state:result.state,code:result.code};
  }
  if (result.state!==state || result.factoryId!==factoryId || !Array.isArray(result.columns) || !result.columns.length ||
      result.columns.length>16 || result.columns.some(item=>!item || !consoleTypes.has(item.javaType) ||
      (item.alias!==undefined && (typeof item.alias!=='string' || item.alias.length>256)))) return invalid();
  const columns=result.columns.map(({alias,javaType})=>({alias:alias||null,javaType}));
  if (state==='described') {
    if (result.sqlExecuted!==false || !Array.isArray(result.parameters) || result.parameters.length>16 ||
        result.parameters.some(item=>!item || typeof item.key!=='string' || !consoleKey.test(item.key) || !consoleTypes.has(item.javaType)) ||
        new Set(result.parameters.map(item=>item.key)).size!==result.parameters.length) return invalid();
    return {state,factoryId,columns,parameters:result.parameters.map(({key,javaType})=>({key,javaType})),sqlExecuted:false};
  }
  if (result.sqlExecuted!==true || result.queryExecuted!==true || result.databaseReadOnlyTransaction!==true ||
      result.boundParameterValuesRetained!==false || result.rolledBack!==true ||
      !Array.isArray(result.rows) || result.rows.length>limit || result.rowCount!==result.rows.length ||
      typeof result.hasMore!=='boolean' || result.rows.some(row=>!Array.isArray(row) || row.length!==columns.length ||
        row.some((value,index)=>value!==null && (columns[index].javaType==='java.lang.Boolean'
          ? typeof value!=='boolean' : typeof value!=='string' || value.length>4096)))) return invalid();
  return {state,factoryId,columns,rows:result.rows,rowCount:result.rowCount,hasMore:result.hasMore,sqlExecuted:true,
    databaseReadOnlyTransaction:true,rolledBack:true,boundParameterValuesRetained:false};
}
const emptySnapshot = () => ({ state: 'disconnected', factories: [], events: [], fetchedAt: null, sameSourceRevisionVerified: false });
function normalize(value, token, stripControls=true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ObserverError('INVALID_SCHEMA', 'Observer must return a JSON object.');
  let nodes = 0;
  function copy(item, depth) {
    if (++nodes > 70000 || depth > 18) throw new ObserverError('INVALID_SCHEMA', 'Observer metadata exceeds the structural limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (typeof item === 'string') {
      const redacted=item.split(token).join('[REDACTED]');
      return (stripControls?redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,''):redacted).slice(0,16384);
    }
    if (Array.isArray(item)) { if (item.length > 6000) throw new ObserverError('INVALID_SCHEMA', 'Observer list exceeds the limit.'); return item.map(v => copy(v, depth + 1)); }
    if (item && typeof item === 'object') {
      const result = Object.create(null), entries = Object.entries(item);
      if (entries.length > 2000) throw new ObserverError('INVALID_SCHEMA', 'Observer object exceeds the limit.');
      for (const [key, child] of entries) if (!['__proto__', 'constructor', 'prototype', 'token', 'authorization', 'parameterValues', 'bindings'].includes(key)) result[key.slice(0, 250)] = copy(child, depth + 1);
      return result;
    }
    return null;
  }
  return JSON.parse(JSON.stringify(copy(value, 0)));
}
class ObserverClient {
  #target; #token; #timeout; #limit; #requests = new Set(); #disposed = false;
  constructor({url, token, timeoutMs = 5000, maxResponseBytes = 2 * 1024 * 1024}) {
    this.#target = validateRuntimeUrl(url);
    if (this.#target.url.pathname !== '/') throw new ObserverError('INVALID_URL', 'Use the observer base URL without a path.');
    if (typeof token !== 'string' || !/^[\x21-\x7e]{32,128}$/.test(token)) throw new ObserverError('INVALID_TOKEN', 'Use the private observer token (32–128 characters).');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 4*1024*1024) throw new ObserverError('INVALID_OPTIONS', 'Invalid observer timeout or response limit.');
    this.#token = token; this.#timeout = timeoutMs; this.#limit = maxResponseBytes;
  }
  async #request(endpoint, body) {
    if (this.#disposed) throw new ObserverError('DISPOSED', 'Observer connection is closed.');
    const {url, address, hostname} = this.#target;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    return new Promise((resolve, reject) => {
      let done = false, timer, size = 0, chunks = [];
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); this.#requests.delete(request); error ? reject(error) : resolve(value); };
      const request = (url.protocol === 'https:' ? https : http).request({protocol:url.protocol,hostname:address,port:url.port || (url.protocol === 'https:' ? 443 : 80),servername:hostname,path:'/'+endpoint,method:payload?'POST':'GET',agent:false,rejectUnauthorized:true,
        headers:{Host:url.host,Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+this.#token,...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}}, response => {
        if (response.statusCode !== 200) { finish(new ObserverError(response.statusCode >= 300 && response.statusCode < 400 ? 'REDIRECT_BLOCKED' : response.statusCode === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR', 'Observer returned HTTP '+response.statusCode+'.')); response.destroy(); return; }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' || Number(response.headers['content-length']) > this.#limit) { finish(new ObserverError('RESPONSE_LIMIT', 'Observer response exceeds the allowed format or size.')); response.destroy(); return; }
        response.on('data', bytes => { size += bytes.length; if (size > this.#limit) { finish(new ObserverError('RESPONSE_LIMIT', 'Observer response exceeds the size limit.')); response.destroy(); } else chunks.push(bytes); });
        response.on('aborted', () => finish(new ObserverError('ABORTED','Observer response was interrupted.')));
        response.on('error', () => finish(new ObserverError('RESPONSE_ERROR','Observer response could not be read.')));
        response.on('end', () => { if (done) return; try { finish(null, normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.#token,endpoint!=='console/select')); } catch (error) { finish(error instanceof ObserverError ? error : new ObserverError('INVALID_JSON','Observer returned invalid JSON.')); } finally { chunks=[]; } });
      });
      this.#requests.add(request);
      timer = setTimeout(() => { finish(new ObserverError('TIMEOUT','Observer request timed out.')); request.destroy(); }, this.#timeout);
      request.on('error', () => finish(new ObserverError('CONNECTION_ERROR','Could not connect to the local observer.')));
      request.once('close', () => { if (!done) finish(new ObserverError('DISPOSED','Observer request closed.')); });
      request.end(payload);
    });
  }
  async refresh() {
    const result = await this.#request('snapshot');
    if (!Array.isArray(result.factories) || !Array.isArray(result.events)) throw new ObserverError('INVALID_SCHEMA','Observer snapshot is missing factories or events.');
    return {...result,state:result.factories.length?'observed':'waiting',fetchedAt:new Date().toISOString(),sameSourceRevisionVerified:false};
  }
  async validate(query, factoryId) {
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 16384 || query.includes('\0')) throw new ObserverError('INVALID_QUERY','Select a query of at most 16 KiB.');
    if (factoryId !== undefined && (typeof factoryId !== 'string' || factoryId.length > 128)) throw new ObserverError('INVALID_FACTORY','Invalid factory identifier.');
    const result = await this.#request('validate',{query,...(factoryId?{factoryId}:{})});
    if (!['known','invalid','unknown'].includes(result.state)) throw new ObserverError('INVALID_SCHEMA','Observer validation has no supported result state.');
    return {...result,observedAt:new Date().toISOString(),sameSourceRevisionVerified:false};
  }
  async describeSelect(query,factoryId) {
    consoleInput(query,factoryId);
    return consoleResponse(await this.#request('console/describe',{query,factoryId}),factoryId,'described');
  }
  async select(query,factoryId,values,limit=100) {
    consoleInput(query,factoryId);
    if (!Number.isInteger(limit) || limit<1 || limit>100 || !values || typeof values!=='object' || Array.isArray(values))
      throw new ObserverError('INVALID_BINDINGS','Use named or positional bindings and a row limit from 1 to 100.');
    const entries=Object.entries(values), payload={query,factoryId,values:Object.fromEntries(entries),limit};
    if (entries.length>16 || entries.some(([key,value])=>!consoleKey.test(key) ||
        (value!==null && (typeof value!=='string' || value.length>1024 || value.includes('\0')))) ||
        Buffer.byteLength(JSON.stringify(payload))>32768)
      throw new ObserverError('INVALID_BINDINGS','Use at most 16 short text or NULL parameter bindings.');
    const result=await this.#request('console/select',payload);
    return consoleResponse(result,factoryId,'executed',limit);
  }
  dispose() { this.#disposed=true; for (const request of this.#requests) request.destroy(); this.#requests.clear(); }
}
module.exports = {ObserverClient,ObserverError,emptySnapshot,normalize};
