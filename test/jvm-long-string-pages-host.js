'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JVM_STRING_PAGE_BUILD } = require('../src/java/debug-runtime');
const { buildCoroutineFixture } = require('./helpers/coroutine-fixture');
const { fixtureFrame, launchStringFixture, assertStrings, jdbcResult, jdbcLine } = require('./helpers/jvm-long-string-pages');
const { freePort } = require('./java-debug-dap');
const { until } = require('./helpers/stdio-lsp');

async function runJvmLongStringChecks(api, vscode, checks) {
  await api.java.start();
  assert.equal(api.java.getState().debugBuild, JVM_STRING_PAGE_BUILD);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.inspectLocalValue'));
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const folder = vscode.workspace.workspaceFolders[0], root = await fs.realpath(folder.uri.fsPath);
  const project = await fs.mkdtemp(path.join(root, 'rb-jvm-string-pages-'));
  const java = vscode.workspace.getConfiguration('rocketbrain.java');
  try {
    const fixture = await buildCoroutineFixture(project, { javaHome: java.get('javaHome') || api.java.getState().javaHome,
      gradleHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME || java.get('gradleHome'),
      gradleUserHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME });
    const database = { engine: spring.dbEngine, configFile: spring.dbConfigPath,
      classpathFile: path.join(spring.projectPath, 'build/runtime-classpath.txt') };
    const service = api.java.debug.localValues, languages = [];
    for (const language of ['java', 'kotlin']) {
      const { sourceRoot, source, breakpoint } = fixtureFrame(fixture, language);
      const port = await freePort(), running = await launchStringFixture(fixture, language, database, port);
      const line = new vscode.FunctionBreakpoint(breakpoint, true);
      const name = 'String pages · ' + language + ' ' + randomUUID().slice(0, 8);
      let session, ended = false, panel, failure;
      const started = vscode.debug.onDidStartDebugSession(active => {
        if (active.name === name && active.type === 'rocketbrain-java') session = active;
      });
      const terminated = vscode.debug.onDidTerminateDebugSession(active => { if (active.id === session?.id) ended = true; });
      vscode.debug.addBreakpoints([line]);
      try {
        await running.ready();
        const selected = await api.java.debug.processes.resolve(running.pid);
        assert.equal(selected.port, port);
        assert.equal(await api.java.debug.processes.attach(selected, { folder, name, sourcePaths: [sourceRoot] }), true);
        await until(() => session && api.java.debug.verifiedLocalPid(session) === running.pid, 20000);
        running.send('inspect');
        const stop = await until(() => {
          const current = api.java.debug.getState(session.id);
          return current?.state === 'stopped' && vscode.debug.activeDebugSession?.id === session.id ? current : undefined;
        }, 25000);
        const [frame] = (await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames;
        assert.equal(path.relative(source, frame.source.path), '');
        assert.ok(frame.line > 0);
        const report = await service.inspect(session);
        assert.ok(report.values.find(value => value.name === 'wide' && value.pageable === true && value.complete === false));
        assert.equal((await service.read(report, 'shortValue')).text, 'short value');
        const ranges = await assertStrings(local => service.read(report, local),
          (page, start, count) => service.readStringPage(page, { start, count }));
        panel = await service.show(report, 'wide');
        assert.match(panel.webview.html, /Isolated surrogates shown as escapes/u);
        const stale = await service.read(report, 'wide', { count: 1 });
        await session.customRequest('continue', { threadId: stop.threadId });
        const output = await running.waitFor(jdbcLine);
        await assert.rejects(service.readStringPage(stale, { start: 1 }), /paused|Pause|different position/u);
        languages.push({ ...jdbcResult(output, database.engine, language), source: path.basename(source), exactRanges: ranges,
          nativeViewer: true, resumedFrameRefused: true });
      } catch (error) { failure = error; throw error; }
      finally {
        vscode.debug.removeBreakpoints([line]);
        panel?.dispose();
        if (session && !ended) {
          void session.customRequest('disconnect', { terminateDebuggee: false }).catch(() => {});
          await until(() => ended, 10000).catch(() => {});
        }
        started.dispose();
        terminated.dispose();
        const code = await running.stop();
        if (!failure) assert.equal(code, 0, running.output());
      }
    }
    checks.jvmLongStrings = { debugBuild: JVM_STRING_PAGE_BUILD, command: true, languages };
  } finally {
    assert.equal(await fs.realpath(project), project);
    assert.equal(path.dirname(project), root);
    await fs.rm(project, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

module.exports = { runJvmLongStringChecks };
