'use strict';

const assert = require('node:assert/strict');
const { stageBatchFixture, exerciseBatch } = require('./helpers/ssh-batch-fixture');

async function runSshBatchChecks(api, vscode, checks) {
  const service = api.sshWorkspace;
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.sshWorkspace.uploadBatch') && commands.includes('rocketbrain.sshWorkspace.checkBatch'));
  const cleanups = [];
  let root;
  try {
    const fixture = await stageBatchFixture(action => cleanups.push(action));
    const attach = async profile => { root = await service.attach(profile); };
    await attach(fixture.profile);
    const pairs = (endpoint, local) => ({ remote: vscode.Uri.joinPath(root, ...endpoint.slice(1).split('/')),
      local: vscode.Uri.file(local) });
    const alpha = pairs('/batch/Alpha.java', fixture.locals[0]);
    const document = await vscode.workspace.openTextDocument(alpha.remote);
    assert.equal(document.getText(), fixture.original[0]);
    const result = await exerciseBatch(service, fixture, attach, pairs);
    checks.push('Reviewed SSH replacements retain confirmed writes and support read-only reconciliation after reconnecting.');
    return { ...result, nativeCommands: true, savedRemoteDocument: true };
  } finally {
    service.close();
    for (const action of cleanups.reverse()) await action();
  }
}

module.exports = { runSshBatchChecks };
