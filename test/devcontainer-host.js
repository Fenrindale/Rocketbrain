'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openFixtureForward, checkHttp, attachJdwp, waitForReleasedPort } = require('./devcontainer-port-fixture');

async function registeredCommands(vscode) {
  const expected = ['inspect', 'start', 'exec', 'status', 'stop', 'forwardPort', 'closePort'].map(name => 'rocketbrain.devcontainer.' + name);
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const name of expected) assert.ok(commands.has(name), name);
  return expected;
}

async function runDevContainerAvailabilityChecks(api, vscode, checks) {
  const folders = vscode.workspace.workspaceFolders || [];
  assert.equal(folders.length, 1, 'Open a single disposable local workspace.');
  const root = folders[0].uri.fsPath;
  const service = api.devContainers;
  const commands = await registeredCommands(vscode);
  const status = await vscode.commands.executeCommand('rocketbrain.devcontainer.status');
  assert.deepEqual(status, { state: 'none' });
  assert.deepEqual(await vscode.commands.executeCommand('rocketbrain.devcontainer.stop'), { state: 'none' });
  await assert.rejects(service.start(root), /Review the Dev Container configuration/);
  await assert.rejects(service.execute(root, ['cat', 'fixture.txt']), /Start the managed Dev Container/);
  assert.deepEqual(await service.forwardedPorts(root), []);
  await assert.rejects(service.inspectPort(root, { containerPort: 8787 }), /Start the managed Dev Container/);
  await assert.rejects(service.forwardPort(root, {}), /Review and approve/);
  checks.push('Verified the installed VS Code Dev Container commands, empty session status, and review and session requirements without contacting Docker.');
  return { commands, emptyStatus: status.state, emptyStop: true, requiresReview: true, requiresRunningSession: true, forwardRequiresReview: true };
}

// The caller opens a disposable workspace with one of the Dev Container fixtures
// and provisions a real local Docker service and the locked CLI. For Compose,
// build Containerfile.txt in that fixture as rocketbrain-devcontainer-port-fixture:local.
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
    await registeredCommands(vscode);
    const before = await vscode.commands.executeCommand(`rocketbrain.devcontainer.status`);
    assert.equal(before?.state, 'none');
    const plan = await vscode.commands.executeCommand(`rocketbrain.devcontainer.inspect`);
    assert.equal(plan?.cliVersion, '0.91.0');
    assert.equal(plan.kind, expected);
    if(expected==='compose') {
      assert.deepEqual(plan.compose.files,['compose.yaml','compose.workspace.yaml']);
      assert.deepEqual(plan.compose.services,['workspace','dependency']);
    } else assert.match(plan.workspaceMount, /type=bind/);
    const started = await service.start(root, { file: plan.file, fingerprint: plan.fingerprint, allowProjectExecution: true });
    const result = await service.execute(root, ['cat', 'fixture.txt']);
    assert.equal(result.id, started.id);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'Rocketbrain mounted workspace');
    const lifecycle = await service.execute(root, ['cat', '/tmp/rocketbrain-devcontainer-ready']);
    assert.equal(lifecycle.code, 0, lifecycle.stderr);
    assert.match(lifecycle.stdout, /^ready-(image|build|compose)$/);
    let http;
    if (expected === 'compose') {
      http = await openFixtureForward(service, root, 8787);
      const jdwp = await openFixtureForward(service, root, 5005);
      assert.deepEqual((await service.status(root)).forwards, [http, jdwp]);
      await checkHttp(http);
      const client = await attachJdwp(jdwp);
      await service.closePort(root, jdwp.id);
      await client.close;
      await waitForReleasedPort(jdwp);
    }
    const stopped = await vscode.commands.executeCommand(`rocketbrain.devcontainer.stop`);
    if(expected==='compose') {
      assert.equal(stopped.state,'stopped');
      assert.equal(stopped.id,started.id);
      assert.ok(stopped.services.every(row=>!row.running));
      await waitForReleasedPort(http);
    } else assert.deepEqual(stopped, { state: 'stopped', id: started.id });
    checks.push('Inspected a workspace Dev Container from the VS Code command, started the actual fixture, read its bind mount and lifecycle marker, and stopped the exact managed container.');
    return { cliVersion: plan.cliVersion, kind: expected, mountedFile: result.stdout.trim(), lifecycle: lifecycle.stdout, stopped: true,
      ...(http && { portForwarding: { http: true, jdwpVersion: true, individualClose: true, releaseOnManagedStop: true } }) };
  } finally {
    await service.stop(root);
    for (const { key, previous } of overrides.reverse()) await config.update(key, previous, target);
  }
}

module.exports = { runDevContainerAvailabilityChecks, runDevContainerChecks };
