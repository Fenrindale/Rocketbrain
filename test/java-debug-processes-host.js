'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runJavaProcessChecks(api, vscode, checks) {
  const service = api.java.debug.processes;
  assert.ok(service?.list && service?.resolve && service?.attach);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.attachProcess'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const className = 'RbProcessPicker' + randomBytes(4).toString('hex');
  const fixture = processFixture('fixture.boot', className);
  const file = path.join(workspace, 'src/main/java/fixture/boot', className + '.java');
  const source = vscode.Uri.file(file);
  const sessions = new Map(), events = [];
  const sessionName = 'Managed PID fixture ' + className;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory(`rocketbrain-java`, {
    createDebugAdapterTracker(session) {
      if (session.configuration.name !== sessionName) return undefined;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) { events.push({ sessionId: session.id, ...message }); } };
    }
  });
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.line - 1, 0)), true);
  let started, nonDebug, created = false, detached = false;
  try {
    await fs.writeFile(file, fixture.source, { flag: 'wx' });
    created = true;
    await vscode.workspace.openTextDocument(source);
    const built = await api.java.buildWorkspace();
    assert.ok(built === 0 || built === 1 || built?.status === 'succeed', JSON.stringify(built));
    const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', project.uri))
      ?.find(item => item.mainClass === fixture.mainClass), 45000);
    const [, classPaths] = await api.java.executeWorkspaceCommand('vscode.java.resolveClasspath', fixture.mainClass, main.projectName);
    const java = await api.java.executeWorkspaceCommand('vscode.java.resolveJavaExecutable', fixture.mainClass, main.projectName);
    started = fixtureJvm(java, workspace, fixture.mainClass, classPaths);
    nonDebug = fixtureJvm(java, workspace, fixture.mainClass, classPaths, { debug: false });
    const [port] = await Promise.all([started.readyPort(), nonDebug.readyPort()]);
    const listed = await service.list();
    const picked = listed.find(row => row.pid === started.target.pid);
    assert.ok(picked);
    assert.equal(picked.port, port);
    assert.ok(!listed.some(row => row.pid === nonDebug.target.pid));
    assert.doesNotMatch(JSON.stringify(listed), /fixture-private-argument/);
    await assert.rejects(service.resolve({ ...picked, startedAt: picked.startedAt + 1 }), /changed/);
    vscode.debug.addBreakpoints([breakpoint]);
    assert.equal(await service.attach(picked, { folder: vscode.workspace.getWorkspaceFolder(source),
      projectName: main.projectName, name: sessionName }), true);
    const halt = await until(() => events.find(item => item.event === 'stopped' && item.body.reason === 'breakpoint'), 35000);
    const session = sessions.get(halt.sessionId);
    assert.ok(session);
    assert.equal(session.configuration.hostName, '127.0.0.1');
    assert.equal(session.configuration.port, port);
    assert.equal(session.configuration.processId, undefined);
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: halt.body.threadId });
    assert.equal(stackFrames[0].line, fixture.line);
    const watched = await session.customRequest('evaluate', { frameId: stackFrames[0].id, expression: 'watched', context: 'watch' });
    assert.equal(watched.result, '73');
    await session.customRequest('disconnect', { terminateDebuggee: false });
    detached = true;
    await until(() => started.output().includes('DEBUG_FIXTURE_RESUMED:73'), 10000);
    assert.equal(started.ended(), false);
    await started.leave();
    await assert.rejects(service.resolve(picked), /does not have a verified local JDWP listener/);
    const jdbc = await jdbcReadback();
    checks.push('Discovered the dynamically assigned port of a Spring-workspace JVM, rejected a normal listener and stale process identity, hit a native Java breakpoint and detached while the process kept running.');
    return { springWorkspace: true, jdbc, pidResolved: true, dynamicallyAssignedPort: true,
      normalSocketExcluded: true, staleIdentityRefused: true, exitedTargetRefused: true,
      breakpoint: { line: fixture.line, watched: 73 }, detachedProcessSurvived: true };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    if (!detached) await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    tracker.dispose();
    await Promise.all([started?.leave(), nonDebug?.leave()]);
    if (created) await fs.rm(file, { force: true });
  }
}

module.exports = { runJavaProcessChecks };
