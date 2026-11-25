'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { asyncTraceFixture, assertAsyncChain } = require('./helpers/java-async-trace-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runJavaAsyncTraceChecks(api, vscode, checks) {
  const service = api.java.debug.asyncTrace;
  assert.ok(service?.copyHelper && service.inspect && service.openFrame);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['rocketbrain.java.copyAsyncTraceHelper', 'rocketbrain.java.showAsyncTaskStack']) assert.ok(commands.includes(command));
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project = await importedSpring(api, workspace);
  const className = 'RbAsyncTrace' + randomBytes(5).toString('hex');
  const fixture = asyncTraceFixture('fixture.boot', className);
  const root = path.join(workspace, 'src/main/java');
  const file = path.join(root, 'fixture/boot', className + '.java');
  const source = vscode.Uri.file(file);
  const owned = await fs.mkdtemp(path.join(workspace, 'rb-async-task-trace-'));
  const trace = vscode.Uri.file(path.join(owned, 'tasks.jsonl'));
  const name = 'Rocketbrain Async Fixture ' + className;
  const breakpoints = ['UNTRACKED_STOP', 'ASYNC_STOP'].map(marker =>
    new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.line(marker) - 1, 0)), true));
  const events = [];
  const sessions = new Map();
  let helper, created = false, completed = false;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(session) {
      if (session.configuration.name !== name) return undefined;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, ...message }); } };
    }
  });
  try {
    helper = await service.copyHelper(vscode.Uri.file(root));
    await assert.rejects(service.copyHelper(vscode.Uri.file(root)), /already exists/);
    await fs.writeFile(file, fixture.source, { flag: 'wx' });
    created = true;
    await vscode.workspace.openTextDocument(helper);
    await vscode.workspace.openTextDocument(source);
    const built = await api.java.buildWorkspace();
    assert.ok(built === 0 || built === 1 || built?.status === 'succeed');
    const main = await until(async () => (await api.java.executeWorkspaceCommand('vscode.java.resolveMainClass', project.uri))
      ?.find(item => item.mainClass === fixture.mainClass), 45000);
    vscode.debug.addBreakpoints(breakpoints);
    assert.equal(await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source), {
      type: 'rocketbrain-java', request: 'launch', name, mainClass: fixture.mainClass, projectName: main.projectName,
      args: [trace.fsPath], console: 'internalConsole'
    }), true);
    const first = await until(() => events.find(event => event.event === 'stopped'), 30000);
    const session = sessions.get(first.sessionId);
    await until(() => vscode.debug.activeDebugSession?.id === session.id, 10000);
    const eventAfter = (index, kind) => until(() => events.slice(index).find(event =>
      event.sessionId === session.id && event.event === kind), 18000);
    await assert.rejects(service.inspect(trace, session), /No recorded Java task/);
    let index = events.length;
    await session.customRequest('continue', { threadId: first.body.threadId });
    const worker = await eventAfter(index, 'stopped');
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: worker.body.threadId, startFrame: 0, levels: 1 });
    assert.equal(stackFrames[0].line, fixture.line('ASYNC_STOP'));
    const report = await service.inspect(trace, session);
    const proof = assertAsyncChain(report, fixture);
    const origin = report.chain[0].submissionFrames.find(frame => frame.type === fixture.mainClass && frame.method === 'queue');
    assert.equal(await service.openFrame(origin), true);
    const editor = vscode.window.activeTextEditor;
    assert.equal(path.relative(editor.document.uri.fsPath, file), '');
    assert.equal(editor.selection.active.line, origin.line - 1);
    index = events.length;
    await session.customRequest('continue', { threadId: worker.body.threadId });
    await eventAfter(index, 'terminated');
    completed = true;
    assert.ok(events.some(event => event.event === 'output' && event.body.output.includes('ASYNC_RESULT:42')));
    const jdbc = await jdbcReadback();
    checks.push('Copied the packaged helper into a Spring source tree, traced an Executor and CompletableFuture handoff from a paused Java thread and navigated to its original submission.');
    return { ...proof, helperCopied: true, sourceNavigation: true, result: 42, untrackedFrameRejected: true, springWorkspace: true, jdbc };
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    if (!completed) await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    tracker.dispose();
    if (created) await fs.rm(file, { force: true });
    if (helper) await fs.rm(helper.fsPath, { force: true });
    const physical = await fs.realpath(owned);
    if (path.relative(physical, owned) || path.relative(path.dirname(physical), workspace) ||
        !path.basename(physical).startsWith('rb-async-task-trace-')) throw Error('The Java async fixture directory changed before cleanup.');
    await fs.rm(physical, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

module.exports = { runJavaAsyncTraceChecks };
