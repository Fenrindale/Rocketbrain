'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { discoverTests, runTests } = require('../src/java/testing');
const { resolveTestingProjects } = require('../src/java/testing-projects');
const { execute } = require('../src/java/testing/provision');
const { allocatePort, waitForOwnedListener } = require('../src/java/testing-debug');
const { fixtureSource, testModule, testClass, testSource, copyNamedTests, namedTestProfile, jdbcEnvironment } =
  require('./helpers/jpms-testing-fixture');

const runtimePath = process.env.ROCKETBRAIN_TEST_JPMS_RUNTIME_FILE;
const compiledRoot = process.env.ROCKETBRAIN_TEST_JPMS_COMPILED_ROOT || fixtureSource;
const engine = process.env.ROCKETBRAIN_TEST_JPMS_ENGINE;
const connection = process.env.ROCKETBRAIN_TEST_JPMS_DB_CONFIG;
const projectUri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });

test('a Gradle black-box module discovers and runs reviewed Jupiter tests on Spring JDBC', {
  skip: !runtimePath || !engine || !connection,
  timeout: 90000
}, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-jpms-proof-'));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.ok(path.basename(root).startsWith('rb-jpms-proof-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'project');
  await copyNamedTests(compiledRoot, workspace);
  const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const profile = await namedTestProfile(workspace, runtime.javaHome, runtimePath, path.join(root, 'runs'));
  const env = jdbcEnvironment(engine, JSON.parse(await fs.readFile(connection, 'utf8')));
  const uri = projectUri(path.join(workspace, testSource));
  const vscode = { workspace: {
    isTrusted: true, workspaceFolders: [{ uri: projectUri(workspace) }], findFiles: async () => [uri],
    getConfiguration: () => ({ get: (_, value) => value })
  } };
  const java = { requestWorkspaceCommand: async command => command === 'java.project.getClasspaths'
    ? { projectRoot: workspace, modulepaths: profile.modulePath, classpaths: [] }
    : { 'org.eclipse.jdt.ls.core.vm.location': runtime.javaHome } };
  const context = { globalStorageUri: projectUri(root) };
  const [imported] = await resolveTestingProjects(context, vscode, java);
  assert.equal(imported.testModule, testModule);
  assert.deepEqual(imported.modulePath, profile.modulePath);
  assert.deepEqual(imported.testClassPaths, profile.testClassPaths);
  const [configured] = await resolveTestingProjects(context, vscode, java, [profile]);
  assert.equal(configured.testModule, testModule);
  const [testNgProfile] = await resolveTestingProjects(context, vscode, java, [{ ...profile, framework: 'testng' }]);
  assert.equal(testNgProfile.framework, 'testng');
  const project = { ...imported, runtimePath, env };
  await assert.rejects(runTests(project), { code: 'MODULE_TEST_REVIEW_REQUIRED' });
  await assert.rejects(discoverTests({ ...project, framework: 'testng' }), { code: 'UNSUPPORTED_MODULE_TEST_ENGINE' });
  await assert.rejects(discoverTests({ ...project, modulePath: [...project.modulePath, runtime.testngJar] }),
    { code: 'UNSUPPORTED_MODULE_TEST_ENGINE' });
  await assert.rejects(discoverTests({ ...project, jvmArgs: ['--patch-module', 'fixture.jpms.tests=.'] }),
    { code: 'INVALID_MODULE_TEST' });

  const discovered = await discoverTests(project);
  assert.equal(discovered.state, 'completed', discovered.output);
  assert.deepEqual(discovered.summary, { testsFound: 2 });
  assert.equal(discovered.module.name, testModule);
  assert.equal(discovered.module.engine, 'junit-jupiter');
  assert.equal(discovered.module.version, '6.0.3');
  const moduleReview = discovered.module.fingerprint;
  const candidates = discovered.tests.filter(item => item.kind === 'test');
  assert.deepEqual(candidates.map(item => item.className), [testClass, testClass]);
  assert.deepEqual(candidates.map(item => item.line).sort((a, b) => a - b), [9, 17]);
  assert.ok(candidates.every(item => item.uri === uri.toString()));

  const selected = candidates.find(item => item.methodName === 'executesSpringJdbc');
  const selectors = [{ kind: 'uniqueId', value: selected.id }];
  const all = await runTests(project, { moduleReview });
  assert.equal(all.state, 'completed', all.output);
  assert.equal(all.summary.testsSucceeded, 2, all.events.find(event =>
    event.type === 'finished' && event.state === 'failed')?.error?.stack || all.output);
  assert.equal(all.summary.testsFailed, 0, all.output);
  const single = await runTests(project, { moduleReview, selectors });
  assert.equal(single.state, 'completed', single.output);
  assert.equal(single.summary.testsSucceeded, 1, single.output);
  assert.deepEqual(single.tests.filter(item => item.kind === 'test').map(item => item.id), [selected.id]);
  const server = single.output.match(/jpms-spring-jdbc: ([^\r\n]+)/u)?.[1];
  assert.match(server || '', engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  let debugBreakpoint;
  if (process.platform === 'win32') {
    const port = await allocatePort();
    const debug = await runTests(project, { moduleReview, selectors, debug: { port, onStarted: async ({ pid }) => {
      assert.equal((await waitForOwnedListener({ pid, port })).verified, true);
      const debuggerRun = await execute(path.join(runtime.javaHome, 'bin/java.exe'),
        ['--add-modules', 'jdk.jdi', path.join(fixtureSource, 'DebugNamedTest.java'), String(port)], {
          cwd: workspace, timeoutMs: 20000
        });
      assert.equal(debuggerRun.code, 0, debuggerRun.output);
      debugBreakpoint = debuggerRun.output.trim();
    } } });
    assert.equal(debug.summary.testsSucceeded, 1, debug.events.find(event =>
      event.type === 'finished' && event.state === 'failed')?.error?.stack || debug.output);
    assert.match(debugBreakpoint || '', /^fixture\.jpms\.tests\/executesSpringJdbc:[1-9]\d*$/u);
  }
  const external = await runTests(project, { moduleReview, selectors: [{ kind: 'class', value: 'fixture.jpms.app.InvoiceCounter' }] });
  assert.equal(external.state, 'errored');
  assert.match(external.errors[0]?.message, /outside fixture\.jpms\.tests/);
  const foreignEngine = await runTests(project, { moduleReview, selectors: [{ kind: 'uniqueId', value: '[engine:junit-vintage]' }] });
  assert.equal(foreignEngine.state, 'errored');
  assert.match(foreignEngine.errors[0]?.message, /does not belong to the pinned named Jupiter engine/);
  const wrongModule = await discoverTests({ ...project, testModule: 'fixture.jpms.app' });
  assert.equal(wrongModule.state, 'errored');
  assert.match(wrongModule.errors[0]?.message, /selected named test output/);
  await assert.rejects(runTests(project, { moduleReview, coverage: true }), { code: 'MODULE_TEST_COVERAGE' });

  const source = path.join(workspace, testSource), original = await fs.readFile(source);
  await fs.appendFile(source, '// Changed after discovery.\n');
  await assert.rejects(runTests(project, { moduleReview, selectors }), { code: 'STALE_MODULE_TEST' });
  await fs.writeFile(source, original);
  const marker = path.join(profile.testClassPaths[0], 'updated-test-output.txt');
  await fs.writeFile(marker, 'Changed after discovery.', { flag: 'wx' });
  await assert.rejects(runTests(project, { moduleReview, selectors }), { code: 'STALE_MODULE_TEST' });
  await fs.unlink(marker);
  assert.equal((await discoverTests(project)).module.fingerprint, moduleReview);
  const report = { engine, server, launcherSha256: runtime.launcherSha256, module: discovered.module,
    discovered: candidates.map(item => ({ id: item.id, line: item.line })), all: all.summary,
    selected: single.summary, debugBreakpoint, rejected: ['missing-review', 'TestNG', 'foreign-engine', 'foreign-class',
      'wrong-module', 'patch-module', 'coverage', 'changed-source', 'changed-output'] };
  if (process.env.ROCKETBRAIN_TEST_JPMS_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_TEST_JPMS_RECEIPT,
    JSON.stringify(report, null, 2) + '\n');
});
