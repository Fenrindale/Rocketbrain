'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSbtRunner, testSuites } = require('../src/java/scala-sbt');
const { version: adapterVersion } = require('../src/java/scala-debug-runtime');
const { DapClient } = require('./java-debug-dap');
const { until } = require('./helpers/stdio-lsp');
const { populateScala, scala2, scala3 } = require('./helpers/scala-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

const suite = 'scalafixture.ApplicationSuite';
const otherSuite = 'scalafixture.UnselectedSuite';
const greetingPassed = 'Scala greeting test passed';
const countingPassed = 'Scala counting test passed';
const jdbcPassed = 'Scala MUnit Spring JDBC verified';
const excluded = 'Unselected suite must stay idle';

async function jdbcSource() {
  if (!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) return [];
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const url = JSON.stringify(config.baseUrl + '/probe/testing-state');
  return [
    'val request = java.net.http.HttpRequest.newBuilder(java.net.URI.create('+url+')).timeout(java.time.Duration.ofSeconds(6)).build()',
    'val response = java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString())',
    'assertEquals(response.statusCode(), 200)',
    'assert(response.body().contains('+JSON.stringify('"people":2')+'))',
    'println("'+jdbcPassed+'")'
  ];
}

async function ownedFixture(parent, version, work) {
  const directory = await fs.realpath(parent);
  const root = await fs.mkdtemp(path.join(directory, 'rb-scala-suite-'));
  try {
    await populateScala(root, version);
    const source = path.join(root, 'app/src/test/scala/scalafixture/ApplicationSuite.scala');
    const initial = await fs.readFile(source, 'utf8');
    const jdbc = await jdbcSource();
    const greeting = 'assertEquals(Application.greeting, "Scala greets Rocketbrain")';
    const counting = 'assertEquals(Application.count, "Scala counted 3")';
    assert.ok(initial.includes(greeting) && initial.includes(counting));
    const text = initial.replace(greeting, [greeting, ...jdbc, 'println("'+greetingPassed+'")'].join('\n    '))
      .replace(counting, ['val number = 3', 'assertEquals(Application.count, "Scala counted " + number)',
        'println("'+countingPassed+'")'].join('\n    '));
    await fs.writeFile(source, text);
    await fs.writeFile(path.join(path.dirname(source), 'UnselectedSuite.scala'), [
      'package scalafixture', '',
      'class UnselectedSuite extends munit.FunSuite {',
      '  test("keeps other suites outside the selected debugger") {',
      '    println("'+excluded+'")', '    throw new AssertionError("'+excluded+'")', '  }', '}', ''
    ].join('\n'), { flag: 'wx' });
    await fs.writeFile(path.join(root, 'project/plugins.sbt'),
      'addSbtPlugin("ch.epfl.scala" % "sbt-debug-adapter" % "'+adapterVersion+'")\n', { flag: 'wx' });
    const line = text.split('\n').findIndex(value => value.includes('"Scala counted " + number')) + 1;
    assert.ok(line > 0);
    return await work(root, source, line, Boolean(jdbc.length));
  } finally {
    const physical = await fs.realpath(root);
    assert.equal(path.relative(directory, path.dirname(physical)), '');
    assert.match(path.basename(physical), /^rb-scala-suite-[A-Za-z0-9]{6}$/);
    await fs.rm(physical, { recursive: true, maxRetries: 8, retryDelay: 250 });
  }
}

async function readTestFrame(request, threadId, source, line) {
  const frame = (await request('stackTrace', { threadId })).stackFrames[0];
  assert.equal(frame.line, line);
  assert.equal(path.relative(frame.source.path, source), '');
  assert.match(frame.name, /ApplicationSuite/);
  const scopes = (await request('scopes', { frameId: frame.id })).scopes;
  const local = scopes.find(scope => /local/i.test(scope.name));
  assert.ok(local, 'The Scala test frame exposes a local scope.');
  const variables = (await request('variables', { variablesReference: local.variablesReference })).variables;
  assert.equal(variables.find(variable => variable.name === 'number')?.value, '3');
  return { line, local: '3' };
}

function suiteOutput(events) {
  return events.filter(event => event.event === 'output').map(event => event.body.output).join('');
}

function assertFinishedSuite(events, jdbcInSuite) {
  const output = suiteOutput(events);
  assert.ok(output.includes(greetingPassed) && output.includes(countingPassed), output);
  assert.doesNotMatch(output, new RegExp(excluded));
  if (jdbcInSuite) assert.ok(output.includes(jdbcPassed), output);
  return { passed: 2, selectedSuiteOnly: true, jdbcInSuite };
}

function launcherSettings() {
  return {
    launcher: process.env.ROCKETBRAIN_SBT_LAUNCHER,
    cache: process.env.ROCKETBRAIN_SBT_CACHE,
    repositoryConfig: process.env.ROCKETBRAIN_SBT_REPOSITORIES
  };
}

async function runScalaTestDebugHeadless(version) {
  return ownedFixture(os.tmpdir(), version, async (root, source, line, jdbcInSuite) => {
    const runner = createSbtRunner({ log: text => process.stderr.write(text) });
    let client;
    const options = { ...launcherSettings(), root, projectId: 'app', suite,
      javaHome: process.env.ROCKETBRAIN_SPRING_JAVA_HOME, workspaceTrusted: true, allowProjectExecution: true };
    try {
      const discovery = await runner.run({ ...options, action: 'suites' });
      assert.equal(discovery.state, 'succeeded', discovery.output);
      const discovered = testSuites(discovery.output).sort();
      assert.deepEqual(discovered, [suite, otherSuite]);
      const aggregation = await runner.run({ ...options, action: 'suites', projectId: 'root' });
      assert.equal(aggregation.state, 'succeeded', aggregation.output);
      assert.deepEqual(testSuites(aggregation.output), []);

      const target = await runner.debugSuite(options);
      const proof = await runner.verifyDebug(target);
      assert.equal(proof.address, '127.0.0.1');
      assert.equal(proof.verified, true);
      client = new DapClient(proof.port);
      const request = (...args) => client.request(...args);
      await request('initialize', { adapterID: 'scala', clientID: 'rocketbrain-scala',
        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      const launch = request('launch', { name: 'Scala test', type: 'rocketbrain-scala', request: 'launch', noDebug: false });
      void launch.catch(() => {});
      await client.event('initialized');
      await request('setBreakpoints', { source: { name: path.basename(source), path: source }, breakpoints: [{ line }] });
      await request('configurationDone');
      await launch;
      const stop = await client.event('stopped');
      assert.equal(stop.reason, 'breakpoint');
      const frame = await readTestFrame(request, stop.threadId, source, line);
      await request('continue', { threadId: stop.threadId });
      await client.event('terminated');
      const result = assertFinishedSuite(client.events, jdbcInSuite);
      await client.close();
      await runner.stop();
      await assert.rejects(runner.verifyDebug(target), /owned Scala debugger has ended/);
      return { version, suite, discovered, frame, ...result, verifiedLoopback: true, jdbc: await jdbcReadback() };
    } finally {
      try { await client?.close(); }
      finally { await runner.dispose(); }
    }
  });
}

async function runScalaTestDebugChecks(api, vscode, checks, version = scala2) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const service = api.java.scala;
  return ownedFixture(workspace, version, async (root, source, line, jdbcInSuite) => {
    const options = { projectUri: pathToFileURL(root).href, projectId: 'app', suite, allowProjectExecution: true };
    let breakpoint, tracker, session;
    try {
      assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.scala.debugSuite'));
      await assert.rejects(service.debugSuite({ ...options, allowProjectExecution: false }), /Explicitly choose the sbt task/);
      assert.ok((await service.discover(options)).projects.some(project => project.id === 'app'));
      const discovered = (await service.testSuites(options)).suites.sort();
      assert.deepEqual(discovered, [suite, otherSuite]);
      await assert.rejects(service.debugSuite({ ...options, suite: 'scalafixture.MissingSuite' }), /Choose a test suite reported/);
      const uri = vscode.Uri.file(source);
      breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)), true);
      vscode.debug.addBreakpoints([breakpoint]);
      const events = [];
      tracker = vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-scala', {
        createDebugAdapterTracker(current) {
          if (current.name !== 'Scala test: '+suite) return undefined;
          session = current;
          return { onDidSendMessage(message) { if (message.type === 'event') events.push(message); } };
        }
      });
      const opened = await service.debugSuite(options);
      assert.equal(opened.suite, suite);
      assert.equal(opened.verifiedLoopback, true);
      const stop = await until(() => events.find(event => event.event === 'stopped' && event.body.reason === 'breakpoint'), 50000);
      assert.equal(session.id, opened.sessionId);
      const request = session.customRequest.bind(session);
      const frame = await readTestFrame(request, stop.body.threadId, source, line);
      await request('continue', { threadId: stop.body.threadId });
      await until(() => events.some(event => event.event === 'terminated'), 50000);
      const result = assertFinishedSuite(events, jdbcInSuite);
      checks.push('The selected actual sbt Scala suite stopped in its MUnit test source, and only the chosen suite resumed to completion.');
      return { version, suite, discovered, frame, ...result, verifiedLoopback: true, jdbc: await jdbcReadback() };
    } finally {
      if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
      tracker?.dispose();
      await service.stop();
    }
  });
}

module.exports = { runScalaTestDebugChecks, runScalaTestDebugHeadless };
if (require.main === module) runScalaTestDebugHeadless(process.argv.includes('--scala3') ? scala3 : scala2)
  .then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
