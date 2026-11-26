'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const { connectWorkspace, partsFor } = require('../src/remote/ssh-workspace');
const { createSshBatchOperations } = require('../src/remote/ssh-batch');
const { batchCommand, batchFrame } = require('../src/remote/ssh-batch-runtime');
const { registerSshBatch } = require('../src/remote/ssh-batch-vscode');
const { stageBatchFixture, exerciseBatch } = require('./helpers/ssh-batch-fixture');

test('SSH batch bounds exact paths, validates claimed receipts and fixes the remote worker bootstrap', async () => {
  const proof = { sha256: 'a'.repeat(64), stamp: 'b'.repeat(64), size: 1 };
  const worker = batchCommand('py -3');
  assert.ok(worker.length < 1024);
  assert.throws(() => batchCommand('python -x'), /supported remote Python/u);
  assert.ok(batchFrame('{}\n').split('\n')[0].length < 12289);
  const sent = [];
  const operations = createSshBatchOperations(async (name, parts, fields) => {
    sent.push({ name, parts, fields });
    return { state: 'applied', rows: [{ state: 'confirmed', ...proof }, { state: 'confirmed', ...proof }] };
  }, partsFor);
  for (const paths of [['/A'], ['/A', '/A'], ['/A', '/B.'], ['/', '/B'], ['/A', '/x/../B']]) {
    await assert.rejects(operations.inspectBatch(paths));
  }
  assert.equal(sent.length, 0);
  const after = require('node:crypto').createHash('sha256').update('owned').digest('hex');
  const result = await operations.replaceBatch({ rootKey: 'f'.repeat(64),
    entries: ['/A', '/B'].map(path => ({ path, before: proof, after, data: Buffer.from('owned') })) });
  assert.equal(result.state, 'unconfirmed');
  assert.equal(result.reason, 'reply-unverified');
  assert.equal(sent.length, 1);
});

test('actual pinned OpenSSH records partial, refused and lost-reply multi-file replacements', {
  skip: !process.env.ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON || !process.env.ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH,
  timeout: 100000
}, async context => {
  const cleanups = [];
  let current, service;
  const notified = [], commands = new Set();
  const remote = value => ({
    scheme: 'rocketbrain-ssh', path: value, authority: current.authority, toString() { return this.authority + this.path; }
  });
  try {
    const fixture = await stageBatchFixture(action => cleanups.push(action));
    await assert.rejects(connectWorkspace({ ...fixture.profile, knownHostsPath: fixture.wrongPin }), /Verify the SSH host key/u);
    let revision = 0;
    const attach = async profile => {
      service?.retire();
      current?.close();
      current = { ...await connectWorkspace(profile), authority: 'owned-' + (++revision) };
    };
    service = registerSshBatch({ workspace: { textDocuments: [] }, window: {
      createOutputChannel: () => ({ dispose() {} })
    } }, {
      command(name) { commands.add(name); return { dispose() {} }; },
      requireConnection(uri) {
        assert.equal(uri.authority, current.authority);
        return current;
      },
      currentConnection: () => current, localText: file => fs.readFile(file.fsPath),
      notify: rows => notified.push(...rows), uriFor(_authority, endpoint) { return remote(endpoint); }
    });
    await attach(fixture.profile);
    const proof = await exerciseBatch(service, fixture, attach,
      (endpoint, fsPath) => ({ remote: remote(endpoint), local: { scheme: 'file', fsPath, toString() { return fsPath; } } }));
    assert.deepEqual([...commands], ['uploadBatch', 'checkBatch']);
    assert.deepEqual(notified.map(row => row.uri.path), ['/batch/Alpha.java', '/batch/Alpha.java', '/batch/Blocked.java']);
    const receipt = { ...proof, platform: process.platform, transport: 'OpenSSH client + AsyncSSH 2.24.1',
      engine: process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE || null, targetedEvents: notified.length };
    if (process.env.ROCKETBRAIN_SSH_BATCH_RECEIPT) {
      await fs.writeFile(process.env.ROCKETBRAIN_SSH_BATCH_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    }
    context.diagnostic(JSON.stringify(receipt));
  } finally {
    service?.dispose();
    current?.close();
    for (const action of cleanups.reverse()) await action();
  }
});
