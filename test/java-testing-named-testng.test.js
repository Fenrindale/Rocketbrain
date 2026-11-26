'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { discoverTests, runTests } = require('../src/java/testing');
const { resolveTestingProjects } = require('../src/java/testing-projects');
const { execute } = require('../src/java/testing/provision');
const { allocatePort, waitForOwnedListener } = require('../src/java/testing-debug');
const { fixtureSource, testModule, testClass, testSource, copyNamedTests, namedTestProfile, jdbcEnvironment } =
  require('./helpers/jpms-testing-fixture');

const runtimePath = process.env.ROCKETBRAIN_TEST_JPMS_RUNTIME_FILE;
const compiledRoot = process.env.ROCKETBRAIN_TEST_NAMED_TESTNG_COMPILED_ROOT ||
  path.resolve(__dirname, 'fixtures/java/jpms-testng');
const engine = process.env.ROCKETBRAIN_TEST_JPMS_ENGINE;
const connection = process.env.ROCKETBRAIN_TEST_JPMS_DB_CONFIG;
const uriFor = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
const failure = report => report.errors?.[0]?.stack ||
  report.events.find(event => event.type === 'finished' && event.state === 'failed')?.error?.stack || report.output;

async function rejectedDescriptor(root, profile, source, pattern) {
  const sourceFile = path.join(profile.workspace, 'src/test/java/module-info.java');
  const classFile = path.join(profile.testClassPaths[0], 'module-info.class');
  const [oldSource, oldClass] = await Promise.all([fs.readFile(sourceFile), fs.readFile(classFile)]);
  const partial = source(oldSource.toString('utf8'));
  assert.notEqual(partial, oldSource.toString('utf8'));
  const executable = path.join(profile.javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const output = await fs.mkdtemp(path.join(root, 'descriptor-'));
  try {
    await fs.writeFile(sourceFile, partial);
    const dependencies = profile.modulePath.filter(entry => entry !== profile.testClassPaths[0]);
    const compile = await execute(executable, ['--module-path', dependencies.join(path.delimiter),
      '-d', output, sourceFile], { cwd: profile.workspace, timeoutMs: 20000 });
    assert.equal(compile.code, 0, compile.output);
    await fs.copyFile(path.join(output, 'module-info.class'), classFile);
    const discovery = await discoverTests(profile);
    assert.equal(discovery.state, 'errored', failure(discovery));
    assert.match(discovery.errors[0]?.message, pattern);
    assert.equal(discovery.tests.length, 0);
  } finally {
    await fs.writeFile(sourceFile, oldSource);
    await fs.writeFile(classFile, oldClass);
  }
}

test('an actual Gradle named TestNG module discovers and selects Spring JDBC tests', {
  skip: !runtimePath || !engine || !connection, timeout: 110000
}, async context => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-jpms-ng-proof-'));
  context.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.ok(path.basename(root).startsWith('rb-jpms-ng-proof-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'spring-named-testng');
  await copyNamedTests(compiledRoot, workspace);
  const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const base = await namedTestProfile(workspace, runtime.javaHome, runtimePath, path.join(root, 'runs'));
  const source = uriFor(path.join(workspace, testSource));
  const vscode = { workspace: {
    isTrusted: true, workspaceFolders: [{ uri: uriFor(workspace) }], findFiles: async () => [source],
    getConfiguration: () => ({ get: (_, fallback) => fallback })
  } };
  const java = { requestWorkspaceCommand: async command => command === 'java.project.getClasspaths'
    ? { projectRoot: workspace, modulepaths: base.modulePath, classpaths: [] }
    : { 'org.eclipse.jdt.ls.core.vm.location': runtime.javaHome } };
  const host = { globalStorageUri: uriFor(root) };
  const [imported] = await resolveTestingProjects(host, vscode, java);
  assert.equal(imported.framework, 'testng');
  assert.equal(imported.testModule, testModule);
  const [configured] = await resolveTestingProjects(host, vscode, java, [{ ...base, framework: 'testng' }]);
  assert.deepEqual(configured.modulePath, imported.modulePath);
  assert.deepEqual(configured.classPath, []);
  const profile = { ...configured, classDirectories: imported.classDirectories,
    env: jdbcEnvironment(engine, JSON.parse(await fs.readFile(connection, 'utf8'))) };
  await assert.rejects(discoverTests({ ...profile, framework: 'junit' }), { code: 'UNSUPPORTED_MODULE_TEST_ENGINE' });
  await assert.rejects(discoverTests({ ...profile, modulePath: [...profile.modulePath, runtime.junitJar] }),
    { code: 'UNSUPPORTED_MODULE_TEST_ENGINE' });
  await assert.rejects(discoverTests({ ...profile, classPath: [runtime.testngJar] }), { code: 'INVALID_MODULE_TEST' });
  await assert.rejects(discoverTests({ ...profile, jvmArgs: ['--add-opens=fixture.jpms.tests/fixture.jpms.tests=org.testng'] }),
    { code: 'INVALID_MODULE_TEST' });

  const discovery = await discoverTests(profile);
  assert.equal(discovery.state, 'completed', failure(discovery));
  assert.equal(discovery.module.engine, 'testng');
  assert.equal(discovery.module.version, '7.11.0');
  assert.equal(discovery.module.name, testModule);
  const { fingerprint: moduleReview } = discovery.module;
  const methods = discovery.tests.filter(item => item.methodName);
  assert.deepEqual(methods.map(item => item.methodName).sort(), ['executesSpringJdbc', 'runsInRealNamedModules']);
  assert.ok(methods.every(item => item.uri === source.toString() && item.className === testClass));
  assert.ok(methods.every(item => Number.isInteger(item.line) && item.line > 5));

  const all = await runTests(profile, { moduleReview });
  assert.equal(all.state, 'completed', failure(all));
  assert.equal(all.summary.testsSucceeded, 3, failure(all));
  assert.equal(all.summary.testsFailed, 0, failure(all));
  const ids = all.tests.filter(item => item.kind === 'test' && item.methodName === 'executesSpringJdbc');
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0].id, ids[1].id);
  assert.ok(ids.every(row => row.rerunnable && row.id.includes('/[rows:')));
  const selected = ids[1];
  const selectors = [{ kind: 'uniqueId', value: selected.id }];
  const single = await runTests(profile, { moduleReview, selectors });
  assert.equal(single.state, 'completed', failure(single));
  assert.equal(single.summary.testsSucceeded, 1, failure(single));
  assert.deepEqual(single.tests.filter(item => item.kind === 'test').map(item => item.id), [selected.id]);
  const versions = [...single.output.matchAll(/jpms-testng-spring-jdbc: ([^\r\n]+)/gu)].map(match => match[1]);
  assert.equal(versions.length, 1);
  assert.match(versions[0], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  const measured = await runTests(profile, { moduleReview, selectors, coverage: true });
  assert.equal(measured.state, 'completed', failure(measured));
  assert.equal(measured.coverage.state, 'available', JSON.stringify(measured.coverage.warnings));
  assert.equal(measured.coverage.scope, 'run');
  assert.equal(measured.coverage.perTestCoverage, false);
  const appCoverage = measured.coverage.files.find(file => file.uri.endsWith('/InvoiceCounter.java'));
  assert.ok(appCoverage?.lines.covered > 0 && appCoverage.methods.covered >= 3);
  await assert.rejects(runTests(profile, { moduleReview, perTestCoverage: true }), { code: 'MODULE_TEST_COVERAGE' });
  await assert.rejects(runTests({ ...profile, classDirectories: profile.testClassPaths }, { moduleReview, coverage: true }),
    { code: 'MODULE_TEST_COVERAGE_INPUT' });

  let debugBreakpoint;
  if (process.platform === 'win32') {
    const port = await allocatePort();
    const debug = await runTests(profile, { moduleReview, selectors, debug: { port, onStarted: async ({ pid }) => {
      assert.equal((await waitForOwnedListener({ pid, port })).verified, true);
      const attached = await execute(path.join(runtime.javaHome, 'bin/java.exe'),
        ['--add-modules', 'jdk.jdi', path.join(fixtureSource, 'DebugNamedTest.java'), String(port)],
        { cwd: workspace, timeoutMs: 20000 });
      assert.equal(attached.code, 0, attached.output);
      debugBreakpoint = attached.output.trim();
    } } });
    assert.equal(debug.state, 'completed', failure(debug));
    assert.equal(debug.summary.testsSucceeded, 1, failure(debug));
    assert.match(debugBreakpoint || '', /^fixture\.jpms\.tests\/executesSpringJdbc:[1-9]\d*$/u);
  }

  const otherEngine = { kind: 'uniqueId', value: '[engine:junit-jupiter]' };
  for (const selection of [{ selectors: [otherEngine] }, { excludes: [otherEngine] }]) {
    const wrong = await runTests(profile, { moduleReview, ...selection });
    assert.equal(wrong.state, 'errored');
    assert.match(wrong.errors[0]?.message, /exact TestNG identity/);
  }
  const external = await runTests(profile, { moduleReview, selectors: [{ kind: 'class', value: 'fixture.jpms.app.InvoiceCounter' }] });
  assert.equal(external.state, 'errored');
  assert.match(external.errors[0]?.message, /outside fixture\.jpms\.tests/);
  await rejectedDescriptor(root, profile, text => text.replace('requires org.testng;', ''), /requires org\.testng/);
  await rejectedDescriptor(root, profile, text => text.replace('opens fixture.jpms.tests to org.testng;', ''),
    /opens fixture\.jpms\.tests to org\.testng/);
  await fs.appendFile(path.join(workspace, testSource), '// Saved after discovery.\n');
  await assert.rejects(runTests(profile, { moduleReview, selectors }), { code: 'STALE_MODULE_TEST' });
  const report = { engine, server: versions[0], launcherSha256: runtime.launcherSha256, module: discovery.module,
    discovered: methods.map(item => ({ method: item.methodName, line: item.line })), all: all.summary,
    matchingRows: ids.map(item => item.id), selected: single.summary, debugBreakpoint,
    coverage: { scope: measured.coverage.scope, lines: appCoverage.lines, methods: appCoverage.methods },
    rejected: ['foreign-framework-artifact', 'foreign-engine-selection-or-exclusion', 'foreign-class',
      'mixed-classpath', 'synthetic-module-opens', 'undeclared-read', 'undeclared-testng-opens',
      'per-test-coverage', 'test-output-as-application-coverage', 'changed-source'] };
  if (process.env.ROCKETBRAIN_TEST_NAMED_TESTNG_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_TEST_NAMED_TESTNG_RECEIPT,
    JSON.stringify(report, null, 2) + '\n');
});
