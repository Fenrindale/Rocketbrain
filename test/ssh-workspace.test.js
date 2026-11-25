'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const { connectWorkspace, digest } = require('../src/remote/ssh-workspace');
const { remoteCommand } = require('../src/remote/ssh-files-worker');

test('remote launches allow only fixed Python commands and profiles declare an absolute root', async () => {
  assert.match(remoteCommand('python3'), /^python3 -I -u -c "exec/);
  assert.throws(() => remoteCommand('python3 -c arbitrary'), /supported remote Python/);
  await assert.rejects(connectWorkspace({ id:'well-formed', root:'relative' }), /absolute directory/);
});

test('real OpenSSH verifies identity and uploads exact remote text only after the current digest matches',
  { skip: !process.env.ROCKETBRAIN_SSH_TEST_PYTHON }, async () => {
    const fixture = await require('./helpers/ssh-workspace-fixture').startSshWorkspace(process.env.ROCKETBRAIN_SSH_TEST_PYTHON);
    let client;
    try {
      await assert.rejects(connectWorkspace({ ...fixture.profile, knownHostsPath:fixture.wrongHosts }), /Verify the SSH host key/);
      assert.equal(fixture.executions(),0);
      client = await connectWorkspace(fixture.profile);
      assert.deepEqual(await client.list('/'),[['RemoteController.java','file']]);
      assert.throws(() => client.stat('/../wrong_hosts'), /unsupported segment/);
      await assert.rejects(client.stat('/gone'), { remoteCode:'missing' });
      const original = await client.read('/RemoteController.java');
      assert.equal(original.data.toString(),fixture.original);
      const payload = Buffer.from(fixture.original.replace('42','43'));
      assert.equal(await client.replace('/RemoteController.java',payload,original.sha256),digest(payload));
      assert.deepEqual(await fs.readFile(fixture.file),payload);
      await assert.rejects(client.replace('/RemoteController.java',Buffer.from('dirty'),original.sha256), { remoteCode:'changed-file' });
      assert.deepEqual((await client.read('/RemoteController.java')).data,payload);
    } finally { client?.close(); await fixture.close(); }
  });
