'use strict';
const http = require('node:http');
const https = require('node:https');

const ENDPOINTS = Object.freeze(['beans', 'conditions', 'configprops', 'env', 'mappings']);
class RuntimeError extends Error { constructor(code, message, status) { super(message); this.name = 'SpringRuntimeError'; this.code = code; if (status) this.status = status; } }
function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new RuntimeError('INVALID_OPTIONS', `${label} must be between ${minimum} and ${maximum}.`);
  return number;
}
function validateRuntimeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new RuntimeError('INVALID_URL', 'Use an Actuator URL of at most 2048 characters.');
  let url; try { url = new URL(value); } catch { throw new RuntimeError('INVALID_URL', 'Enter a valid loopback Actuator base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RuntimeError('INVALID_URL', 'Use an HTTP(S) Actuator URL without credentials, query or fragment.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname !== 'localhost' && hostname !== '::1' && !/^127(?:\.\d{1,3}){3}$/.test(hostname)) throw new RuntimeError('NON_LOOPBACK', 'Runtime observation currently supports loopback development applications only.');
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new RuntimeError('INVALID_URL', 'Use a port between 1 and 65535.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return { url, hostname, address: hostname === 'localhost' ? '127.0.0.1' : hostname };
}
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
function safeText(value, redactor, maximum = 1000) { return typeof value === 'string' ? redactor(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maximum) : ''; }
function secretRedactor(authorization = '') {
  const secrets = authorization ? [authorization] : [];
  if (authorization.startsWith('Bearer ')) secrets.push(authorization.slice(7));
  if (authorization.startsWith('Basic ')) {
    try { const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8'); const colon = decoded.indexOf(':'); if (colon >= 0) secrets.push(decoded.slice(colon + 1)); secrets.push(authorization.slice(6)); } catch { /* Invalid Basic credentials are rejected by the application. */ }
  }
  return text => {
    let result = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1[REDACTED]@').replace(/([?&](?:password|secret|token|key|authorization)=)[^\s&]*/gi, '$1[REDACTED]');
    for (const secret of secrets.filter(Boolean)) { if (result === secret) result = '[REDACTED]'; else if (secret.length >= 4) result = result.split(secret).join('[REDACTED]'); }
    return result;
  };
}
function propertyPaths(value, redactor, prefix = '', depth = 0, result = []) {
  if (depth > 12 || result.length >= 5000) return result;
  const entries = Array.isArray(value) ? value.slice(0, 100).map((item, index) => [String(index), item]) : Object.entries(object(value)).slice(0, 5000);
  for (const [key, item] of entries) {
    if (result.length >= 5000) break;
    const name = prefix ? prefix + '.' + safeText(key, redactor, 250) : safeText(key, redactor, 250);
    if (item && typeof item === 'object' && Object.keys(item).length) propertyPaths(item, redactor, name, depth + 1, result);
    else result.push(name);
  }
  return result;
}

function normalizeEndpoint(endpoint, payload, redactor = text => text) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (endpoint === 'env' ? !Array.isArray(payload.propertySources) : !payload.contexts || typeof payload.contexts !== 'object' || Array.isArray(payload.contexts))) throw new RuntimeError('INVALID_SCHEMA', 'Unsupported Actuator response shape.');
  const contexts = Object.entries(object(payload?.contexts)).slice(0, 100);
  const text = value => safeText(value, redactor);
  if (endpoint === 'beans') return contexts.map(([id, context]) => ({
    id: text(id), parentId: text(context.parentId) || null,
    beans: Object.entries(object(context.beans)).slice(0, 10000).map(([name, bean]) => ({ name: text(name), aliases: list(bean.aliases).slice(0, 100).map(text), type: text(bean.type), scope: text(bean.scope), dependencies: list(bean.dependencies).slice(0, 1000).map(text), observed: true }))
  }));
  if (endpoint === 'conditions') {
    const result = [];
    for (const [id, context] of contexts) {
      for (const [source, values] of Object.entries(object(context.positiveMatches)).slice(0, 10000)) for (const value of list(values).slice(0, 100)) result.push({ context: text(id), source: text(source), condition: text(value.condition), matched: true });
      for (const [source, values] of Object.entries(object(context.negativeMatches)).slice(0, 10000)) {
        for (const value of list(values.notMatched).slice(0, 100)) result.push({ context: text(id), source: text(source), condition: text(value.condition), matched: false });
        for (const value of list(values.matched).slice(0, 100)) result.push({ context: text(id), source: text(source), condition: text(value.condition), matched: true });
      }
    }
    return result.slice(0, 20000);
  }
  if (endpoint === 'configprops') return contexts.flatMap(([id, context]) => Object.entries(object(context.beans)).slice(0, 5000).map(([name, bean]) => ({ context: text(id), bean: text(name), prefix: text(bean.prefix), keys: propertyPaths(bean.properties, redactor) })));
  if (endpoint === 'env') return { activeProfiles: list(payload?.activeProfiles).slice(0, 100).map(text), defaultProfiles: list(payload?.defaultProfiles).slice(0, 100).map(text), sources: list(payload?.propertySources).slice(0, 1000).map(source => ({ name: text(source.name), keys: Object.keys(object(source.properties)).slice(0, 5000).map(text) })) };
  if (endpoint === 'mappings') {
    const result = [];
    for (const [id, context] of contexts) {
      const mappings = object(context.mappings);
      for (const group of [mappings.dispatcherServlets, mappings.dispatcherHandlers]) for (const handlers of Object.values(object(group))) for (const item of list(handlers).slice(0, 10000)) {
        const detail = object(item.details), conditions = object(detail.requestMappingConditions), handler = object(detail.handlerMethod);
        if (!list(conditions.patterns).length) continue;
        result.push({ context: text(id), methods: list(conditions.methods).slice(0, 20).map(text), paths: list(conditions.patterns).slice(0, 100).map(text), handlerType: text(handler.className), handlerMethod: text(handler.name), observed: true });
      }
    }
    return result.slice(0, 10000);
  }
  throw new RuntimeError('INVALID_ENDPOINT', 'Unsupported Actuator observation endpoint.');
}

