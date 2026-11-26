'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runSshWorkspaceProcessChecks(api, vscode, checks) {
  const expected = ['terminal', 'javaStart', 'javaStop'].map(name => 'rocketbrain.sshWorkspace.' + name);
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of expected) assert.ok(commands.has(command), command);
  const service = api.sshWorkspace;
  assert.throws(() => service.processes.inspect('terminal'), /Reopen the reviewed SSH workspace/);
  const env = process.env;
  const javaHome = env.ROCKETBRAIN_SSH_PROCESS_TEST_JDK, serverPath = env.ROCKETBRAIN_SSH_PROCESS_TEST_JDT;
  const python = env.ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON, pythonPackage = env.ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH;
  assert.ok(javaHome && serverPath && python && pythonPackage, 'Provide the owned SSH Java test runtimes.');
  let cleanup;
  try {
    const fixture = await startSshProcessFixture({ python, pythonPackage }, callback => { cleanup = callback; });
    await assert.rejects(service.attach({ ...fixture.profile, knownHostsPath: fixture.wrongPin }), /Verify the SSH host key/);
    const root = await service.attach(fixture.profile);
    await assert.rejects(service.processes.startTerminal({}), /Review and approve/);
    const t = await service.processes.inspect('terminal');
    const approve = plan => ({ token: plan.token, allowRemoteProcess: true });
    assert.equal((await service.processes.startTerminal(approve(t))).state, 'started');
    assert.equal(service.processes.terminalStatus().state, 'running');
    const review = await service.processes.inspect('java', { javaHome, serverPath });
    assert.equal((await service.processes.startJava(approve(review))).state, 'running');
    const uri = vscode.Uri.joinPath(root, 'src', 'fixture', 'Example.java');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.languageId, 'java');
    assert.equal(document.getText(), fixture.sourceText);
    const use = document.positionAt(fixture.sourceText.indexOf('Target') + 1);
    const expectedTarget = vscode.Uri.joinPath(root, 'src', 'fixture', 'Target.java').toString();
    let found = false;
    for (let attempt = 0; !found && attempt < 24; attempt++) {
      const targets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, use);
      found = targets?.some(target => (target.uri || target.targetUri)?.toString() === expectedTarget);
      if (!found) await delay(350);
    }
    assert.ok(found, 'Native Go to Definition resolved the physical remote Java file.');
    const field = document.positionAt(fixture.sourceText.indexOf('field') + 1);
    const ho = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, field);
    assert.ok(ho.some(item => item.contents.some(part => /Target.*field/u.test(part.value ?? part))));
    await vscode.commands.executeCommand('rocketbrain.sshWorkspace.javaStop');
    assert.equal(service.processes.javaStatus().state, 'none');
    assert.equal(service.processes.terminalStatus().state, 'running');
    service.close();
    assert.equal(service.processes.terminalStatus().state, 'none');
    const jdbc = await jdbcReadback();
    checks.push('Verified the installed SSH terminal lifetime and Java providers against an owned pinned SSH peer and real remote JDT LS.');
    return { nativeTerminal: true, nativeDefinition: true, nativeHover: true, reviewedIdentity: true, scopedStop: true, jdbc };
  } finally { service.close(); await cleanup?.(); }
}

module.exports = { runSshWorkspaceProcessChecks };
