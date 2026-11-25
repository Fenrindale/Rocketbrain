'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { smartStepFixture, exerciseSmartStep } = require('./helpers/java-smart-step-fixture');

async function runJavaSmartStepChecks(api, vscode, checks) {
  const service = api.java.debug.smartStep;
  assert.ok(service?.inspect && service?.step);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.smartStepInto'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const suffix = randomBytes(5).toString('hex');
  const fixture = smartStepFixture('fixture.boot.rbsmartstep' + suffix);
  const sourceRoot = path.join(workspace, 'src/main/java');
  const source = vscode.Uri.file(path.join(sourceRoot, fixture.mainFile));
  const name = 'Rocketbrain Smart Step ' + suffix;
  const configuration = vscode.workspace.getConfiguration('rocketbrain.java');
  const previous = configuration.inspect('stepFilters')?.workspaceValue;
  const events = [];
  const sessions = new Map();
  const created = [];
  const breakpoints = fixture.gates.map(marker =>
    new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.line(marker) - 1, 0)), true));
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(session) {
      if (session.configuration.name !== name) return undefined;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, ...message }); } };
    }
  });
  try {
    for (const [relative, text] of fixture.paths) {
      const file = path.join(sourceRoot, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, { flag: 'wx' });
      created.push(file);
      await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    }
    const built = await api.java.buildWorkspace();
    assert.ok(built === 0 || built === 1 || built?.status === 'succeed');
    const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', project.uri))
      ?.find(item => item.mainClass === fixture.mainClass), 45000);
    await configuration.update('stepFilters', fixture.filters, vscode.ConfigurationTarget.Workspace);
    vscode.debug.addBreakpoints(breakpoints);
    assert.equal(await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), {
      type: 'rocketbrain-java', request: 'launch', name, mainClass: fixture.mainClass, projectName: main.projectName,
      console: 'internalConsole', stepFilters: { skipSynthetics: true }
    }), true);
    const initial = await until(() => events.find(item => item.event === 'stopped'), 35000);
    const session = sessions.get(initial.sessionId);
    await until(() => vscode.debug.activeDebugSession?.id === session.id, 10000);
    assert.deepEqual(session.configuration.stepFilters, { ...fixture.filters, skipSynthetics: true });
    const findEvent = (index, event) => events.slice(index).find(item => item.sessionId === session.id && item.event === event);
    const frame = async stop => (await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
    const proceed = async action => {
      const index = events.length;
      await action();
      return (await until(() => findEvent(index, 'stopped'), 18000)).body;
    };
    const outcome = await exerciseSmartStep({ fixture, service, first: initial.body, session, frame, proceed });
    const index = events.length;
    await session.customRequest('continue', { threadId: outcome.stopped.threadId });
    await until(() => findEvent(index, 'terminated'), 18000);
    const jdbc = await jdbcReadback();
    checks.push('Selected the second overloaded Java call in a real JVM and verified package, exact class and unfiltered steps in an imported Spring workspace.');
    return { ...outcome.proof, javaFilters: true, springWorkspace: true, jdbc };
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    tracker.dispose();
    await configuration.update('stepFilters', previous, vscode.ConfigurationTarget.Workspace);
    for (const file of created.reverse()) await fs.rm(file, { force: true });
  }
}

module.exports = { runJavaSmartStepChecks };
