'use strict';
const http = require('node:http');
const https = require('node:https');
const { validateRuntimeUrl } = require('../spring/runtime-client');

class ObserverError extends Error { constructor(code, message) { super(message); this.code = code; } }
const emptySnapshot = () => ({ state: 'disconnected', factories: [], events: [], fetchedAt: null, sameSourceRevisionVerified: false });
function normalize(value, token) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ObserverError('INVALID_SCHEMA', 'Observer must return a JSON object.');
  let nodes = 0;
  function copy(item, depth) {
    if (++nodes > 70000 || depth > 18) throw new ObserverError('INVALID_SCHEMA', 'Observer metadata exceeds the structural limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (typeof item === 'string') return item.split(token).join('[REDACTED]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 16384);
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
        response.on('end', () => { if (done) return; try { finish(null, normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.#token)); } catch (error) { finish(error instanceof ObserverError ? error : new ObserverError('INVALID_JSON','Observer returned invalid JSON.')); } finally { chunks=[]; } });
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
  dispose() { this.#disposed=true; for (const request of this.#requests) request.destroy(); this.#requests.clear(); }
}
module.exports = {ObserverClient,ObserverError,emptySnapshot,normalize};
