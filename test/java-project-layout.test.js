'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { describeSourceLayout, bindProjectOutputs, observedOutput } = require('../src/java/workbench-source-layout');
const { collectProjects } = require('../src/java/workbench-model');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { createProjectLayout, compileProjectLayout, removeProjectLayout, checkLayout } = require('./helpers/java-project-layout-fixture');

const source = (root, id, child) => ({ id, path: path.join(root, child), packages: [] });

test('observed output ownership uses per-source directories and rejects aliases to outside the project', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-layout-unit-'));
  const app = { id: 'app', name: 'app', root: path.join(parent, 'app'), libraries: [], sourceRoots: [] };
  const lib = { id: 'lib', name: 'lib', root: path.join(parent, 'lib'), libraries: [], sourceRoots: [] };
  await fs.mkdir(app.root);
  await fs.mkdir(lib.root);
  try {
    const main = source(app.root, 'a-main', 'src/main/java'), tests = source(app.root, 'a-test', 'checks'),
      generated = source(app.root, 'a-generated', 'build/generated/sources/layout');
    app.sourceRoots = [main, tests, generated];
    const mainOutput = path.join(app.root, 'bin/main'), testOutput = path.join(app.root, 'bin/test');
    const libraryOutput = path.join(lib.root, 'target/classes');
    await fs.mkdir(mainOutput, { recursive: true });
    await fs.mkdir(libraryOutput, { recursive: true });
    await fs.writeFile(path.join(lib.root, '.project'), '<projectDescription><name>verified-lib</name></projectDescription>');
    const symlink = path.join(app.root, 'redirected');
    await fs.symlink(lib.root, symlink, process.platform === 'win32' ? 'junction' : 'dir');
    describeSourceLayout(app, [
      { kind: 3, path: main.path }, { kind: 3, path: tests.path, output: testOutput, attributes: { test: 'true' } },
      { kind: 3, path: generated.path, output: mainOutput, attributes: { test: 'false' } }, { kind: 2, path: '/verified-lib' }
    ], mainOutput);
    describeSourceLayout(lib, [], libraryOutput);
    assert.equal(main.scope, 'main');
    assert.equal(tests.scope, 'test');
    assert.equal(generated.generated, true);
    assert.equal(app.outputRoots.find(item => item.path === testOutput).exists, false);
    assert.deepEqual(app.outputRoots.find(item => item.path === mainOutput).sourceRootIds, [main.id, generated.id]);
    assert.equal(observedOutput(symlink, app.root), undefined);
    assert.equal(observedOutput(libraryOutput, app.root), undefined);
    app.libraries = [{ path: libraryOutput }, { path: path.join(symlink, 'target/classes') }, { path: '/verified-lib/target/classes' }];
    bindProjectOutputs([app, lib]);
    assert.deepEqual(app.libraries[0].projectDependency, { id: 'lib', name: 'lib', output: libraryOutput });
    assert.equal(app.libraries[1].projectDependency, undefined);
    assert.deepEqual(app.libraries[2].projectDependency, { id: 'lib', name: 'lib', output: libraryOutput });
  } finally {
    assert.equal(path.dirname(await fs.realpath(parent)), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(parent), /^rb-layout-unit-/);
    await fs.rm(parent, { recursive: true });
  }
});

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const dialectFixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('real Maven reactor and Gradle composite builds appear in the observed Java project layout',
  { skip: !(runtimeFile && dialectFixture && process.env.ROCKETBRAIN_MAVEN_HOME && process.env.ROCKETBRAIN_GRADLE_HOME) && 'Run the owned Spring and JDT fixtures.',
    timeout: 480000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
    const spring = JSON.parse(await fs.readFile(dialectFixture, 'utf8'));
    const tools = { javaHome: runtime.javaHome, gradleHome: process.env.ROCKETBRAIN_GRADLE_HOME, mavenHome: process.env.ROCKETBRAIN_MAVEN_HOME };
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-layout-live-'));
    const fixture = await createProjectLayout(parent);
    let lsp;
    try {
      const compiled = await compileProjectLayout(fixture, tools);
      const folders = [fixture.maven, fixture.gradle];
      const launch = resolveLaunch({ javaHome: tools.javaHome, serverPath: runtime.serverPath, storagePath: path.join(parent, 'jdt') });
      launch.options.env.GRADLE_USER_HOME = path.resolve(__dirname, '../test-output/java-gradle-user-home');
      lsp = new StdioLsp(launch);
      const settings = serverSettings([{ name: 'JavaSE-25', path: tools.javaHome, default: true }], { gradleHome: tools.gradleHome, gradleJavaHome: tools.javaHome });
      settings.java.import.gradle.wrapper.enabled = false;
      const workspaceFolders = folders.map(folder => ({ uri: pathToFileURL(folder).href, name: path.basename(folder) }));
      await lsp.request('initialize', { processId: process.pid, rootUri: workspaceFolders[0].uri,
        workspaceFolders, capabilities: { workspace: { workspaceFolders: true, configuration: true }, textDocument: {} },
        initializationOptions: { bundles: [], workspaceFolders: workspaceFolders.map(folder => folder.uri), settings } }, 90000);
      lsp.notify('initialized', {});
      const settingsByProject = new Map();
      const request = async (command, args) => {
        const result = await lsp.request('workspace/executeCommand', { command, arguments: args }, 60000);
        if (command === 'java.project.getSettings') settingsByProject.set(path.basename(fileURLToPath(args[0])), result);
        return result;
      };
      await until(async () => {
        const known = (await request('java.project.getAll', [])).map(uri => path.resolve(fileURLToPath(uri)));
        return fixture.projectUris.every(uri => known.some(root => path.relative(root, fileURLToPath(uri)) === ''));
      }, 165000);
      const snapshot = await collectProjects({ request, folders });
      const layout = checkLayout(snapshot, fixture);
      const response = await fetch(new URL('/probe/testing-state', spring.baseUrl), { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200);
      const jdbc = await response.json();
      assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
      assert.ok(layout.mavenEdge);
      if (!layout.gradleEdge) {
        const entries = settingsByProject.get(layout.gradle.name)?.['org.eclipse.jdt.ls.core.classpathEntries'];
        console.log(JSON.stringify({ gradleResolved: layout.gradle.libraries.filter(item => item.path).map(item => path.relative(fixture.gradle, item.path)),
          rawProjectEntries: entries?.filter(item => item.kind !== 3).map(({ kind, path, attributes }) => ({ kind, path, attributes })),
          gradleLibOutputs: snapshot.projects.find(project => project.name === 'layout-gradle-lib')?.outputRoots.map(item => path.relative(fixture.gradle, item.path)) }));
      }
      assert.ok(layout.gradleEdge);
      console.log(JSON.stringify({ engine: spring.dbEngine, compiled, mainTestOutputs: true, generated: true, mavenEdge: true, gradleEdge: true, jdbc }));
    } finally {
      await lsp?.close();
      await removeProjectLayout(fixture, parent);
    }
  });
