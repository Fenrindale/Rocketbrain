'use strict';

const assert = require('node:assert/strict');

async function runDevContainerJavaAvailabilityChecks(api, vscode, checks) {
  const folders = vscode.workspace.workspaceFolders || [];
  assert.equal(folders.length, 1, 'Open a single owned workspace.');
  const root = folders[0].uri.fsPath;
  const expected = ['javaStart', 'javaStop', 'javaFormat'].map(name => 'rocketbrain.devcontainer.' + name);
  const localCommands = new Set(await vscode.commands.getCommands(true));
  for (const command of expected) assert.ok(localCommands.has(command), command);
  const service = api.devContainers;
  assert.deepEqual(await service.javaStatus(root), { state: 'none' });
  await assert.rejects(service.inspectJava(root, {
    containerRoot: '/workspaces/fixture', javaHome: '/opt/java/openjdk', serverPath: '/opt/jdtls'
  }), /Start the managed Dev Container/);
  await assert.rejects(service.startJava(root, {}), /Review the mounted workspace/);
  await assert.rejects(service.javaDefinition(root, {}, { line: 0, character: 0 }), /Start Container Java/);
  await vscode.commands.executeCommand('rocketbrain.devcontainer.javaStop');
  assert.deepEqual(await service.javaStatus(root), { state: 'none' });
  checks.push('Verified installed managed container Java commands and their running-container and review requirements without contacting a daemon.');
  return { commands: expected, emptyStatus: 'none', requiresReview: true, requiresRunningContainer: true };
}

module.exports = { runDevContainerJavaAvailabilityChecks };
