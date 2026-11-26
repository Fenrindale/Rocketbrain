'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { BuildTasks } = require('../src/java/workbench-tasks');
const { buildFingerprint } = require('../src/java/workbench-model');
const { registerJavaFx } = require('../src/java/javafx-vscode');
const { jdbcReadback } = require('./java-source-analysis-host');
const { populate, checkLauncher } = require('./helpers/javafx-gradle-image-fixture');

const execute = promisify(execFile);
const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleCache = process.env.ROCKETBRAIN_JAVAFX_GRADLE_USER_HOME;
const springConfig = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;

function headlessWorkbench(folder, storagePath, tools, execution) {
  const uri = { scheme: 'file', fsPath: folder, toString: () => pathToFileURL(folder).href };
  const disposable = { dispose() {} };
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri }], textDocuments: [],
    getConfiguration: () => ({ get: () => undefined }),
    onDidOpenTextDocument: () => disposable, onDidSaveTextDocument: () => disposable,
    onDidCloseTextDocument: () => disposable },
  commands: { registerCommand: () => disposable },
  languages: { createDiagnosticCollection: () => disposable, registerDefinitionProvider: () => disposable,
    registerDocumentSymbolProvider: () => disposable } };
  const tasks = new BuildTasks({ storagePath, tools: () => tools,
    runner: { async execute(spec) {
      execution.push(spec.args.at(-1));
      await execute(spec.command, spec.args, { cwd: spec.cwd, env: { ...spec.env, GRADLE_USER_HOME: gradleCache },
        timeout: 240000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      return { code: 0 };
    } } });
  const project = { id: 'javafx-test', root: folder, uri: uri.toString(), name: 'javafx-fixture', tool: 'gradle',
    buildFingerprint: buildFingerprint(folder) };
  const java = { workbench: { getSnapshot: () => ({ projects: [project] }),
    discoverTasks: options => tasks.discover(project, options),
    runTask: options => tasks.run(project, options.taskId, options) } };
  return { service: registerJavaFx(vscode, { java }), uri, vscode };
}

test('owned Spring and real Gradle publish and execute a reviewed modular JavaFX image', {
  skip: !(javaConfig && gradleCache && springConfig) && 'Use the owned Spring and independent Gradle runtime.',
  timeout: 450000
}, async context => {
  const tools = JSON.parse(fs.readFileSync(javaConfig, 'utf8'));
  const parent = fs.realpathSync(os.tmpdir());
  const owned = fs.mkdtempSync(path.join(parent, 'rb-javafx-image-'));
  const folder = path.join(owned, 'project'), storage = path.join(owned, 'metadata');
  const expectedJdbc = { people: 2, departments: 1, rolledBackNames: 0 };
  const receipt = process.env.ROCKETBRAIN_JAVAFX_GRADLE_RECEIPT;
  try {
    populate(folder);
    const calls = [];
    const host = headlessWorkbench(folder, storage, tools, calls);
    let evidence;
    try {
      await assert.rejects(host.service.build(host.uri, 'image'), /explicit action/u);
      assert.deepEqual(calls, []);
      const result = await host.service.build(host.uri, 'image', { allowProjectExecution: true });
      assert.deepEqual(calls, [':help', ':jlink']);
      evidence = checkLauncher(folder, result);
    } finally {
      await host.service.dispose();
    }

    fs.appendFileSync(path.join(folder, 'build.gradle'),
      "\njlink { imageName = ''; imageDir.set(layout.projectDirectory.dir('outside-build')) }\n");
    const refusedCalls = [];
    const invalid = headlessWorkbench(folder, storage, tools, refusedCalls);
    try {
      await assert.rejects(invalid.service.build(invalid.uri, 'image', { allowProjectExecution: true }),
        /below the project build directory/u);
      assert.deepEqual(refusedCalls, [':help']);
      assert.equal(fs.existsSync(path.join(folder, 'outside-build')), false);
    } finally {
      await invalid.service.dispose();
    }

    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, expectedJdbc);
    const runtime = JSON.parse(fs.readFileSync(springConfig, 'utf8'));
    assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
    const report = { sourceCommit: process.env.GITHUB_SHA || null, engine: runtime.dbEngine,
      task: ':jlink', actualGradleTaskDiscovery: true, launcherExecuted: true,
      productDidNotLaunchImage: true, outsideOutputRefusedBeforeBuild: true, jdbc, ...evidence };
    if (receipt) fs.writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    context.diagnostic(JSON.stringify(report));
  } finally {
    const real = fs.realpathSync(owned);
    assert.equal(path.relative(parent, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-javafx-image-/u);
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
