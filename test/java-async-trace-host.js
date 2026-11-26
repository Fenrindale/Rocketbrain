'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { asyncTraceFixture, assertAsyncChain } = require('./helpers/java-async-trace-fixture');
const { virtualTraceFixture, checkVirtualChain, writeRejectedTraces, verifyVirtualCompletion, jdbcOptions } =
  require('./helpers/virtual-async-trace-fixture');
const { reactorTraceFixture, checkReactorChain, verifyReactorCompletion } = require('./helpers/reactor-async-trace-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runTraceChecks(api, vscode, checks, mode, useAutomaticLaunch = false) {
  const virtual = mode === 'virtual', reactor = mode === 'reactor';
  const springJdbc = virtual || reactor;
  const service = api.java.debug.asyncTrace;
  assert.ok(service?.copyHelper && service.inspect && service.openFrame);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['rocketbrain.java.copyAsyncTraceHelper', 'rocketbrain.java.showAsyncTaskStack']) assert.ok(commands.includes(command));
  if (reactor) assert.ok(service.copyReactorHelper && commands.includes('rocketbrain.java.copyReactorAsyncTraceHelper'));
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project = await importedSpring(api, workspace);
  const className = 'RbAsyncTrace' + randomBytes(5).toString('hex');
  const fixture = (reactor ? reactorTraceFixture : virtual ? virtualTraceFixture : asyncTraceFixture)('fixture.boot', className);
  const spring = springJdbc && JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const env = springJdbc ? (await jdbcOptions({ engine: spring.dbEngine, configFile: spring.dbConfigPath,
    classpathFile: path.join(spring.projectPath, 'build/runtime-classpath.txt') })).env : undefined;
  const root = path.join(workspace, 'src/main/java');
  const file = path.join(root, 'fixture/boot', className + '.java');
  const source = vscode.Uri.file(file);
  const temp = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(temp, 'rb-async-task-trace-'));
  const trace = vscode.Uri.file(path.join(owned, 'tasks.jsonl'));
  const name = 'Rocketbrain Async Fixture ' + className;
  const markers = reactor ? ['PERIODIC_STOP', 'REACTOR_STOP'] : virtual
    ? ['UNWRAPPED_STOP', 'VIRTUAL_STOP'] : ['UNTRACKED_STOP', 'ASYNC_STOP'];
  const breakpoints = markers.map(marker =>
    new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(fixture.line(marker) - 1, 0)), true));
  const events = [];
  const sessions = new Map();
  let helper, companion, created = false, completed = false;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(session) {
      if (session.configuration.name !== name) return undefined;
      sessions.set(session.id, session);
      return { onDidSendMessage(message) { if (message.type === 'event') events.push({ sessionId: session.id, ...message }); } };
    }
  });
  try {
    if (reactor) await assert.rejects(service.copyReactorHelper(vscode.Uri.file(root)), /Copy the current Java Async Trace Helper/);
    helper = await service.copyHelper(vscode.Uri.file(root));
    await assert.rejects(service.copyHelper(vscode.Uri.file(root)), /already exists/);
    if (reactor) {
      companion = await service.copyReactorHelper(vscode.Uri.file(root));
      await assert.rejects(service.copyReactorHelper(vscode.Uri.file(root)), /already exists/);
      await vscode.workspace.openTextDocument(companion);
    }
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
      args: [trace.fsPath], console: 'internalConsole', env,
      // These task fixtures use the full observed Spring classpath on Windows.
      ...(springJdbc && !useAutomaticLaunch && { shortenCommandLine: 'argfile' })
    }), true);
    const first = await until(() => events.find(event => event.event === 'stopped'), 30000);
    const session = sessions.get(first.sessionId);
    if (useAutomaticLaunch && process.platform === 'win32') assert.equal(session.configuration.shortenCommandLine, 'argfile');
    await until(() => vscode.debug.activeDebugSession?.id === session.id, 10000);
    const eventAfter = (index, kind) => until(() => events.slice(index).find(event =>
      event.sessionId === session.id && event.event === kind), 18000);
    async function top(threadId) {
      return (await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })).stackFrames[0];
    }
    assert.equal((await top(first.body.threadId)).line, fixture.line(markers[0]));
    await assert.rejects(service.inspect(trace, session), /No recorded Java task/);
    let index = events.length;
    await session.customRequest('continue', { threadId: first.body.threadId });
    const worker = await eventAfter(index, 'stopped');
    const stopped = await top(worker.body.threadId);
    assert.equal(stopped.line, fixture.line(markers[1]));
    assert.equal(path.relative(stopped.source.path, file), '');
    const report = await service.inspect(trace, session);
    const proof = reactor ? checkReactorChain(fixture, report) : virtual
      ? checkVirtualChain(fixture, report) : assertAsyncChain(report, fixture);
    const origin = report.chain[0].submissionFrames.find(frame => frame.type === fixture.mainClass && frame.method === 'queue');
    for (const frame of reactor ? proof.originFrames : virtual ? proof.frames : [origin]) {
      assert.equal(await service.openFrame(frame), true);
      const editor = vscode.window.activeTextEditor;
      assert.equal(path.relative(editor.document.uri.fsPath, file), '');
      assert.equal(editor.selection.active.line, frame.line - 1);
    }
    if (springJdbc) {
      const mismatches = ['other-id', 'other-worker', 'stripped-worker'].map(name => path.join(owned, name + '.jsonl'));
      await writeRejectedTraces(trace.fsPath, ...mismatches, report.taskId);
      for (const [index, mismatch] of mismatches.entries()) await assert.rejects(
        service.inspect(vscode.Uri.file(mismatch), session), index === 0 ? /different Java runtime/ : /worker identity differs/);
    }
    index = events.length;
    await session.customRequest('continue', { threadId: worker.body.threadId });
    await eventAfter(index, 'terminated');
    completed = true;
    const jdbc = await jdbcReadback();
    if (springJdbc) {
      const output = events.filter(event => event.sessionId === session.id && event.event === 'output').map(event => event.body.output).join('');
      const application = await (reactor ? verifyReactorCompletion : verifyVirtualCompletion)(trace.fsPath, output, spring.dbEngine);
      await assert.rejects(service.inspect(trace, session), /Pause a Rocketbrain Java task/);
      checks.push(reactor ? 'The native debugger linked a Spring JDBC Mono.delay worker to its Reactor subscribeOn parent and opened both actual submission sites.' :
        'The native debugger resolved a paused Spring JDBC virtual thread to two explicit launches and a CompletableFuture executor handoff.');
      return { ...proof, application, jdbc, pausedLine: stopped.line, sourceNavigation: true, unwrappedRejected: true,
        mismatchedTraceRejected: true, mismatchedWorkerRejected: true, strippedWorkerRejected: true, resumedInspectionRejected: true,
        ...(useAutomaticLaunch && { automaticLaunch: session.configuration.shortenCommandLine }) };
    }
    assert.ok(events.some(event => event.event === 'output' && event.body.output.includes('ASYNC_RESULT:42')));
    checks.push('Copied the packaged helper into a Spring source tree, traced an Executor and CompletableFuture handoff from a paused Java thread and navigated to its original submission.');
    return { ...proof, helperCopied: true, sourceNavigation: true, result: 42, untrackedFrameRejected: true, springWorkspace: true, jdbc };
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    if (!completed) await Promise.allSettled([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
    tracker.dispose();
    const active = vscode.window.activeTextEditor?.document;
    if (created && active?.uri.scheme === 'file' && !path.relative(active.uri.fsPath, file) && !active.isDirty) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    if (created) await fs.rm(file, { force: true });
    if (companion) await fs.rm(companion.fsPath, { force: true });
    if (helper) await fs.rm(helper.fsPath, { force: true });
    const physical = await fs.realpath(owned);
    if (path.relative(physical, owned) || path.relative(path.dirname(physical), temp) ||
        !path.basename(physical).startsWith('rb-async-task-trace-')) throw Error('The Java async fixture directory changed before cleanup.');
    await fs.rm(physical, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

const runJavaAsyncTraceChecks = (api, vscode, checks) => runTraceChecks(api, vscode, checks, 'executor');
const runJavaVirtualAsyncTraceChecks = (api, vscode, checks) => runTraceChecks(api, vscode, checks, 'virtual');
const runJavaReactorAsyncTraceChecks = (api, vscode, checks) => runTraceChecks(api, vscode, checks, 'reactor');

const runJavaAutomaticClasspathChecks = (api, vscode, checks) => runTraceChecks(api, vscode, checks, 'virtual', true);
module.exports = { runJavaAsyncTraceChecks, runJavaVirtualAsyncTraceChecks, runJavaAutomaticClasspathChecks, runJavaReactorAsyncTraceChecks };
