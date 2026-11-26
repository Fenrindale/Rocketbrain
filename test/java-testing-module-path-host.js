'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { testModule, testSource, copyNamedTests, discoverCopiedNamedTests, namedTestProfile, jdbcEnvironment } = require('./helpers/jpms-testing-fixture');

async function runJavaTestingModulePathChecks(api, vscode, checks) {
  const compiled = process.env.ROCKETBRAIN_TEST_JPMS_COMPILED_ROOT;
  const runtimePath = process.env.ROCKETBRAIN_TEST_JPMS_RUNTIME_FILE;
  assert.ok(compiled && runtimePath, 'Prepare the compiled Gradle fixture and current independent testing runtime.');
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_TEST_JPMS_DB_CONFIG ||
    spring.dbConfigPath, 'utf8'));
  const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await fs.mkdtemp(path.join(workspace, 'jpms-testing-'));
  try {
    await copyNamedTests(compiled, project);
    const profile = await namedTestProfile(project, runtime.javaHome, runtimePath);
    const env = jdbcEnvironment(spring.dbEngine, config);
    const discovery = await discoverCopiedNamedTests(api.javaTesting, profile);
    assert.equal(discovery.projects[0].testModule, testModule);
    assert.equal(api.javaTesting.controller.items.size, 1);
    const selected = discovery.tests.find(test => test.methodName === 'executesSpringJdbc');
    assert.ok(selected?.uri.endsWith('/fixture/jpms/tests/InvoiceModuleTest.java'));
    assert.equal(selected.line, 17);
    const result = await api.javaTesting.run({ includeIds: [selected.nativeId], env, build: false });
    const observed = result.projects[0];
    assert.equal(observed.module.name, testModule);
    assert.equal(observed.module.engine, 'junit-jupiter');
    assert.equal(observed.summary.testsFound, 1);
    assert.equal(observed.summary.testsSucceeded, 1);
    await fs.appendFile(path.join(project, testSource), '// Saved after testing discovery.\n');
    await assert.rejects(api.javaTesting.run({ includeIds: [selected.nativeId], env, build: false }), { code: 'STALE_MODULE_TEST' });
    checks.push('VS Code Testing discovers a separately compiled Java module and runs the selected Jupiter test on the actual Spring JDBC target.');
    return { engine: spring.dbEngine, module: observed.module, summary: observed.summary, rejectedChangedSource: true };
  } finally {
    const relative = path.relative(await fs.realpath(workspace), await fs.realpath(project));
    assert.match(relative, /^jpms-testing-[^/\\]+$/u);
    await fs.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

module.exports = { runJavaTestingModulePathChecks };
