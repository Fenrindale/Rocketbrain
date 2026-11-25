'use strict';

const assert = require('node:assert/strict');

async function runKubernetesExplorerChecks(api, vscode, checks) {
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['connect', 'disconnect', 'namespace', 'podLogs', 'refresh']) {
    assert.ok(commands.includes('rocketbrain.kubernetes.' + command));
  }
  assert.equal(typeof api.kubernetes.snapshot, 'function');
  assert.equal(api.kubernetes.snapshot(), null);
  await vscode.commands.executeCommand('rocketbrain.kubernetes.focus');
  await vscode.commands.executeCommand('rocketbrain.kubernetes.refresh');
  assert.equal(api.kubernetes.snapshot(), null);
  await vscode.commands.executeCommand('rocketbrain.kubernetes.disconnect');
  checks.push('The installed Kubernetes tree opened and its commands remained disconnected until a context is chosen.');
  return { nativeTree: true, registeredCommands: 5, connectedOnActivation: false };
}

module.exports = { runKubernetesExplorerChecks };
