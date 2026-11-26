'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { appendFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');
const { until } = require('./helpers/stdio-lsp');

function tracePhase(phase) {
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.59';
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  const row = { phase, time: new Date().toISOString() };
  if (/^v0\.59(?:-[a-z0-9-]+)?$/.test(prefix) && ['mysql', 'mariadb'].includes(engine)) {
    const file = path.resolve(__dirname, '../test-output', prefix + '-process-attach-' + engine + '-steps.jsonl');
    try { appendFileSync(file, JSON.stringify(row) + '\n'); } catch {}
  }
  console.log('Rocketbrain process attach ' + phase);
}

async function bounded(label, operation, timeout = 30000) {
  tracePhase(label + '-started');
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Java process attach timed out at ' + label + '.')), timeout);
    })]);
    tracePhase(label + '-completed');
    return result;
  } catch (error) {
    tracePhase(label + '-failed');
    throw error;
  } finally { clearTimeout(timer); }
}

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
  const ended = new Set();
  const endListener = vscode.debug.onDidTerminateDebugSession(session => ended.add(session.id));
  const sessionName = 'Managed PID fixture ' + className;
  const draftText = '-- Unsaved PID attach regression ' + className + '\nSELECT 1;\n';
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory(`rocketbrain-java`, {
    createDebugAdapterTracker(session) {
      if (session.configuration.name !== sessionName) return undefined;
      sessions.set(session.id, session);
      tracePhase('dap-tracker-created');
      return {
        onWillReceiveMessage(message) {
          if (message.type === 'request' && ['attach', 'setBreakpoints', 'configurationDone', 'disconnect'].includes(message.command)) {
            tracePhase('dap-' + message.command + '-request');
          }
        },
        onDidSendMessage(message) {
          events.push({ sessionId: session.id, ...message });
          if (['initialized', 'stopped', 'terminated'].includes(message.event)) tracePhase('dap-' + message.event);
        }
      };
    }
  });
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.line - 1, 0)), true);
  let started, nonDebug, draft, created = false, detached = false;
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
    // The generated process has no third-party dependencies. Resolve its exact
    // compiled output without passing the full Spring classpath to CreateProcess.
    const bytecode = fixture.mainClass.replaceAll('.', path.sep) + '.class';
    const outputs = [];
    for (const entry of classPaths) {
      if (await fs.stat(path.join(entry, bytecode)).then(stat => stat.isFile(), () => false)) outputs.push(entry);
    }
    assert.equal(outputs.length, 1, 'Expected one workspace output for the generated Java main class.');
    started = fixtureJvm(java, workspace, fixture.mainClass, outputs);
    nonDebug = fixtureJvm(java, workspace, fixture.mainClass, outputs, { debug: false });
    const [port] = await bounded('fixture-listeners', () => Promise.all([started.readyPort(), nonDebug.readyPort()]), 18000);
    const listed = await bounded('discovery', () => service.list(), 40000);
    const picked = listed.find(row => row.pid === started.target.pid);
    assert.ok(picked);
    assert.equal(picked.port, port);
    assert.ok(!listed.some(row => row.pid === nonDebug.target.pid));
    assert.doesNotMatch(JSON.stringify(listed), /fixture-private-argument/);
    await bounded('stale-pid', () => assert.rejects(service.resolve({ ...picked, startedAt: picked.startedAt + 1 }), /changed/), 40000);
    await bounded('owned-sql-draft', async () => {
      draft = await vscode.workspace.openTextDocument({ language: 'sql', content: draftText });
      await vscode.window.showTextDocument(draft, { preview: false, preserveFocus: false });
      assert.strictEqual(vscode.window.activeTextEditor?.document, draft);
      assert.ok(draft.isUntitled && draft.isDirty);
    }, 10000);
    vscode.debug.addBreakpoints([breakpoint]);
    assert.equal(await bounded('start-debugging', () => service.attach(picked, { folder: vscode.workspace.getWorkspaceFolder(source),
      projectName: main.projectName, name: sessionName }), 50000), true);
    const halt = await bounded('breakpoint', () =>
      until(() => events.find(item => item.event === 'stopped' && item.body.reason === 'breakpoint'), 35000), 36000);
    const session = sessions.get(halt.sessionId);
    assert.ok(session);
    assert.ok(draft.isUntitled && draft.isDirty);
    assert.equal(draft.getText().replace(/\r\n/g, '\n'), draftText);
    assert.equal(session.configuration.hostName, '127.0.0.1');
    assert.equal(session.configuration.port, port);
    assert.equal(session.configuration.processId, undefined);
    const { stackFrames } = await bounded('stack-trace', () => session.customRequest('stackTrace', { threadId: halt.body.threadId }), 12000);
    assert.equal(stackFrames[0].line, fixture.line);
    const watched = await bounded('evaluate', () => session.customRequest('evaluate', {
      frameId: stackFrames[0].id, expression: 'watched', context: 'watch'
    }), 12000);
    assert.equal(watched.result, '73');
    // Native disconnect can dispose its request transport before the API promise
    // settles. The terminal session event and the still-running child are the proof.
    void Promise.resolve().then(() => vscode.debug.stopDebugging(session))
      .catch(() => tracePhase('native-disconnect-rejected'));
    await bounded('native-disconnect', async () => {
      await Promise.all([
        until(() => ended.has(session.id), 15000).then(() => tracePhase('native-session-terminated')),
        until(() => started.output().includes('DEBUG_FIXTURE_RESUMED:73'), 15000).then(() => tracePhase('external-jvm-resumed'))
      ]);
    }, 16000);
    assert.equal(started.ended(), false);
    detached = true;
    await bounded('owned-fixture-exit', () => started.leave(), 10000);
    await bounded('exited-pid', () => assert.rejects(service.resolve(picked), /does not have a verified local JDWP listener/), 40000);
    const jdbc = await bounded('jdbc-readback', jdbcReadback, 30000);
    checks.push('Discovered a Spring-workspace JVM, rejected an ordinary listener and stale PID, then hit a native breakpoint and detached without saving an unrelated SQL draft or stopping the JVM.');
    return { springWorkspace: true, jdbc, pidResolved: true, dynamicallyAssignedPort: true,
      normalSocketExcluded: true, staleIdentityRefused: true, exitedTargetRefused: true,
      breakpoint: { line: fixture.line, watched: 73 }, detachedProcessSurvived: true, unrelatedSqlDraftPreserved: true };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    if (!detached) {
      await bounded('debug-cleanup', () => Promise.allSettled([...sessions.values()]
        .filter(session => !ended.has(session.id)).map(session => vscode.debug.stopDebugging(session))), 8000).catch(() => {});
    }
    tracker.dispose();
    endListener.dispose();
    try {
      if (draft && !draft.isClosed) await bounded('owned-sql-draft-cleanup', async () => {
        assert.ok(draft.isUntitled);
        assert.equal(draft.getText().replace(/\r\n/g, '\n'), draftText);
        await vscode.window.showTextDocument(draft, { preview: false, preserveFocus: false });
        assert.strictEqual(vscode.window.activeTextEditor?.document, draft);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await until(() => draft.isClosed, 4500);
      }, 10000);
    } finally {
      try { await bounded('fixture-cleanup', () => Promise.all([started?.leave(), nonDebug?.leave()]), 12000); }
      finally { if (created) await fs.rm(file, { force: true }); }
    }
  }
}

module.exports = { runJavaProcessChecks };
