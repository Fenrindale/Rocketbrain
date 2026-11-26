'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createAcpCheckpointStore } = require('../src/ai/acp-checkpoints');

const agent = { adapter: 'opencode-local', executable: '/owned/openCode', sha256: 'fixture', args: ['acp','--pure'],
  localModel: { endpoint: 'http://127.0.0.1:30200/v1/chat/completions', model: 'test' } };
const secretPrompt = 'owned private fixture prompt';

async function workspace() {
  const parent = await fs.realpath(os.tmpdir()), location = await fs.mkdtemp(path.join(parent, 'rb-acp-checkpoint-unit-'));
  const values = new Map();
  const secrets = { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); } };
  const base = path.join(location, 'acp-checkpoints-v1');
  return { location, base, values, secrets, async clean() {
    const real = await fs.realpath(location);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-acp-checkpoint-unit-/);
    await fs.rm(real,{ recursive: true, maxRetries: 6, retryDelay: 150 });
  } };
}

async function peer(_agent, { folder, text, sessionId, onStarted }) {
  await onStarted(process.pid);
  const database = path.join(folder, 'opencode');
  await fs.mkdir(database, { recursive: true });
  const file = path.join(database, 'opencode.db');
  const previous = sessionId && await fs.readFile(file, 'utf8');
  await fs.writeFile(file, [previous, text].filter(Boolean).join('\n'));
  return { stopReason: 'end_turn', output: 'Reviewed ' + text,
    recovery: { sessionId: 'owned-acp-peer-session', resumed: Boolean(sessionId), replay: previous ? [{ role: 'user', text: previous }] : [] } };
}

test('saved snapshots authenticate against workspace and session, and failed turns preserve the prior encrypted bytes', async () => {
  const fixture = await workspace();
  try {
    const options = { location: fixture.location, scope: 'owned-workspace', secrets: fixture.secrets };
    const store = createAcpCheckpointStore(options);
    const first = await store.create({ label: 'Owned session', input: secretPrompt, agent }, peer);
    assert.equal(first.turns, 1);
    const dir = path.join(fixture.base, first.id), target = path.join(dir, 'session.v1.enc');
    const checkpoint = await fs.readFile(target);
    assert.deepEqual(await fs.readdir(dir), ['session.v1.enc']);
    assert.ok(!checkpoint.includes(secretPrompt) && !checkpoint.includes('owned-acp-peer-session'));
    const [storedSecret] = fixture.values.values();
    assert.match(storedSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await store.list())[0].id, first.id);
    const wrongScope = createAcpCheckpointStore({ ...options, scope: 'other-owned-workspace', secrets: { get: async () => storedSecret } });
    await assert.rejects(wrongScope.list(), /cannot be authenticated/);
    await assert.rejects(store.continue(first.id,{ input: 'wrong model', agent: { ...agent, sha256: 'different' } }, peer), /executable or loopback model changed/);
    await assert.rejects(store.continue(first.id,{ input: 'fail-turn', agent }, async (...args) => {
      await peer(...args);
      throw Error('deliberate stopped fixture');
    }), /deliberate stopped/);
    assert.deepEqual(await fs.readFile(target), checkpoint);
    assert.deepEqual(await fs.readdir(dir), ['session.v1.enc']);
    const modified = Buffer.from(checkpoint);
    modified[modified.length - 1] ^= 1;
    await fs.writeFile(target, modified);
    await assert.rejects(store.list(), /cannot be authenticated/);
    await fs.writeFile(target, checkpoint);
    const second = await store.continue(first.id, { input: 'continue', agent, expected: first }, peer);
    assert.equal(second.turns, 2);
    assert.equal(second.replay[0].text, secretPrompt);
    await assert.rejects(store.continue(first.id, { input: 'stale', agent, expected: first }, peer), /changed after review/);
    await store.remove(first.id);
    assert.deepEqual(await store.list(), []);
  } finally { await fixture.clean(); }
});

test('active owners block another turn and abandoned transient plaintext is reclaimed without deleting a checkpoint', async () => {
  const fixture = await workspace();
  try {
    const store = createAcpCheckpointStore({ location: fixture.location, scope: 'scope', secrets: fixture.secrets });
    const first = await store.create({ label: 'Owned session', input: secretPrompt, agent }, peer);
    const target = path.join(fixture.base, first.id, 'session.v1.enc'), before = await fs.readFile(target);
    const lock = path.join(fixture.base, 'active.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, phase: 'idle' }), { flag: 'wx' });
    await assert.rejects(store.continue(first.id, { agent, input: 'busy' }, peer), /currently in use/);
    await assert.rejects(store.recoverAbandonedLease(), /still in use/);
    const deadPid = Number(execFileSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{ encoding:'utf8',windowsHide:true }));
    await fs.writeFile(lock, JSON.stringify({ pid: deadPid, phase: 'peer', peerPid: deadPid }));
    const transient = path.join(fixture.base,first.id,'peer');
    await fs.mkdir(transient);
    await fs.writeFile(path.join(transient,'owned.tmp'), secretPrompt);
    assert.deepEqual(await store.recoverAbandonedLease(), { recovered: true });
    assert.deepEqual(await fs.readFile(target), before);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['session.v1.enc']);
    assert.deepEqual(await store.recoverAbandonedLease(), { recovered: false });
  } finally { await fixture.clean(); }
});
