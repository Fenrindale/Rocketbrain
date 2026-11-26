'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanupAfterHostExit, stageCleanup } = require('./helpers/kotlin-native-fixture-cleanup');

test('Kotlin native cleanup removes only the recorded fixture after both owned processes exit', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-kotlin-cleanup-test-'));
  const project = await fs.mkdtemp(path.join(workspace, 'rb-kotlin-expressions-'));
  const untouched = await fs.mkdtemp(path.join(workspace, 'rb-kotlin-expressions-'));
  const manifest = path.join(workspace, 'ownership.json');
  const childOptions = { cwd: project, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] };
  const host = spawn(process.execPath, ['-e', 'process.stdin.resume()'], childOptions);
  const jvm = spawn(process.execPath, ['-e', 'process.stdin.resume()'], childOptions);
  const hostExit = once(host, 'close');
  const jvmExit = once(jvm, 'close');
  const args = { manifest, workspace, hostPid: host.pid, expectJvm: true, waitMs: 1 };
  try {
    const checkout = await stageCleanup(manifest, workspace, project, host.pid);
    await checkout.recordJvm(jvm.pid);
    await assert.rejects(cleanupAfterHostExit(args), /host or owned JVM is still running/);
    host.stdin.end();
    assert.deepEqual(await hostExit, [0, null]);
    await assert.rejects(cleanupAfterHostExit(args), /host or owned JVM is still running/);
    jvm.stdin.end();
    assert.deepEqual(await jvmExit, [0, null]);
    await assert.rejects(cleanupAfterHostExit({ ...args, hostPid: process.pid }), /does not match the driver receipt/);
    await assert.rejects(cleanupAfterHostExit({ ...args, workspace: untouched }), /does not match the runner/);
    const replaced = await fs.readFile(manifest, 'utf8');
    const ownership = JSON.parse(replaced);
    await fs.writeFile(manifest, JSON.stringify({ ...ownership, name: '../elsewhere' }));
    await assert.rejects(cleanupAfterHostExit(args), /regular expression/);
    await fs.writeFile(manifest, JSON.stringify({ ...ownership, name: path.basename(untouched) }));
    await assert.rejects(cleanupAfterHostExit(args), /directory was replaced/);
    await fs.writeFile(manifest, replaced);
    assert.deepEqual(await cleanupAfterHostExit(args), { removed: true, extensionHostExited: true, ownedJvmExited: true });
    await assert.rejects(fs.lstat(project), { code: 'ENOENT' });
    assert.ok((await fs.stat(untouched)).isDirectory());
  } finally {
    for (const child of [host, jvm]) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled([hostExit, jvmExit]);
    const physical = await fs.realpath(workspace);
    assert.equal(path.relative(await fs.realpath(os.tmpdir()), path.dirname(physical)), '');
    assert.match(path.basename(physical), /^rb-kotlin-cleanup-test-/);
    await fs.rm(physical, { recursive: true });
  }
});
