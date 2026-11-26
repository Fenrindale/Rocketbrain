'use strict';

const storage = 'rocketbrain.sqlFileProfiles.v1';
const maximum = 128;
const validKey = key => typeof key === 'string' && key.length <= 4096 && key.startsWith('file:');
const validRoute = route => route && typeof route.id === 'string' && /^[a-f\d-]{36}$/i.test(route.id) &&
  typeof route.key === 'string' && /^[a-f\d]{64}$/.test(route.key) &&
  typeof route.label === 'string' && route.label.length > 0 && route.label.length <= 200 && !/[\r\n]/.test(route.label);

function createSqlFileProfiles(state) {
  const saved = state.get(storage, []);
  const routes = new Map((Array.isArray(saved) ? saved.slice(0, maximum) : [])
    .filter(row => Array.isArray(row) && row.length === 2 && validKey(row[0]) && validRoute(row[1])));
  const pending = new Set();
  let writes = Promise.resolve();

  function set(uri, route) {
    const key = uri?.toString();
    if (!validKey(key) || route !== undefined && !validRoute(route)) throw Error('Select a local SQL file and a valid saved profile.');
    if (pending.has(key)) throw Error('A database profile change for this file is already in progress.');
    pending.add(key);
    const write = writes.then(async () => {
      const next = new Map(routes);
      if (route) next.set(key, { id: route.id, key: route.key, label: route.label });
      else next.delete(key);
      if (next.size > maximum) throw Error('Remove an unused SQL file association before adding another.');
      await state.update(storage, [...next]);
      if (route) routes.set(key, next.get(key));
      else routes.delete(key);
    }).finally(() => pending.delete(key));
    writes = write.catch(() => {});
    return write;
  }

  return { set, get: uri => routes.get(uri?.toString()), busy: uri => pending.has(uri?.toString()) };
}

module.exports = { createSqlFileProfiles };
