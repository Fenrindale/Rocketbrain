'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// The caller opens a disposable workspace with one of the Dev Container fixtures
// and provisions a real local Docker service and the locked CLI.
async function runDevContainerChecks(api, vscode, checks) {
  const service = api.devContainers;
  const folders = vscode.workspace.workspaceFolders || [];
  assert.equal(folders.length, 1, 'Open the exact disposable Dev Container project.');
  const root = folders[0].uri.fsPath;
  assert.ok((await fs.stat(path.join(root, 'fixture.txt'))).isFile());
  const expected = process.env.ROCKETBRAIN_DEVCONTAINER_HOST_KIND || 'image';
  const config = vscode.workspace.getConfiguration('rocketbrain.devcontainer');
  const target = vscode.ConfigurationTarget.Global;
  const overrides = [
    ['cliPath', process.env.ROCKETBRAIN_DEVCONTAINER_CLI_PATH],
    ['nodePath', process.env.ROCKETBRAIN_DEVCONTAINER_NODE_PATH],
    ['dockerPath', process.env.ROCKETBRAIN_DEVCONTAINER_DOCKER_PATH]
  ].filter(([, value]) => value).map(([key, value]) => ({ key, value, previous: config.inspect(key)?.globalValue }));
  try {
    for (const { key, value } of overrides) await config.update(key, value, target);
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['inspect', 'start', 'exec', 'status', 'stop']) assert.ok(commands.includes('rocketbrain.devcontainer.' + name));
    const before = await vscode.commands.executeCommand(`rocketbrain.devcontainer.status`);
    assert.equal(before?.state, 'none');
    const plan = await vscode.commands.executeCommand(`rocketbrain.devcontainer.inspect`);
    assert.equal(plan?.cliVersion, '0.91.0');
    assert.equal(plan.kind, expected);
    assert.match(plan.workspaceMount, /type=bind/);
    const started = await service.start(root, { file: plan.file, fingerprint: plan.fingerprint, allowProjectExecution: true });
    const result = await service.execute(root, ['cat', 'fixture.txt']);
    assert.equal(result.id, started.id);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'Rocketbrain mounted workspace');
    const lifecycle = await service.execute(root, ['cat', '/tmp/rocketbrain-devcontainer-ready']);
    assert.equal(lifecycle.code, 0, lifecycle.stderr);
    assert.match(lifecycle.stdout, /^ready-(image|build)$/);
    const stopped = await vscode.commands.executeCommand(`rocketbrain.devcontainer.stop`);
    assert.deepEqual(stopped, { state: 'stopped', id: started.id });
    checks.push('Inspected a workspace Dev Container from the VS Code command, started the actual fixture, read its bind mount and lifecycle marker, and stopped the exact managed container.');
    return { cliVersion: plan.cliVersion, kind: expected, mountedFile: result.stdout.trim(), lifecycle: lifecycle.stdout, stopped: true };
  } finally {
    await service.stop(root);
    for (const { key, previous } of overrides.reverse()) await config.update(key, previous, target);
  }
}

module.exports = { runDevContainerChecks };
