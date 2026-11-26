'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { managerOrigin, managerContext, parseList, createTomcatManager } = require('../src/java/jakarta-manager');
const { createManagerHistory } = require('../src/java/jakarta-manager-history');
const { createManagerJournal, digest, storageFolder } = require('../src/java/jakarta-manager-journal');

test('Manager targets one explicit HTTPS origin and one ordinary application context', () => {
  assert.equal(managerOrigin('https://example.test:8443/'), 'https://example.test:8443');
  for (const value of ['http://example.test', 'https://user@example.test', 'https://example.test/manager/text',
    'https://example.test/?a=1', 'https://example.test/#fragment', ' https://example.test']) {
    assert.throws(() => managerOrigin(value), /exact HTTPS origin/u);
  }
  assert.equal(managerContext('orders'), '/orders');
  for (const value of ['/', '/manager', '/host-manager', '/foo/bar', '/foo##1', '/foo%2Fbar', '/foo?update=true']) {
    assert.throws(() => managerContext(value), /one named Tomcat/u);
  }
});

test('Manager list parses stock protocol state and keeps colon-containing document bases private', () => {
  const heading = 'OK - Listed applications for virtual host [localhost]';
  const values = parseList(heading + '\r\n/manager:running:0:manager\r\n/orders:stopped:12:C:\\app\\orders.war\r\n');
  assert.deepEqual(values[1], { context: '/orders', state: 'stopped', sessions: 12, location: 'C:\\app\\orders.war' });
  assert.throws(() => parseList('FAIL - Manager command rejected'), /bounded application list/u);
  assert.throws(() => parseList('OK - Backend welcome page'), /bounded application list/u);
  assert.throws(() => parseList(heading + '\n/orders:unknown:0:orders'), /unsupported application list/u);
  assert.throws(() => parseList(heading + '\n/orders:running:0:\u0000'), /unsupported application list/u);
});

test('Manager refuses unapproved access and cancelled execution before contacting a server', async () => {
  const service = createTomcatManager();
  try {
    await assert.rejects(service.observe({ origin: 'https://example.test' }), /Explicitly approve/u);
    await assert.rejects(service.execute({ reviewId: 'arbitrary', allowExecute: true, cancellation: AbortSignal.abort() }),
      /operation was cancelled/u);
    await assert.rejects(service.execute({ reviewId: 'arbitrary', allowExecute: true }), /Review the current/u);
  } finally { await service.dispose(); }
});

test('tracked history binds live doc bases, host, account and local archive owners', async () => {
  const history = createManagerHistory(), context = '/orders';
  const input = { action: 'track-deploy', origin: 'https://example.test', context, username: 'operator',
    certificateSha256: 'certificate', caSha256: 'authority', virtualHost: 'localhost' };
  const observed = { virtualHost: 'localhost', applications: [] };
  const first = await history.inspect(input, observed.applications);
  const version = 'rb001-' + 'a'.repeat(32), nextVersion = 'rb002-' + 'b'.repeat(32);
  const row = { context, state: 'running', sessions: 0, location: 'orders##' + version };
  const secondObservation = { ...observed, applications: [row] };
  let released = 0;
  try {
    await history.beforeUpload(first, observed);
    assert.equal(await history.confirm(first, version, secondObservation, 'digest',
      () => ({ artifact: { name: 'orders.war', size: 64 }, release: async () => { released++; } })), row);
    await assert.rejects(history.beforeUpload(first, observed), /saved Tomcat history changed/u);
    const update = await history.inspect({ ...input, action: 'track-update' }, secondObservation.applications);
    assert.equal(update.current.sha256, 'digest');
    assert.equal(update.current.location, row.location);
    await assert.rejects(history.inspect({ ...input, action: 'track-update', username: 'other' }, [row]),
      /same endpoint, account and certificate/u);
    await assert.rejects(history.beforeUpload(update, { ...secondObservation, virtualHost: 'other' }), /live Tomcat versions changed/u);
    await assert.rejects(history.beforeUpload(update, { ...observed, applications: [{ ...row, location: row.location + '.war' }] }),
      /live Tomcat versions changed/u);
    await history.beforeUpload(update, { ...observed, applications: [{ ...row, sessions: 3 }] });
    assert.equal(await history.confirm(update, nextVersion, secondObservation, 'other digest', () => assert.fail('premature retention')), undefined);
    history.invalidate(update);
    await assert.rejects(history.inspect({ ...input, action: 'restore' }, [row]), /context tracked by this Tomcat Manager/u);
  } finally { await history.dispose(); }
  assert.equal(released, 1);
});

test('profile journal permits one writer, hides pending changes, and validates the committed chain after restart', async () => {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'rb-manager-journal-test-'));
  const identity = await fs.lstat(root, { bigint: true });
  const directory = path.join(root, 'profile'), key = digest('context key'), context = '/orders', owner = digest('private identity');
  const open = () => createManagerJournal(directory, { maxContexts: 16, maxVersions: 8, maxBytes: 512 * 1024 * 1024 });
  const first = open(), second = open(), file = path.join(root, 'orders.war');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x51, 0x41]), sha256 = digest(bytes);
  const artifact = { file, name: 'orders.war', size: bytes.length };
  try {
    await fs.writeFile(file, bytes);
    const claim = { key, context, owner, nextRevision: 1 };
    assert.equal(await first.read(key, context), undefined);
    const results = await Promise.allSettled([first.reserve(claim, artifact, sha256), second.reserve(claim, artifact, sha256)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /still in progress|Another Rocketbrain window/u);
    const winner = results.find(result => result.status === 'fulfilled').value;
    await assert.rejects(open().read(key, context), /still in progress/u);
    const version = 'rb001-' + 'a'.repeat(32);
    await winner.confirm(version, 'orders##' + version);
    const after = await open().read(key, context);
    assert.equal(after.owner, owner);
    assert.deepEqual(await fs.readFile(after.revisions[0].artifact.file), bytes);
    const subsequent = { ...claim, before: after, nextRevision: 2 };
    const pending = await second.reserve(subsequent, artifact, sha256);
    await assert.rejects(open().read(key, context), /still in progress/u);
    await pending.abort();
    assert.equal((await first.read(key, context)).head, after.head);
    const manifest = path.join(directory, storageFolder, key, '001', 'confirmed.json');
    const wrong = { ...JSON.parse(await fs.readFile(manifest, 'utf8')), parent: digest('foreign chain') };
    await fs.writeFile(manifest, JSON.stringify(wrong));
    await assert.rejects(open().read(key, context), /manifest is invalid/u);
  } finally {
    const resolved = await fs.realpath(root), stat = await fs.lstat(resolved, { bigint: true });
    assert.deepEqual([resolved, path.dirname(resolved), stat.dev, stat.ino], [root, temp, identity.dev, identity.ino]);
    assert.ok(path.basename(resolved).startsWith('rb-manager-journal-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
