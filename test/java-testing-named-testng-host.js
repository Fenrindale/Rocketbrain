'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { testModule, copyNamedTests, namedTestProfile, jdbcEnvironment } = require('./helpers/jpms-testing-fixture');

async function runJavaTestingNamedTestNgChecks(api, vscode, checks) {
  const compiled = process.env.ROCKETBRAIN_TEST_NAMED_TESTNG_COMPILED_ROOT;
  const runtimePath = process.env.ROCKETBRAIN_TEST_JPMS_RUNTIME_FILE;
  assert.ok(compiled && runtimePath, 'Prepare the compiled TestNG fixture and current independent testing runtime.');
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_TEST_JPMS_DB_CONFIG || spring.dbConfigPath, 'utf8'));
  const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await fs.mkdtemp(path.join(workspace, 'jpms-testng-'));
  try {
    await copyNamedTests(compiled, project);
    const profile = { ...await namedTestProfile(project, runtime.javaHome, runtimePath), framework: 'testng',
      classDirectories: [path.join(project, 'build/classes/java/main')] };
    const env = jdbcEnvironment(spring.dbEngine, config);
    const discovery = await api.javaTesting.discover({ projects: [profile], build: false });
    assert.equal(discovery.projects[0].framework, 'testng');
    assert.equal(discovery.projects[0].testModule, testModule);
    const method = discovery.tests.find(test => test.methodName === 'executesSpringJdbc');
    assert.ok(method?.uri.endsWith('/fixture/jpms/tests/InvoiceModuleTest.java'));
    const first = await api.javaTesting.run({ includeIds: [method.nativeId], env, build: false });
    assert.equal(first.projects[0].module.engine, 'testng');
    assert.equal(first.projects[0].summary.testsSucceeded, 2);
    const rows = api.javaTesting.snapshot().tests.filter(test => test.kind === 'test' && test.methodName === 'executesSpringJdbc');
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].nativeId, rows[1].nativeId);
    const run = await api.javaTesting.run({ includeIds: [rows[1].nativeId], env, coverage: true, build: false });
    const observed = run.projects[0];
    assert.equal(observed.module.name, testModule);
    assert.equal(observed.module.engine, 'testng');
    assert.equal(observed.summary.testsFound, 1);
    assert.equal(observed.summary.testsSucceeded, 1);
    assert.equal(observed.coverage.state, 'available');
    assert.ok(observed.coverage.files.some(file => file.uri.endsWith('/InvoiceCounter.java') && file.lines.covered > 0));
    checks.push('VS Code Testing finds a named TestNG module and reruns one of two equal-parameter JDBC rows by its exact native identity.');
    checks.push('JaCoCo measures the reviewed application module for the selected TestNG run.');
    return { engine: spring.dbEngine, module: observed.module, summary: observed.summary, coverage: observed.coverage.totals };
  } finally {
    const relative = path.relative(await fs.realpath(workspace), await fs.realpath(project));
    assert.match(relative, /^jpms-testng-[^/\\]+$/u);
    await fs.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

module.exports = { runJavaTestingNamedTestNgChecks };
