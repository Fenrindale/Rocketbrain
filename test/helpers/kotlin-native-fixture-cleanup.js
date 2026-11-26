'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const fixtureName = /^rb-kotlin-expressions-[a-z0-9]{6}$/i;
const ownerFile = '.rocketbrain-native-fixture-owner';

function manifestPath(root, prefix, engine) {
  assert.match(prefix, /^v0\.134(?:-[a-z0-9-]+)?$/);
  assert.ok(['mysql', 'mariadb'].includes(engine));
  return path.resolve(root, 'test-output', `${prefix}-native-${engine}-kotlin-fixture.json`);
}

function checkPid(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Expected an owned native fixture process ID.');
}

async function directoryIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a physical native fixture directory.');
  return [String(stat.dev), String(stat.ino)];
}

async function physicalFixture(workspace, name) {
  assert.match(name, fixtureName);
  const target = path.join(workspace, name);
  const identity = await directoryIdentity(target);
  const physical = await fs.realpath(target);
  assert.equal(path.relative(target, physical), '', 'The native fixture directory was redirected.');
  return { physical, identity };
}

async function stageCleanup(manifest, workspace, fixture, hostPid = process.pid) {
  checkPid(hostPid);
  const root = await fs.realpath(workspace);
  const name = path.basename(fixture);
  const parent = await fs.realpath(path.dirname(fixture));
  assert.equal(path.relative(root, parent), '', 'The native fixture must be a direct workspace child.');
  const { physical, identity } = await physicalFixture(root, name);
  const token = randomUUID();
  await fs.writeFile(path.join(physical, ownerFile), token, { flag: 'wx' });
  const ownership = { workspace: root, workspaceIdentity: await directoryIdentity(root), name, identity, hostPid, token };
  await fs.writeFile(manifest, JSON.stringify(ownership), { flag: 'wx' });
  return {
    async recordJvm(pid) {
      checkPid(pid);
      assert.notEqual(pid, hostPid);
      await fs.writeFile(manifest + '.jvm', JSON.stringify({ token, pid }), { flag: 'wx' });
    }
  };
}

function active(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function cleanupAfterHostExit({ manifest, workspace, hostPid, expectJvm = false, waitMs = 15000 }) {
  const ownership = JSON.parse(await fs.readFile(manifest, 'utf8'));
  checkPid(ownership.hostPid);
  if (hostPid !== undefined) assert.equal(ownership.hostPid, hostPid, 'The native fixture host does not match the driver receipt.');
  let jvm;
  try {
    jvm = JSON.parse(await fs.readFile(manifest + '.jvm', 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || expectJvm) throw error;
  }
  if (jvm) {
    checkPid(jvm.pid);
    assert.equal(jvm.token, ownership.token, 'The native fixture JVM record does not match the fixture.');
    assert.notEqual(jvm.pid, ownership.hostPid);
  }
  const deadline = Date.now() + waitMs;
  function processesActive() {
    return active(ownership.hostPid) || (jvm && active(jvm.pid));
  }
  while (processesActive() && Date.now() < deadline) await delay(100);
  assert.ok(!processesActive(), 'The native fixture extension host or owned JVM is still running.');

  const root = await fs.realpath(workspace);
  assert.equal(path.relative(root, ownership.workspace), '', 'The native fixture workspace does not match the runner.');
  assert.deepEqual(await directoryIdentity(root), ownership.workspaceIdentity, 'The native fixture workspace was replaced.');
  const { physical, identity } = await physicalFixture(root, ownership.name);
  assert.deepEqual(identity, ownership.identity, 'The native fixture directory was replaced.');
  const owner = path.join(physical, ownerFile);
  const ownerStat = await fs.lstat(owner);
  assert.ok(ownerStat.isFile() && !ownerStat.isSymbolicLink());
  assert.equal(await fs.readFile(owner, 'utf8'), ownership.token, 'The native fixture ownership marker was replaced.');
  await fs.rm(physical, { recursive: true, maxRetries: 12, retryDelay: 350 });
  await assert.rejects(fs.lstat(physical), { code: 'ENOENT' });
  return { removed: true, extensionHostExited: true, ownedJvmExited: Boolean(jvm) };
}

module.exports = { manifestPath, stageCleanup, cleanupAfterHostExit };
