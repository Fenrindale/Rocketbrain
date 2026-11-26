'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

function accepts(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function runSshJavaDebugChecks(api, vscode, checks) {
  assert.equal(process.platform, 'win32', 'Use the owned Windows SSH host fixture.');
  const javaHome = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_JDK;
  const python = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON;
  const pythonPackage = process.env.ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH;
  assert.ok(javaHome && python && pythonPackage);
  const [folder] = vscode.workspace.workspaceFolders || [];
  assert.equal(folder?.uri.scheme, 'file');
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of ['javaDebug', 'javaDebugStop']) assert.ok(commands.has('rocketbrain.sshWorkspace.' + command));
  const service = api.sshWorkspace.javaDebug;
  const className = 'RbSshJdwp' + randomBytes(4).toString('hex');
  const fixture = processFixture('fixture.boot', className);
  const relative = path.join('src', 'main', 'java', 'fixture', 'boot', className + '.java');
  const local = path.join(folder.uri.fsPath, relative);
  const sourceUri = vscode.Uri.file(local);
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(sourceUri, new vscode.Position(fixture.line - 1, 0)), true);
  const sessions = new Map(), stopped = [], ended = new Set();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(session) {
      if (!session.configuration.__rocketbrainManagedSshAttach) return undefined;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) {
        if (message.event === 'stopped' && message.body.reason === 'breakpoint') stopped.push({ id: session.id, thread: message.body.threadId });
      } };
    }
  });
  const termination = vscode.debug.onDidTerminateDebugSession(session => ended.add(session.id));
  let cleanup, target, created = false;
  try {
    const owned = await startSshProcessFixture({ python, pythonPackage }, callback => { cleanup = callback; });
    const remote = path.join(owned.profile.root, relative);
    await fs.mkdir(path.dirname(remote), { recursive: true });
    await fs.writeFile(remote, fixture.source, { flag: 'wx' });
    await fs.writeFile(local, fixture.source, { flag: 'wx' });
    created = true;
    await vscode.workspace.openTextDocument(sourceUri);
    await importedSpring(api, folder.uri.fsPath);
    const built = await api.java.buildWorkspace();
    assert.ok(built === 0 || built === 1 || built?.status === 'succeed');
    await promisify(execFile)(path.join(javaHome, 'bin', 'javac.exe'), ['-g', '-d', owned.profile.root, remote],
      { windowsHide: true, timeout: 24000 });
    target = fixtureJvm(path.join(javaHome, 'bin', 'java.exe'), owned.profile.root, fixture.mainClass, [owned.profile.root]);
    const port = await target.readyPort();
    const root = await api.sshWorkspace.attach(owned.profile);
    const review = await service.inspect({ pid: target.target.pid, port, javaHome, file: local });
    assert.equal(review.debugPort, port);
    await assert.rejects(service.start(local, { token: review.token }), /Review and approve/);
    vscode.debug.addBreakpoints([breakpoint]);
    const started = await service.start(local, { token: review.token, allowSshJavaDebug: true });
    const halted = await until(() => stopped.find(item => item.id === started.sessionId), 35000);
    const session = sessions.get(halted.id);
    assert.equal(session.configuration.hostName, '127.0.0.1');
    assert.deepEqual(session.configuration.sourcePaths, [path.join(folder.uri.fsPath, 'src', 'main', 'java')]);
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: halted.thread });
    assert.equal(stackFrames[0].line, fixture.line);
    assert.equal(path.relative(local, stackFrames[0].source.path), '');
    const { scopes } = await session.customRequest('scopes', { frameId: stackFrames[0].id });
    const frameLocals = scopes.find(scope => /local/i.test(scope.name));
    const { variables } = await session.customRequest('variables', { variablesReference: frameLocals.variablesReference });
    assert.equal(variables.find(value => value.name === 'watched').value, '73');
    await vscode.commands.executeCommand('rocketbrain.sshWorkspace.javaDebugStop');
    await until(() => ended.has(session.id) && target.output().includes('DEBUG_FIXTURE_RESUMED:73'), 15000);
    assert.equal(target.ended(), false);
    assert.equal(await accepts(session.configuration.port), false);
    assert.equal((await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, ...relative.split(path.sep)))).type, vscode.FileType.File);
    const jdbc = await jdbcReadback();
    checks.push('Attached the installed Java debugger through a reviewed SSH JVM relay, verified its source line and local value, and disconnected without stopping the JVM or SSH workspace.');
    return { nativeBreakpoint: fixture.line, localValue: 73, localSourceMatched: true, distinctRelayReleased: true,
      externalJvmResumed: true, sshWorkspacePreserved: true, jdbc };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    try { await vscode.commands.executeCommand('rocketbrain.sshWorkspace.javaDebugStop'); }
    finally {
      tracker.dispose();
      termination.dispose();
      api.sshWorkspace.close();
      await target?.leave();
      await cleanup?.();
      if (created) await fs.rm(local, { force: true });
    }
  }
}

module.exports = { runSshJavaDebugChecks };
