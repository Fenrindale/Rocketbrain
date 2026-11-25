'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { frameFixture, exerciseFrameRestart, exerciseLocalValues } = require('./helpers/java-frame-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runJavaFrameChecks(api, vscode, checks) {
  const service = api.java.debug.frames;
  const localValues = api.java.debug.localValues;
  assert.ok(service?.inspect && service?.restart);
  assert.ok(localValues?.inspect && localValues?.read && localValues?.show);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.java.restartStackFrame') && commands.includes('rocketbrain.java.inspectLocalValue'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const suffix = randomBytes(5).toString('hex');
  const fixture = frameFixture('fixture.boot', 'RbFrameRestart' + suffix);
  const file = path.join(workspace, 'src/main/java', fixture.mainFile);
  const source = vscode.Uri.file(file);
  const name = 'Rocketbrain restart frame ' + suffix;
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.gate - 1, 0)), true);
  const events = [];
  let session, viewer, created = false, terminated = false;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(active) {
      if (active.configuration.name !== name) return undefined;
      session = active;
      return { onDidSendMessage(message) { if (message.type === 'event') events.push(message); } };
    }
  });
  const findEvent = (event, start = 0) => events.slice(start).find(item => item.event === event);
  try {
    await fs.writeFile(file, fixture.source, { flag: 'wx' });
    created = true;
    await vscode.workspace.openTextDocument(source);
    const built = await api.java.buildWorkspace();
    assert.ok(built === 0 || built === 1 || built?.status === 'succeed');
    const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', project.uri))
      ?.find(item => item.mainClass === fixture.mainClass), 45000);
    vscode.debug.addBreakpoints([breakpoint]);
    const started = vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), {
      type: 'rocketbrain-java', request: 'launch', name, mainClass: fixture.mainClass, projectName: main.projectName, console: 'internalConsole'
    });
    let startupResult, startupError;
    void Promise.resolve(started).then(result => { startupResult = result; }, error => { startupError = error; });
    await until(() => {
      if (startupError) throw startupError;
      if (startupResult === false) throw Error('VS Code declined to start the Java restart fixture.');
      return startupResult === true;
    }, 50000);
    const first = (await until(() => findEvent('stopped'), 35000)).body;
    await until(() => vscode.debug.activeDebugSession?.id === session?.id && session, 10000);
    const inspected = await exerciseLocalValues(localValues, fixture, session);
    viewer = await localValues.show(inspected.review, 'samples');
    assert.equal(viewer.viewType, 'rocketbrain.java.localValues');
    assert.match(viewer.webview.html, /Start index/);
    viewer.dispose();
    viewer = undefined;
    const frame = async stop => (await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
    const proceed = async action => {
      const index = events.length;
      await action();
      return (await until(() => findEvent('stopped', index), 18000)).body;
    };
    const outcome = await exerciseFrameRestart({ fixture, service, session, first, proceed, frame });
    await assert.rejects(localValues.read(inspected.review, 'message'), /different position/);
    const index = events.length;
    await session.customRequest('continue', { threadId: outcome.stopped.threadId });
    await until(() => findEvent('terminated', index), 18000);
    terminated = true;
    const output = events.filter(message => message.event === 'output').map(message => message.body.output).join('');
    assert.match(output, /FRAME_ATTEMPT:1\s+FRAME_ATTEMPT:2\s+FRAME_RESULT:42:2/);
    assert.match(output, /FRAME_INSPECTION_CALLS:0/);
    const jdbc = await jdbcReadback();
    checks.push('Restarted the reviewed Java caller in an imported Spring workspace, observed the same JVM and thread re-enter it, and verified prior side effects persisted.');
    checks.push('Opened the Java local value viewer and read bounded pages and the complete string without calling application methods.');
    return { ...outcome.proof, springWorkspace: true, jdbc, finalResult: 42, sideEffectsBeforeRestartPreserved: true,
      localValues: { ...inspected.proof, nativeViewer: true, noTargetMethodCalls: true, staleValueRefused: true } };
  } finally {
    viewer?.dispose();
    vscode.debug.removeBreakpoints([breakpoint]);
    if (session && !terminated) void Promise.resolve(vscode.debug.stopDebugging(session)).catch(() => {});
    tracker.dispose();
    if (created) await fs.rm(file, { force: true });
  }
}

module.exports = { runJavaFrameChecks };
