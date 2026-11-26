'use strict';

const { maximumWatchPaths } = require('./ssh-workspace');

function createSshFileWatch({ connection, notify, interval = 3000 }) {
  const paths = new Map();
  let timer, generation = 0, running = false;

  function schedule(delay = interval) {
    if (timer || running || !paths.size || !connection()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void observe();
    }, delay);
    timer.unref();
  }

  async function observe() {
    const client = connection();
    if (!client || !paths.size) return;
    const current = generation;
    const entries = [...paths.values()];
    const changes = [];
    running = true;
    try {
      const snapshot = await client.observe(entries.map(entry => entry.uri.path));
      if (current !== generation || client !== connection()) return;
      for (const [index,entry] of entries.entries()) {
        const seen = snapshot[index];
        if (paths.get(entry.key) !== entry || seen === false) continue;
        const previous = entry.state;
        entry.state = seen;
        if (previous === undefined || previous?.stamp === seen?.stamp) continue;
        const type = seen === null ? 'deleted' : previous === null ? 'created' : 'changed';
        changes.push({ uri:entry.uri, type });
      }
      if (changes.length) notify(changes);
    } catch { /* Preserve the previous observations across transient SSH errors. */ }
    finally {
      running = false;
      schedule();
    }
  }

  function watch(uri) {
    const key = uri.toString();
    let entry = paths.get(key);
    if (!entry && paths.size < maximumWatchPaths) {
      entry = { uri, key, count:0, state:undefined };
      paths.set(key,entry);
    }
    if (!entry) return { dispose() {} };
    entry.count++;
    schedule(0);
    return { dispose() {
      if (!entry) return;
      if (paths.get(key) === entry && --entry.count === 0) paths.delete(key);
      entry = undefined;
      if (!paths.size) {
        clearTimeout(timer);
        timer = undefined;
      }
    } };
  }

  function reset() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    paths.clear();
  }

  return { watch, reset };
}

module.exports = { createSshFileWatch };
