'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { COROUTINE_BUILD, WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD } = require('../src/java/debug-runtime');
const { readCoroutineDescriptor, fetchCoroutineSnapshot } = require('../src/java/kotlin-coroutine-probe');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { freePort } = require('./java-debug-dap');
const { buildCoroutineFixture, launchCoroutineFixture } = require('./helpers/coroutine-fixture');
const { watchTarget, jdbcOptions, jdbcResult } = require('./helpers/coroutine-watch-fixture');

async function runKotlinCoroutineDebugChecks(api, vscode, checks) {
  const service = api.java.coroutines;
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project = await importedSpring(api, workspace);
  assert.ok([COROUTINE_BUILD, WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD].includes(api.java.getState().debugBuild));
  for (const name of ['prepareDebug', 'watchFrame', 'detachDebugger']) {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.coroutines.' + name));
  }
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(spring.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root = await fs.mkdtemp(path.join(workspace, 'rb-coro-watch-'));
  let prepared, running;
  try {
    const config = vscode.workspace.getConfiguration('rocketbrain.java');
    const javaHome = project.jdk || config.get('javaHome') || api.java.getState().javaHome;
    const gradleHome = process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME || config.get('gradleHome');
    const fixture = await buildCoroutineFixture(root, { javaHome, gradleHome,
      gradleUserHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME });
    const launch = await jdbcOptions({ engine: spring.dbEngine, configFile: spring.dbConfigPath,
      classpathFile: path.join(spring.projectPath, 'build/runtime-classpath.txt') });
    prepared = await service.prepare({ debugJar: fixture.debugJar, allowProbeWrites: true, debugPort: await freePort() });
    running = launchCoroutineFixture(fixture, prepared, launch);
    await running.ready();
    const descriptor = await readCoroutineDescriptor(prepared.descriptor);
    const snapshot = await service.connect({ descriptorFile: prepared.descriptor });
    const selection = watchTarget(snapshot);
    assert.equal(snapshot.pid, running.pid);
    await assert.rejects(service.watchFrame({ ordinal: selection.ordinal, capture: randomUUID() }), /opted-in probe/u);
    const intent = await service.watchFrame({ ordinal: selection.ordinal, capture: snapshot.debugCapture });
    assert.equal(intent.state, 'armed');
    assert.equal(intent.sequence, selection.selected.sequence);
    running.send('sibling');
    await running.waitFor('Rocketbrain coroutine sibling resumed');
    assert.equal(service.getDebugFrame(), undefined);
    running.send('selected');
    const frame = await until(() => service.getDebugFrame(), 15000);
    assert.equal(frame.sessionId, intent.sessionId);
    assert.equal(frame.sequence, selection.selected.sequence);
    assert.equal(frame.parkedLine, selection.selected.line);
    assert.equal(frame.file, 'CoroutineWatch.kt');
    assert.equal(vscode.debug.activeDebugSession?.id, frame.sessionId);
    const kotlin = path.join(root, 'src/main/kotlin/coroutinesfixture/CoroutineWatch.kt');
    await until(() => {
      const active = vscode.window.activeTextEditor;
      return active?.document.uri.scheme === 'file' && !path.relative(kotlin, active.document.uri.fsPath) &&
        active.selection.active.line === frame.line - 1;
    }, 10000);
    assert.ok(!running.output().includes('Rocketbrain coroutine selected resumed'));
    running.send('status');
    const application = jdbcResult(await running.waitFor('Rocketbrain coroutine fixture still running'), spring.dbEngine);
    assert.equal((await service.detachDebugger()).state, 'debugger-detached');
    assert.equal(service.getDebugFrame(), undefined);
    await running.waitFor('Rocketbrain coroutine selected resumed');
    assert.equal((await fetchCoroutineSnapshot(descriptor)).pid, running.pid);
    assert.ok(await jdbcReadback());
    checks.push('Attached the Java debugger to an already-running opted-in Kotlin JVM and opened its exact coroutine resume frame.');
    checks.push('A sibling with the same display name, class and source line ran without stopping. Spring JDBC continued while the selected thread paused and after detach.');
    return { ...application, selectedParkedLine: frame.parkedLine, resumedLine: frame.line, exactInstance: true,
      nativeAttach: true, nativeSourceFocus: true, priorCaptureRefused: true, detachedAppContinued: true };
  } finally {
    await service.detachDebugger().catch(() => {});
    service.disconnect();
    if (running) await running.stop();
    for (const editor of vscode.window.visibleTextEditors.filter(item => item.document.uri.fsPath.startsWith(root + path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    if (prepared) {
      const stage = await fs.realpath(path.dirname(prepared.jar));
      const storage = path.join(await fs.realpath(os.tmpdir()), 'kotlin-coroutine-probes');
      assert.equal(path.relative(path.dirname(stage), storage), '');
      assert.ok(path.basename(stage).startsWith('probe-'));
      await fs.rm(stage, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
    const owned = await fs.realpath(root);
    assert.equal(path.relative(path.dirname(owned), workspace), '');
    assert.ok(path.basename(owned).startsWith('rb-coro-watch-'));
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

module.exports = { runKotlinCoroutineDebugChecks };
