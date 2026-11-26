'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSqlFileProfiles } = require('../src/db/sql-file-profiles');

test('SQL file associations persist only named route intent and serialize distinct writes', async () => {
  const values = new Map();
  const state = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, structuredClone(value)) };
  const route = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', key: 'b'.repeat(64), label: 'Local MySQL', password: 'fixture-forbidden' };
  const left = 'file:///workspace/left.sql', right = 'file:///workspace/right.sql';
  const store = createSqlFileProfiles(state);
  const first = store.set(left, route), second = store.set(right, { ...route, label: 'Local MariaDB' });
  assert.equal(store.busy(left), true);
  assert.throws(() => store.set(left), /already in progress/);
  await Promise.all([first, second]);
  const reopened = createSqlFileProfiles(state);
  assert.deepEqual(reopened.get(left), { id: route.id, key: route.key, label: route.label });
  assert.equal(reopened.get(right).label, 'Local MariaDB');
  assert.equal(store.busy(left), false);
  await reopened.set(left);
  assert.equal(createSqlFileProfiles(state).get(left), undefined);
  assert.match(JSON.stringify([...values]), /MariaDB/);
  assert.doesNotMatch(JSON.stringify([...values]), /fixture-forbidden|sessionId/);
});

test('a workspace state failure preserves the prior guarded route', async () => {
  const file = 'file:///workspace/left.sql';
  const route = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', key: 'b'.repeat(64), label: 'Local MySQL' };
  const store = createSqlFileProfiles({ get: () => [[file, route]], update: async () => { throw Error('Storage unavailable'); } });
  await assert.rejects(store.set(file), /Storage unavailable/);
  assert.deepEqual(store.get(file), route);
  assert.equal(store.busy(file), false);
});
