'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD } = require('../src/java/debug-runtime');
const { freePort } = require('./java-debug-dap');
const { until } = require('./helpers/stdio-lsp');
const { buildCoroutineFixture } = require('./helpers/coroutine-fixture');
const { request, breakpointName, launchKotlinWatches, assertKotlinWatchValues, assertIndexedKotlinWatchValues, kotlinWatchJdbcResult } =
  require('./helpers/kotlin-watch-expressions');

async function runKotlinWatchExpressionChecks(api, vscode, checks) {
  await api.java.start();
  const debugBuild = api.java.getState().debugBuild;
  assert.ok([WATCH_BUILD,INDEXED_WATCH_BUILD,KOTLIN_LOCAL_WRITE_BUILD].includes(debugBuild));
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project = await fs.mkdtemp(path.join(workspace, 'rb-kotlin-expressions-'));
  const name = 'Kotlin expression fixture ' + randomUUID().slice(0, 8);
  const breakpoint = new vscode.FunctionBreakpoint(breakpointName, true);
  const port = await freePort();
  let running, session, closed = false;
  const started = vscode.debug.onDidStartDebugSession(active => {
    if (active.name === name && active.type === 'rocketbrain-java') session = active;
  });
  const terminated = vscode.debug.onDidTerminateDebugSession(ended => { if (ended.id === session?.id) closed = true; });

  async function detach() {
    if (!session || closed) return;
    // Disconnect may close the DAP socket before it can acknowledge the request.
    void session.customRequest('disconnect', { terminateDebuggee: false }).catch(() => {});
    await until(() => closed, 10000);
  }

  try {
    const settings = vscode.workspace.getConfiguration('rocketbrain.java');
    const fixture = await buildCoroutineFixture(project, { javaHome: settings.get('javaHome') || api.java.getState().javaHome,
      gradleHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME || settings.get('gradleHome'),
      gradleUserHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME });
    const sourceRoot = path.join(fixture.root, 'src/main/kotlin');
    running = await launchKotlinWatches(fixture, { engine: spring.dbEngine, configFile: spring.dbConfigPath,
      classpathFile: path.join(spring.projectPath, 'build/runtime-classpath.txt') }, port);
    await running.ready();
    const target = await api.java.debug.processes.resolve(running.pid);
    assert.equal(target.port, port);
    vscode.debug.addBreakpoints([breakpoint]);
    assert.equal(await api.java.debug.processes.attach(target, {
      folder: vscode.workspace.workspaceFolders[0], name, sourcePaths: [sourceRoot]
    }), true);
    await until(() => session && api.java.debug.verifiedLocalPid(session) === running.pid, 18000);
    running.send('inspect');
    const stop = await until(() => {
      const state = api.java.debug.getState(session.id);
      return state?.state === 'stopped' ? state : undefined;
    }, 18000);
    const [frame] = (await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames;
    assert.equal(path.relative(path.join(sourceRoot, 'coroutinesfixture/KotlinWatchInspection.kt'), frame.source.path), '');
    const send = (method, arguments_) => session.customRequest(method, arguments_);
    const values = await assertKotlinWatchValues(send, frame.id);
    const indexed = debugBuild !== WATCH_BUILD ? await assertIndexedKotlinWatchValues(send, frame.id) : undefined;
    let write;
    if(debugBuild===KOTLIN_LOCAL_WRITE_BUILD){
      assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.setKotlinLocal'));
      const locals=api.java.debug.kotlinLocals;
      const original=await locals.list(session);
      const cancelled=await locals.prepare(original,'amount','152');
      await locals.cancel(cancelled);
      await assert.rejects(locals.apply(cancelled),/Review the current Kotlin frame/u);
      const review=await locals.prepare(original,'amount','159');
      assert.deepEqual(review,{name:'amount',type:'Int',before:'42',after:'159'});
      assert.deepEqual(await locals.apply(review),{state:'applied',name:'amount',value:'159'});
      assert.equal((await send('evaluate',{frameId:frame.id,expression:'amount',context:'watch'})).result,'159');
      const restore=await locals.prepare(original,'amount','42');
      await locals.apply(restore);
      write={nativeCommand:true,changedAndRestored:true,cancelledRefused:true};
    }
    await send('continue', { threadId: stop.threadId });
    const application = kotlinWatchJdbcResult(await running.waitFor('Rocketbrain Kotlin JDBC|'), spring.dbEngine);
    await assert.rejects(send(request, { frameId: frame.id, expression: 'amount' }), /current suspended frame/u);
    await detach();
    checks.push('The native debugger evaluates typed Kotlin Watch, Hover and Debug Console expressions in the paused Spring JDBC stack.');
    checks.push('Unsupported Kotlin assignments and function calls leave the JVM unchanged, and a resumed frame cannot be reused.');
    if (indexed) checks.push('Kotlin Watch reads array and standard JVM list size and indexed values through JDI, with custom getters excluded.');
    if(write)checks.push('The native debugger explicitly reviewed a Kotlin local value, changed it, observed it in Watch and restored it before resume.');
    return { ...application, frameLine: frame.line, values, indexed, write, staleFrameRefused: true };
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    await detach().catch(() => {});
    started.dispose();
    terminated.dispose();
    if (running) await running.stop();
    const owned = await fs.realpath(project);
    assert.equal(path.relative(workspace, path.dirname(owned)), '');
    assert.ok(path.basename(owned).startsWith('rb-kotlin-expressions-'));
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

module.exports = { runKotlinWatchExpressionChecks };
