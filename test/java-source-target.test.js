'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { resolveJavaSourceTarget, settingsKeys } = require('../src/java/source-target');
const { resolveBuildTarget } = require('../src/java/source-target-builds');
const { registerJavaWorkbench } = require('../src/java/workbench');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { fakeVscode } = require('./java-workbench-fixture');
const { populateTargets, buildTargets, runTargets } = require('./helpers/java-source-target-fixture');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const url = file => pathToFileURL(file).href;
const same = (left, right) => path.relative(left, right) === '';
const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SOURCE_TARGET_CLASSPATH;
const mavenHome = process.env.ROCKETBRAIN_TARGET_MAVEN_HOME;
const gradleCache = process.env.ROCKETBRAIN_SOURCE_TARGET_GRADLE_CACHE;
const environments = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_SOURCE_TARGET_' + engine.toUpperCase() + '_CONFIG']]);

async function owned(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'rb-source-target-'));
  t.after(async () => {
    assert.equal(await fs.realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^rb-source-target-/u);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const root = path.join(directory, 'mixed');
  return { directory, root, targets: await populateTargets(root) };
}

function presentation(host) {
  const open = [], displayed = [], documents = new Map();
  const vscode = host.vscode;
  const parse = vscode.Uri.parse;
  vscode.Uri.parse = value => ({ ...parse(value), path: new URL(value).pathname });
  vscode.Range = class {
    constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  };
  const original = vscode.workspace.openTextDocument;
  vscode.workspace.registerTextDocumentContentProvider = (scheme, provider) => {
    documents.set(scheme, provider);
    return { dispose: () => documents.delete(scheme) };
  };
  vscode.workspace.openTextDocument = address => {
    open.push(address);
    return address.scheme === 'file' ? original(address) :
      { uri: address, getText: () => documents.get(address.scheme).provideTextDocumentContent(address) };
  };
  vscode.window.showTextDocument = async (document, options) => {
    const result = { document, selection: options.selection };
    displayed.push(result);
    return result;
  };
  return { open, displayed };
}

test('read-only scoped target refuses a parent guess and stale or dirty declarations', async t => {
  const { directory, root, targets } = await owned(t);
  const parent = path.join(root, 'maven'), component = path.join(parent, 'service');
  const source = path.join(component, 'src/main/java');
  const calls = [];
  let returned = component, imported = true, sourceRoots = [source];
  const request = async (command, args) => {
    calls.push([command, args]);
    if (command === 'java.project.getAll') return [url(root), url(parent), ...(imported ? [url(component)] : [])];
    if (command === 'java.project.getClasspaths') return { projectRoot: url(returned), classpaths: [], modulepaths: [] };
    if (command === 'java.project.getSettings') return { [settingsKeys[0]]: sourceRoots, [settingsKeys[3]]: ['org.eclipse.m2e.core.maven2Nature'] };
    throw Error('Unexpected metadata request: ' + command);
  };
  const inputs = { sourceUri: targets.maven, folders: [root], request };
  const found = await resolveJavaSourceTarget(inputs);
  assert.equal(found.projectRoot, component);
  assert.equal(found.declaredBuild.reactorProject, 'service');
  assert.equal(found.provider, 'maven');
  assert.equal(found.executedProjectCode, false);
  assert.ok(calls.filter(([command]) => command !== 'java.project.getAll').every(([, args]) => args[0] === targets.maven));
  returned = parent;
  await assert.rejects(resolveJavaSourceTarget(inputs), /exact imported Java component/u);
  imported = false;
  await assert.rejects(resolveJavaSourceTarget(inputs), /Import the nested Java component/u);
  imported = true;
  returned = component;
  sourceRoots = [path.join(component, 'src/test/java')];
  await assert.rejects(resolveJavaSourceTarget(inputs), /outside the imported component source roots/u);
  sourceRoots = [source];

  const host = fakeVscode({ parent: directory, root, uri: url(root) });
  host.java.requestWorkspaceCommand = request;
  const ui = presentation(host);
  host.vscode.ProgressLocation = { Notification: 15 };
  host.vscode.window.withProgress = async (_options, run) => run({}, undefined);
  host.vscode.window.activeTextEditor = { document: { uri: host.vscode.Uri.parse(targets.maven) } };
  const workbench = registerJavaWorkbench(host.context, host.vscode, host.java, host.output, { runner: host.runner });
  try {
    const checked = await workbench.sourceTarget.inspect({ sourceUri: targets.maven });
    const view = await workbench.sourceTarget.show(checked.id);
    assert.match(view.document.getText(), /Reactor module: service/u);
    const command = await host.commands.get('rocketbrain.java.workbench.sourceTarget')();
    assert.match(command.document.getText(), /Reactor module: service/u);
    const module = await workbench.sourceTarget.openBuild(checked.id, 0);
    assert.ok(same(fileURLToPath(module.uri), path.join(parent, 'pom.xml')));
    assert.equal(ui.displayed.at(-1).selection.start.line, 4);
    const file = path.join(component, 'pom.xml');
    host.vscode.workspace.textDocuments.push({ uri: host.vscode.Uri.parse(url(file)), isDirty: true });
    await assert.rejects(workbench.sourceTarget.inspect({ sourceUri: targets.maven }), /Save the Java build descriptor/u);
    host.vscode.workspace.textDocuments.length = 0;
    await fs.appendFile(file, '<!-- changed -->\n');
    await assert.rejects(workbench.sourceTarget.openBuild(checked.id), /Refresh the Java source target/u);
    assert.equal(host.specs.length, 0);
    assert.ok(ui.open.every(address => address.scheme === 'rocketbrain-java-source-target' ||
      same(address.fsPath, path.join(parent, 'pom.xml'))));
  } finally { await workbench.dispose(); }
});

test('Windows editor drive casing still resolves the exact imported Java source component', {
  skip: process.platform !== 'win32'
}, async t => {
  const { root, targets } = await owned(t);
  const parent = path.join(root, 'maven'), component = path.join(parent, 'service');
  const jdtUri = file => url(file).replace(/^file:\/\/\/([a-z]):/iu, (_, drive) => 'file:///' + drive.toUpperCase() + ':');
  const editorUri = targets.maven.replace(/^file:\/\/\/([a-z]):/iu, (_, drive) => 'file:///' + drive.toLowerCase() + '%3A');
  assert.match(editorUri, /^file:\/\/\/[a-z]%3A/u);
  assert.match(jdtUri(component), /^file:\/\/\/[A-Z]:/u);
  let imported = true;
  const calls = [];
  const request = async command => {
    calls.push(command);
    if (command === 'java.project.getAll') return [jdtUri(parent), ...(imported ? [jdtUri(component)] : [])];
    if (command === 'java.project.getClasspaths') return { projectRoot: jdtUri(component), classpaths: [], modulepaths: [] };
    if (command === 'java.project.getSettings') return {
      [settingsKeys[0]]: [path.join(component, 'src/main/java')],
      [settingsKeys[3]]: ['org.eclipse.m2e.core.maven2Nature']
    };
    throw Error('Unexpected metadata request: ' + command);
  };
  const input = { sourceUri: editorUri, folders: [root], request };
  const target = await resolveJavaSourceTarget(input);
  assert.ok(same(target.projectRoot, component));
  assert.equal(target.declaredBuild.reactorProject, 'service');
  imported = false;
  calls.length = 0;
  await assert.rejects(resolveJavaSourceTarget(input), /Import the nested Java component/u);
  assert.deepEqual(calls, ['java.project.getAll']);
});

test('literal Gradle aliases retain source ranges and computed membership omits an unproven path', async t => {
  const { root } = await owned(t), component = path.join(root, 'gradle/vendor/service');
  const inspect = () => resolveBuildTarget(component, root, () => false).build;
  const initial = inspect();
  assert.equal(initial.kind, 'gradle');
  assert.equal(initial.projectPath, ':service');
  assert.equal(initial.buildTreePath, ':linked-tools:service');
  assert.equal(initial.declarations[1].range.start.line, 2);
  await fs.appendFile(path.join(root, 'gradle/vendor/settings.gradle.kts'), 'project(":service").projectDir = file("custom")\n');
  const computed = inspect();
  assert.equal(computed.kind, 'gradle');
  assert.equal(computed.projectPath, undefined);
  assert.equal(computed.buildTreePath, undefined);
  assert.deepEqual(computed.declarations, []);
});

test('actual JDT selects Maven reactor and Gradle composite sources inside one workspace on both Spring DBs', {
  skip: !runtimeFile || !classpathFile || !mavenHome || !gradleCache || !environments.every(([, file]) => file), timeout: 490000
}, async t => {
  const { directory, root, targets } = await owned(t);
  const runtime = await read(runtimeFile), tools = { javaHome: runtime.javaHome, mavenHome, gradleHome: runtime.gradleHome };
  assert.ok(tools.gradleHome);
  await buildTargets(root, tools, gradleCache);
  const configs = await Promise.all(environments.map(async ([engine, file]) => [engine, await read(file)]));
  const db = (await Promise.all(configs.map(([engine, database]) => runTargets(root, tools, classpathFile, database, engine)))).flat();
  const launch = resolveLaunch({ ...runtime, storagePath: path.join(directory, 'jdt') });
  launch.options.env.GRADLE_USER_HOME = gradleCache;
  const lsp = new StdioLsp(launch);
  const settings = serverSettings([{ name: 'JavaSE-25', path: tools.javaHome, default: true }],
    { gradleHome: tools.gradleHome, gradleJavaHome: tools.javaHome });
  settings.java.import.gradle.wrapper.enabled = false;
  settings.java.autobuild.enabled = false;
  try {
    await lsp.request('initialize', { processId: process.pid, rootUri: url(root), workspaceFolders: [{ uri: url(root), name: 'combined-targets' }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: {} },
      initializationOptions: { bundles: [], workspaceFolders: [url(root)], settings } }, 90000);
    lsp.notify('initialized', {});
    const commands = [];
    const request = async (command, args) => {
      commands.push({ command, args });
      return lsp.request('workspace/executeCommand', { command, arguments: args }, 90000);
    };
    const componentPaths = ['maven/service', 'gradle/workbench', 'gradle/vendor/service'].map(relative => path.join(root, relative));
    await until(async () => {
      const found = await request('java.project.getAll', []);
      return componentPaths.every(project => found.some(entry => {
        try { return same(project, fileURLToPath(entry)); } catch { return false; }
      }));
    }, 160000);
    const host = fakeVscode({ parent: directory, root, uri: url(root), ...tools });
    host.java.requestWorkspaceCommand = request;
    const ui = presentation(host);
    const workbench = registerJavaWorkbench(host.context, host.vscode, host.java, host.output, { runner: host.runner });
    try {
      const observations = {};
      for (const [name, sourceUri] of Object.entries(targets)) {
        const result = await workbench.sourceTarget.inspect({ sourceUri });
        observations[name] = result;
        assert.equal(result.executedProjectCode, false);
        const nameWanted = name.startsWith('maven') ? 'maven/service' : name.startsWith('included') ? 'gradle/vendor/service' : 'gradle/workbench';
        assert.ok(same(result.projectRoot, path.join(root, nameWanted)));
        const expectedTest = name.endsWith('Test');
        assert.equal(result.sourceRole, expectedTest ? 'test' : 'main');
        assert.equal(result.scope, expectedTest ? 'test' : 'runtime');
        assert.equal(result.classpath.some(file => file.endsWith('junit-jupiter-api-6.1.3.jar')), expectedTest);
        assert.equal(result.provider, name.startsWith('maven') ? 'maven' : 'gradle');
      }
      assert.equal(observations.maven.declaredBuild.coordinates, 'fixture.targets:reactor-service:1');
      assert.equal(observations.maven.declaredBuild.reactorProject, 'service');
      assert.equal(observations.gradle.declaredBuild.projectPath, ':workbench');
      assert.equal(observations.included.declaredBuild.buildTreePath, ':linked-tools:service');
      const opened = await workbench.sourceTarget.openBuild(observations.includedTest.id, 1);
      assert.ok(same(fileURLToPath(opened.uri), path.join(root, 'gradle/settings.gradle')));
      assert.equal(opened.range.start.line, 2);
      assert.equal(ui.displayed.length, 1);
      assert.equal(host.specs.length, 0);
      assert.ok(commands.every(item => ['java.project.getAll', 'java.project.getSettings', 'java.project.getClasspaths'].includes(item.command)));
      const proof = { selected: Object.fromEntries(Object.entries(observations).map(([key, value]) => [key, {
        project: path.relative(root, value.projectRoot).split(path.sep).join('/'), provider: value.provider, scope: value.scope,
        buildPath: value.declaredBuild.buildTreePath || value.declaredBuild.projectPath || value.declaredBuild.reactorProject,
        testClasspath: value.classpath.some(file => file.endsWith('junit-jupiter-api-6.1.3.jar'))
      }])), jdbc: db, readOnlyMetadata: true, openedGradleSourceDeclaration: true };
      if (process.env.ROCKETBRAIN_SOURCE_TARGET_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SOURCE_TARGET_RECEIPT,
        JSON.stringify(proof, null, 2) + '\n');
    } finally { await workbench.dispose(); }
  } finally { await lsp.close(); }
});
