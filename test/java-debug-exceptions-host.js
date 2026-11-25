'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { exceptionFixture } = require('./helpers/java-exception-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runJavaExceptionChecks(api, vscode, checks) {
  const service = api.java.debug.exceptions;
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.java.configureExceptionBreakpoints'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const base = 'fixture.boot.rbexceptions' + randomBytes(4).toString('hex');
  const fixture = exceptionFixture(base);
  const sourceRoot = path.join(workspace, 'src/main/java');
  const source = vscode.Uri.file(path.join(sourceRoot, fixture.source));
  const config = vscode.workspace.getConfiguration('rocketbrain.java');
  const previous = config.inspect('exceptionBreakpoints')?.workspaceValue;
  const name = 'Rocketbrain Java Exception Fixture ' + base;
  const events = [];
  const sessions = new Map();
  const created = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(session) {
      if (session.configuration.name !== name) return undefined;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, ...message }); } };
    }
  });
  try {
    for (const [relative, text] of fixture.files) {
      const file = path.join(sourceRoot, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, { flag: 'wx' });
      created.push(file);
      await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    }
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed', JSON.stringify(build));
    const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', project.uri))
      ?.find(item => item.mainClass === fixture.mainClass), 45000);
    const empty = { exceptionTypes: [], allowClasses: [], skipClasses: [] };
    const modes = {};
    assert.match(api.java.getState().debugBuild, /^0\.53\.1\.rocketbrain[34]$/);
    for (const mode of ['caught', 'uncaught', 'multiple']) {
      const filter = mode === 'uncaught' ? 'uncaught' : 'caught';
      const policy = mode === 'multiple' ? {
        ...fixture.policy, exceptionTypes: [fixture.childType, ...fixture.policy.exceptionTypes, fixture.alternateType]
      } : fixture.policy;
      const initial = mode === 'caught' ? empty : policy;
      assert.deepEqual(await service.update(initial), initial);
      const baseIndex = events.length;
      const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), {
        type: 'rocketbrain-java', request: 'launch', name, mainClass: fixture.mainClass,
        projectName: main.projectName, args: [mode === 'multiple' ? mode : 'uncaught'], stopOnEntry: true, console: 'internalConsole'
      });
      assert.equal(started, true);
      let stop = await until(() => events.slice(baseIndex).find(item => item.event === 'stopped'), 30000);
      assert.equal(stop.body.reason, 'entry');
      const session = sessions.get(stop.sessionId);
      const relevant = (index, predicate) => events.slice(index).find(item => item.sessionId === session.id && predicate(item));
      await session.customRequest('setExceptionBreakpoints', { filters: [filter] });
      if (mode === 'caught') assert.deepEqual(await service.update(policy), policy);
      const expected = mode === 'multiple' ? ['caught', 'alternate'] : [filter];
      const observed = [];
      for (const marker of expected) {
        const before = events.length;
        await session.customRequest('continue', { threadId: stop.body.threadId });
        stop = await until(() => relevant(before, item => item.event === 'stopped'), 18000);
        assert.equal(stop.body.reason, 'exception');
        const { stackFrames } = await session.customRequest('stackTrace', { threadId: stop.body.threadId });
        const info = await session.customRequest('exceptionInfo', { threadId: stop.body.threadId });
        assert.match(info.exceptionId, marker === 'alternate' ? /AlternateFailure/ : /ChildFailure/);
        assert.equal(stackFrames[0].line, fixture.line('wanted-' + marker));
        observed.push({ subtype: info.exceptionId.split('$').at(-1), line: stackFrames[0].line });
      }
      const after = events.length;
      await session.customRequest('continue', { threadId: stop.body.threadId });
      const next = await until(() => relevant(after, item => ['stopped', 'terminated'].includes(item.event)), 18000);
      assert.equal(next.event, 'terminated');
      assert.equal(events.slice(baseIndex).filter(item => item.sessionId === session.id && item.body?.reason === 'exception').length, expected.length);
      modes[mode] = { filter, observed, activePolicyUpdate: mode === 'caught' };
    }
    const jdbc = await jdbcReadback();
    checks.push('Verified typed caught and uncaught exception stops, live workspace filter changes and excluded library throw sites in the installed Java debugger with an imported Spring project.');
    return { ...modes, noDuplicateStops: true, springWorkspace: true, jdbc };
  } finally {
    await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    tracker.dispose();
    await config.update('exceptionBreakpoints', previous, vscode.ConfigurationTarget.Workspace);
    for (const file of created.reverse()) await fs.rm(file, { force: true });
  }
}

module.exports = { runJavaExceptionChecks };