function emptySnapshot() {
  return { state: 'disconnected', baseUrl: null, fetchedAt: null, endpoints: {}, contexts: [], conditions: [], configurationProperties: [], environment: { activeProfiles: [], defaultProfiles: [], sources: [] }, mappings: [], counts: { beans: 0, conditions: 0, configurationProperties: 0, propertyKeys: 0, mappings: 0 }, privacy: { propertyValuesRetained: false, conditionMessagesRetained: false, rawResponsesRetained: false }, limitations: ['Point-in-time GET observations; missing/lazy Beans and inaccessible endpoints are not proof of absence.', 'Property values, origins, raw condition messages and raw mapping predicates are discarded.'] };
}

class ActuatorClient {
  #authorization; #target; #options; #snapshot; #requests = new Set(); #disposed = false; #refreshing;
  constructor(options) {
    this.#target = validateRuntimeUrl(options.url);
    this.#authorization = options.authorization || '';
    if (this.#authorization && (!/^(?:Bearer \S[^\r\n]*|Basic [A-Za-z0-9+/]+=*)$/.test(this.#authorization) || /[^\x20-\x7e]/.test(this.#authorization) || this.#authorization.length > 8192)) throw new RuntimeError('INVALID_AUTH', 'Use valid Bearer or Basic credentials without line breaks.');
    this.#options = { timeoutMs: boundedInteger(options.timeoutMs, 5000, 100, 30000, 'Timeout'), maxResponseBytes: boundedInteger(options.maxResponseBytes, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024, 'Response limit') };
    this.#snapshot = emptySnapshot(); this.#snapshot.baseUrl = this.#target.url.toString().replace(/\/$/, '');
  }
  snapshot() { return structuredClone(this.#snapshot); }
  async #request(endpoint) {
    if (this.#disposed) throw new RuntimeError('DISPOSED', 'Runtime connection is closed.');
    const target = this.#target, url = target.url;
    return new Promise((resolve, reject) => {
      let finished = false, bytes = 0, chunks = [], timer;
      const fail = error => { if (finished) return; finished = true; clearTimeout(timer); this.#requests.delete(request); reject(error); };
      const headers = { Accept: 'application/vnd.spring-boot.actuator.v3+json, application/json', 'Accept-Encoding': 'identity', Host: url.host };
      if (this.#authorization) headers.Authorization = this.#authorization;
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request({ protocol: url.protocol, hostname: target.address, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: (url.pathname === '/' ? '' : url.pathname) + '/' + endpoint, method: 'GET', headers, agent: false, servername: target.hostname, rejectUnauthorized: true }, response => {
        const status = response.statusCode;
        if (status >= 300 && status < 400) { response.destroy(); fail(new RuntimeError('REDIRECT_BLOCKED', 'Actuator redirects are not followed.', status)); return; }
        if (status !== 200) { response.destroy(); fail(new RuntimeError(status === 401 || status === 403 ? 'AUTH_REQUIRED' : status === 404 ? 'NOT_EXPOSED' : 'HTTP_ERROR', `Actuator ${endpoint} returned HTTP ${status}.`, status)); return; }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); fail(new RuntimeError('ENCODING_UNSUPPORTED', 'Compressed Actuator responses are not accepted.')); return; }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > this.#options.maxResponseBytes) { response.destroy(); fail(new RuntimeError('RESPONSE_TOO_LARGE', 'Actuator response exceeds the configured limit.')); return; }
        response.on('data', chunk => { bytes += chunk.length; if (bytes > this.#options.maxResponseBytes) { fail(new RuntimeError('RESPONSE_TOO_LARGE', 'Actuator response exceeds the configured limit.')); response.destroy(); request.destroy(); } else chunks.push(chunk); });
        response.on('aborted', () => fail(new RuntimeError('RESPONSE_ABORTED', 'Actuator response ended before completion.')));
        response.on('error', () => fail(new RuntimeError('RESPONSE_ERROR', 'Actuator response could not be read.')));
        response.on('end', () => {
          if (finished) return;
          let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(new RuntimeError('INVALID_JSON', 'Actuator did not return a valid JSON response.')); return; }
          chunks = [];
          let normalized; try { normalized = normalizeEndpoint(endpoint, json, secretRedactor(this.#authorization)); } catch { fail(new RuntimeError('INVALID_SCHEMA', 'Actuator JSON could not be normalized.')); return; }
          finished = true; clearTimeout(timer); this.#requests.delete(request); resolve(normalized);
        });
      });
      this.#requests.add(request);
      timer = setTimeout(() => { fail(new RuntimeError('TIMEOUT', 'Actuator observation timed out.')); request.destroy(); }, this.#options.timeoutMs);
      request.on('error', error => fail(new RuntimeError(error.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : 'CONNECTION_ERROR', 'Could not connect to the loopback Actuator endpoint.')));
      request.end();
    });
  }
  async refresh() {
    if (this.#disposed) throw new RuntimeError('DISPOSED', 'Runtime connection is closed.');
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const next = emptySnapshot(); next.baseUrl = this.#snapshot.baseUrl; next.state = 'connecting';
      const results = await Promise.allSettled(ENDPOINTS.map(endpoint => this.#request(endpoint)));
      let available = 0;
      for (let i = 0; i < ENDPOINTS.length; i++) {
        const endpoint = ENDPOINTS[i], result = results[i];
        if (result.status === 'fulfilled') {
          available++; next.endpoints[endpoint] = { state: 'available' };
          if (endpoint === 'beans') next.contexts = result.value;
          else if (endpoint === 'conditions') next.conditions = result.value;
          else if (endpoint === 'configprops') next.configurationProperties = result.value;
          else if (endpoint === 'env') next.environment = result.value;
          else next.mappings = result.value;
        } else next.endpoints[endpoint] = { state: 'unavailable', code: result.reason.code || 'OBSERVATION_FAILED', ...(result.reason.status ? { status: result.reason.status } : {}) };
      }
      next.state = available === ENDPOINTS.length ? 'connected' : available ? 'partial' : 'error'; next.fetchedAt = new Date().toISOString();
      next.counts = { beans: next.contexts.reduce((count, context) => count + context.beans.length, 0), conditions: next.conditions.length, configurationProperties: next.configurationProperties.length, propertyKeys: new Set(next.environment.sources.flatMap(source => source.keys)).size, mappings: next.mappings.length };
      if (!this.#disposed) this.#snapshot = next;
      return this.snapshot();
    })();
    try { return await this.#refreshing; } finally { this.#refreshing = null; }
  }
  dispose() { this.#disposed = true; this.#authorization = ''; for (const request of this.#requests) request.destroy(); this.#requests.clear(); this.#snapshot = emptySnapshot(); }
}

function compareRuntime(staticModel, snapshot) {
  const runtimeBeans = snapshot.contexts.flatMap(context => context.beans.map(bean => ({ ...bean, context: context.id })));
  const beansAvailable = snapshot.endpoints.beans?.state === 'available';
  const local = staticModel?.beans || [], matched = new Set();
  const beans = local.map(bean => {
    const hits = runtimeBeans.filter(observed => observed.name === bean.name || bean.aliases?.includes(observed.name) || observed.aliases.some(alias => bean.aliases?.includes(alias)));
    for (const hit of hits) matched.add(hit.context + '\0' + hit.name);
    return { name: bean.name, staticId: bean.id, staticState: bean.state, staticType: bean.type, source: { uri: bean.uri, range: bean.range }, observation: !beansAvailable ? 'unknown' : hits.length ? 'present' : 'not-observed', runtime: hits.map(hit => ({ context: hit.context, name: hit.name, type: hit.type, scope: hit.scope, observed: true })), note: hits.length ? 'Observed in the connected context; static state is preserved.' : 'Not observed is not proof of absence: context, profile, lazy registration or endpoint access may differ.' };
  });
  for (const bean of runtimeBeans.filter(bean => !matched.has(bean.context + '\0' + bean.name))) beans.push({ name: bean.name, staticId: null, staticState: 'unmodeled', observation: 'runtime-only', runtime: [{ context: bean.context, name: bean.name, type: bean.type, scope: bean.scope, observed: true }], note: 'Runtime-only may include framework, dynamic, factory or dependency registration; cause is not inferred from the name.' });
  return { mode: 'static-runtime-comparison', matchBasis: 'bean-name-or-alias', sameSourceRevisionVerified: false, observedAt: snapshot.fetchedAt, staticRevision: staticModel?.revision ?? null, runtimeState: snapshot.state, beans, summary: { present: beans.filter(bean => bean.observation === 'present').length, notObserved: beans.filter(bean => bean.observation === 'not-observed').length, runtimeOnly: beans.filter(bean => bean.observation === 'runtime-only').length, unknown: beans.filter(bean => bean.observation === 'unknown').length }, limitations: ['Observations do not overwrite static conditions or imply the connected application matches the open source revision.', 'Factory products/proxies are reported as the Actuator endpoint describes them; no arbitrary Java evaluation is performed.'] };
}

module.exports = { ActuatorClient, RuntimeError, validateRuntimeUrl, normalizeEndpoint, compareRuntime, emptySnapshot, ENDPOINTS };
