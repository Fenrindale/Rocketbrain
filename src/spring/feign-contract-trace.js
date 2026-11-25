'use strict';

const verbs = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);
const bounded = (value, max) => Array.isArray(value) && value.length <= max;
const symbol = value => typeof value === 'string' && value===value.trim() && /^[A-Za-z0-9_.$]{1,192}$/.test(value);
const type = value => typeof value === 'string' && value===value.trim() && value.length <= 192 && /^[A-Za-z0-9_.$]+(?:\[\])*$/.test(value);
const route = value => typeof value === 'string' && value===value.trim() && /^\/[A-Za-z0-9_./~{}%:+*()\-]{0,511}$/.test(value) && !value.startsWith('//');
const count = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw Error('Invalid OpenFeign contract metadata.'); };

function normalizeFeignContracts(raw) {
  if (raw?.schemaVersion !== 1 || typeof raw.enabled !== 'boolean' ||
      !(raw.enabled ? ['waiting','ready','unsupported'] : ['disabled']).includes(raw.state) ||
      !count(raw.dropped) || !bounded(raw.clients,32) ||
      raw.state !== 'ready' && (raw.dropped || raw.clients.length)) invalid();
  return { schemaVersion:1, enabled:raw.enabled, state:raw.state, dropped:raw.dropped, clients:raw.clients.map(client=>{
    if (!symbol(client?.client) || !symbol(client.contract) || typeof client.basePathObserved !== 'boolean' ||
        !count(client.unavailable) || !bounded(client.methods,64)) invalid();
    const { client:clientType,contract,basePathObserved,unavailable }=client;
    return { client:clientType,contract,basePathObserved,unavailable, methods:client.methods.map(method=>{
      if (!symbol(method?.declaration) || !symbol(method.name) || method.inherited !== (method.declaration !== clientType) ||
          !bounded(method.parameters,16) || !method.parameters.every(type) || !verbs.has(method.verb) || !route(method.template) ||
          method.path !== null && (!basePathObserved || !route(method.path))) invalid();
      const {declaration,name,inherited,verb,template,path}=method;
      return {declaration,name,parameters:[...method.parameters],inherited,verb,template,path};
    })};
  })};
}

module.exports={normalizeFeignContracts};
