'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DapClient, freePort } = require('./java-debug-dap');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { buildCoroutineFixture } = require('./helpers/coroutine-fixture');
const { jdbcOptions } = require('./helpers/coroutine-watch-fixture');
const { assertRawStrings, fixtureFrame, launchStringFixture, rawReader, jdbcResult, jdbcLine } = require('./helpers/jvm-long-string-pages');
const { resolveDebugBundle, JVM_STRING_PAGE_BUILD } = require('../src/java/debug-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { waitForOwnedListener } = require('../src/java/testing-debug');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleHome = process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME;
const classpathFile = process.env.ROCKETBRAIN_COROUTINE_WATCH_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_COROUTINE_WATCH_' + engine.toUpperCase() + '_CONFIG']]);

test('stock JVM String pages reconstruct real Java and Kotlin Spring JDBC values without expression evaluation', {
  skip: process.env.ROCKETBRAIN_TEST_JVM_STRING_PAGES !== '1' ||
    !runtimeFile || !gradleHome || !classpathFile || !dbFiles.every(([, file]) => file), timeout: 390000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const { javaHome, serverPath } = runtime;
  const bundle = resolveDebugBundle(runtime.settings['rocketbrain.java.debugBundlePath'], serverPath);
  assert.equal(bundle?.build, JVM_STRING_PAGE_BUILD);
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'rb-string-pages-'));
  let lsp;
  t.after(async () => {
    if (lsp) await lsp.close();
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const fixture = await buildCoroutineFixture(path.join(root, 'fixture'), {
    javaHome, gradleHome, gradleUserHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME || path.join(root, 'gradle-cache')
  });
  const libs = (await fs.readdir(fixture.lib)).filter(name => name.endsWith('.jar')).map(name => path.join(fixture.lib, name));
  const workspace = path.join(root, 'workspace'), rootUri = pathToFileURL(workspace).href;
  await fs.cp(path.resolve('test/fixtures/java/maven'), workspace, { recursive: true });
  lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, storagePath: path.join(root, 'lsp'), debugBundlePath: bundle.path }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'JVM String fixture' }],
    capabilities: { workspace: { configuration: true } }, initializationOptions: { bundles: [bundle.path],
      workspaceFolders: [rootUri], settings: serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]) } }, 90000);
  lsp.notify('initialized', {});

  async function run(language, database, mode) {
    const { source, mainClass, sourceRoot, breakpoint } = fixtureFrame(fixture, language);
    const jdwp = mode === 'launch' ? null : await freePort();
    const running = jdwp ? await launchStringFixture(fixture, language, database, jdwp) : null;
    let dap, failure;
    try {
      if (running) await running.ready();
      if (mode === 'verified-attach') {
        const ownership = await waitForOwnedListener({ pid: running.pid, port: jdwp });
        assert.deepEqual([ownership.verified, ownership.pid, ownership.port], [true, running.pid, jdwp]);
      }
      const port = await until(() => lsp.request('workspace/executeCommand',
        { command: 'vscode.java.startDebugSession', arguments: [] }, 10000), 65000);
      dap = new DapClient(port);
      const send = (method, args) => dap.request(method, args, 15000);
      await send('initialize', { adapterID: 'rocketbrain-java', clientID: 'rocketbrain-string-proof',
        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      const { classpath, env } = await jdbcOptions(database);
      const starting = mode === 'launch' ? send('launch', { mainClass, javaExec: fixture.java, classPaths: [...libs, ...classpath],
        sourcePaths: [sourceRoot], cwd: fixture.root, env, shortenCommandLine: 'argfile', console: 'internalConsole' }) :
        send('attach', { hostName: '127.0.0.1', port: jdwp, sourcePaths: [sourceRoot],
          ...(mode === 'verified-attach' && { rocketbrainLocalKotlinFieldValues: true }) });
      void starting.catch(() => {});
      await dap.event('initialized');
      await send('setFunctionBreakpoints', { breakpoints: [{ name: breakpoint }] });
      await send('configurationDone');
      await starting;
      if (running) running.send('inspect');
      const stopped = await dap.event('stopped', 0, 30000);
      assert.equal(stopped.reason, 'function breakpoint');
      const [frame] = (await send('stackTrace', { threadId: stopped.threadId, startFrame: 0, levels: 1 })).stackFrames;
      assert.match(frame.name, /paused/u);
      assert.equal(path.relative(source, frame.source.path), '');
      const read = rawReader(send, frame.id);
      let control;
      if (mode === 'manual-attach') {
        const values = (await read('list')).values;
        assert.equal(values.find(value => value.name === 'wide')?.pageable, false);
        assert.equal((await read('string', { name: 'shortValue' })).text, 'short value');
        await assert.rejects(read('stringOpen', { name: 'wide', start: 0, count: 1 }), /verified local attach/u);
        control = { unverifiedLoopbackRefused: true };
      } else control = await assertRawStrings(read);
      await send('continue', { threadId: stopped.threadId });
      if (control.afterResume) {
        await assert.rejects(control.afterResume(), /frame|resumed|DAP connection closed/u);
        delete control.afterResume;
        control.resumedFrameRefused = true;
      }
      const stdout = () => dap.events.filter(event => event.event === 'output' && event.body?.category === 'stdout')
        .map(event => event.body.output).join('');
      const output = running ? await running.waitFor(jdbcLine) : await until(() => jdbcLine.test(stdout()) && stdout(), 30000);
      return { ...jdbcResult(output, database.engine, language), mode, source: path.basename(source), line: frame.line, ...control };
    } catch (error) { failure = error; throw error; }
    finally {
      if (dap) await dap.close();
      if (running) {
        const code = await running.stop();
        if (!failure) assert.equal(code, 0, running.output());
      }
    }
  }

  const reports = [];
  for (const [engine, configFile] of dbFiles) {
    const database = { engine, configFile, classpathFile };
    for (const [language, mode] of [['java', 'launch'], ['kotlin', 'verified-attach']]) {
      const report = await run(language, database, mode);
      reports.push(report);
      console.log(JSON.stringify({ engine, language, mode, stringPages: report.ranges, springRows: report.springRows }));
    }
  }
  const manual = await run('java', { engine: dbFiles[0][0], configFile: dbFiles[0][1], classpathFile }, 'manual-attach');
  const receipt = process.env.ROCKETBRAIN_JVM_STRING_PAGES_RECEIPT;
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ debugBuild: bundle.build, sha256: bundle.sha256,
    kotlin: '2.4.21', reports, manual }, null, 2) + '\n', { flag: 'wx' });
});
