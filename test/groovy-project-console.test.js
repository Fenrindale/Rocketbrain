'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerGroovyWorkbench, COMMANDS } = require('../src/java/groovy-vscode');
const { captureClasspath, stageClasspath } = require('../src/java/groovy-project-classpath');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { execute } = require('../src/java/testing/provision');
const { resource, scripts, prepareGroovyProject, rangeFor, withGroovyDatabase, expectedOutput } =
  require('./helpers/groovy-project-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome = process.env.ROCKETBRAIN_GROOVY_PROJECT_MAVEN;
const dbs = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_GROOVY_PROJECT_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => pathToFileURL(file).href });
const same = (a, b) => path.relative(a, b) === '';

async function document(file) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');
  const starts = lines.map((_, line) => lines.slice(0, line).reduce((sum, item) => sum + item.length + 1, 0));
  return {
    uri: uri(file), languageId: 'groovy', version: 1, getText: () => text,
    offsetAt(position) { return starts[position.line] + position.character; },
    positionAt(offset) {
      const line = starts.findLastIndex(start => start <= offset);
      return { line, character: offset - starts[line] };
    }
  };
}

function host(root, runtime, request) {
  const commands = new Map(), views = new Map();
  const dispose = () => ({ dispose() {} });
  const vscode = {
    Uri: { parse: value => ({ path: new URL(value).pathname, scheme: new URL(value).protocol.slice(0, -1) }) },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(root) }], textDocuments: [],
      getConfiguration: () => ({ get: key => runtime[key] }), onDidChangeTextDocument: dispose,
      onDidChangeWorkspaceFolders: dispose,
      registerTextDocumentContentProvider(scheme, provider) { views.set(scheme, provider); return dispose(); },
      async openTextDocument(uri) { return { uri, getText: () => views.get(uri.scheme).provideTextDocumentContent(uri) }; }
    },
    commands: { registerCommand(id, action) { commands.set(id, action); return dispose(); } },
    languages: { createDiagnosticCollection: () => ({ dispose(){}, delete(){} }) },
    window: {
      createOutputChannel: () => ({ dispose(){}, append(){}, appendLine(){}, show(){}, clear(){} }),
      showTextDocument: async document => ({ document })
    }
  };
  const java = { getState: () => ({ state: 'running', javaHome: runtime.javaHome }), requestWorkspaceCommand: request };
  return { service: registerGroovyWorkbench(vscode, java), commands, vscode };
}

test('a reviewed Groovy classpath stages independent bytes and refuses changed files', async t => {
  const base = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(base, 'rb-groovy-project-'));
  t.after(async () => {
    const real = await fs.realpath(owned);
    assert.ok(same(real, owned) && same(base, path.dirname(real)) && path.basename(real).startsWith('rb-groovy-project-'));
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const output = path.join(owned, 'classes'), first = path.join(owned, 'first'), second = path.join(owned, 'second');
  await Promise.all([output, first, second].map(directory => fs.mkdir(directory)));
  const artifact = path.join(output, 'Probe.class');
  await fs.writeFile(artifact, 'approved');
  const snapshot = await captureClasspath([output], [owned]);
  const [staged] = await stageClasspath(snapshot, first, () => {});
  await fs.writeFile(artifact, 'modified');
  assert.equal(await fs.readFile(path.join(staged, 'Probe.class'), 'utf8'), 'approved');
  await assert.rejects(stageClasspath(snapshot, second, () => {}), /classpath changed after review/u);
});

test('real JDT Maven runtime and test Groovy selections use only reviewed inputs on both Spring JDBC engines', {
  skip: !runtimeFile || !mavenHome || !dbs.every(([, file]) => file), timeout: 360000
}, async t => {
  const base = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(base, 'rb-groovy-project-'));
  const root = path.join(owned, 'application'), runtime = await read(runtimeFile);
  let lsp, service;
  t.after(async () => {
    await service?.dispose();
    await lsp?.close();
    const real = await fs.realpath(owned);
    assert.ok(same(real, owned) && same(base, path.dirname(real)) && path.basename(real).startsWith('rb-groovy-project-'));
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const fixture = await prepareGroovyProject(root, { ...runtime, mavenHome });
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  settings.java.import.gradle.enabled = false;
  const rootUri = uri(root).toString();
  lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'Groovy project' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: {} },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const commands = [];
  let injectedJar;
  const request = async (command, args) => {
    commands.push(command);
    const result = await lsp.request('workspace/executeCommand', { command, arguments: args }, 90000);
    if (command === 'java.project.getClasspaths' && injectedJar) result.classpaths.push(injectedJar);
    return result;
  };
  await until(async () => {
    const projects = await request('java.project.getAll', []);
    return projects.some(value => same(root, fileURLToPath(value)));
  }, 120000);
  const output = await request('java.project.getClasspaths', [fixture.uri, { scope: 'runtime' }]);
  assert.ok(same(fileURLToPath(output.projectRoot), root));
  const ownedHost = host(root, runtime, request);
  service = ownedHost.service;
  assert.equal(ownedHost.commands.has(COMMANDS.project), true);
  assert.equal(ownedHost.commands.has(COMMANDS.stopProject), true);
  assert.equal((await service.project.list()).filter(item => same(item.root, root)).length, 1);
  const docs = Object.fromEntries(await Promise.all(Object.keys(scripts).map(async name =>
    [name, await document(path.join(root, 'scripts', name + '.groovy'))])));
  const review = (name, scope = 'runtime') => service.project.review({
    document: docs[name], range: rangeFor(docs[name], name), projectUri: fixture.uri, scope
  });
  const run = plan => service.project.run({ id: plan.id, allowExecution: true });
  const plan = await review('query');
  assert.equal(plan.project.tool, 'maven');
  assert.equal(plan.scope, 'runtime');
  assert.ok(plan.classpath.some(entry => entry.kind === 'directory' && entry.files > 0));
  assert.ok(plan.classpath.some(entry => /spring-jdbc-7\.0\.10\.jar$/u.test(entry.file)));
  assert.ok((await service.project.show(plan.id)).document.getText().includes(plan.source));
  await assert.rejects(service.project.run({ id: plan.id }), /Explicitly approve/u);

  const factor = path.join(root, resource);
  await fs.writeFile(factor, '3\n');
  try { await assert.rejects(run(plan), /classpath or descriptor changed/u); }
  finally { await fs.writeFile(factor, '2\n'); }
  await assert.rejects(run(plan), /selection again/u);
  const stale = await review('query');
  const sourceFile = docs.query.uri.fsPath;
  await fs.appendFile(sourceFile, '// late change\n');
  try { await assert.rejects(run(stale), /source selection changed/u); }
  finally { await fs.writeFile(sourceFile, scripts.query); }

  const jar = path.join(owned, 'indirect.jar'), manifest = path.join(owned, 'MANIFEST.MF');
  await fs.writeFile(manifest, 'Manifest-Version: 1.0\nClass-Path: second.jar\n\n');
  const executable = path.join(runtime.javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  const archive = await execute(executable, ['--create', '--file', jar, '--manifest', manifest], { timeoutMs: 30000 });
  assert.equal(archive.code, 0, archive.output);
  injectedJar = jar;
  try { await assert.rejects(review('query'), /no indirect classpath/u); }
  finally { injectedJar = undefined; }

  assert.equal((await run(await review('scope', 'runtime'))).state, 'error');
  const testScope = await run(await review('scope', 'test'));
  assert.equal(testScope.state, 'ok', testScope.error);
  assert.equal(testScope.value, 'test-class');
  const queried = [];
  for (const [engine, config] of dbs) {
    queried.push(await withGroovyDatabase(await read(config), engine, async () => expectedOutput(await run(await review('query')), engine)));
  }
  assert.equal((await service.evaluate({ code: 'scratch = 17', workingDirectory: root })).value, '17');
  assert.equal((await service.evaluate({ code: 'import fixture.groovyproject.ProjectProbe; ProjectProbe',
    workingDirectory: root })).state, 'error');
  const started = path.join(owned, 'groovy-started.txt');
  const previous = process.env.RB_GROOVY_PROJECT_STARTED;
  process.env.RB_GROOVY_PROJECT_STARTED = started;
  let waiting;
  try {
    waiting = run(await review('stop'));
    void waiting.catch(() => {});
    await until(async () => (await fs.readFile(started, 'utf8').catch(() => '')) === 'ready', 16000);
    assert.equal(await service.project.stop(), true);
    await assert.rejects(waiting, /evaluation was stopped/u);
    assert.equal(await service.project.stop(), false);
  } finally {
    await service.project.stop();
    await waiting?.catch(() => {});
    if (previous === undefined) delete process.env.RB_GROOVY_PROJECT_STARTED;
    else process.env.RB_GROOVY_PROJECT_STARTED = previous;
  }
  assert.equal((await service.evaluate({ code: 'scratch', workingDirectory: root })).value, '17');
  assert.ok(commands.every(command => ['java.project.getAll', 'java.project.getSettings', 'java.project.getClasspaths'].includes(command)));
  if (process.env.ROCKETBRAIN_GROOVY_PROJECT_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_GROOVY_PROJECT_RECEIPT,
    JSON.stringify({ tool: plan.project.tool, runtimeAndTestScopes: true, copiedProjectClassAndResources: true, database: queried,
      approvedSelectionOnly: true, oneUse: true, staleClasspathRefused: true, staleEditorRefused: true,
      indirectJarRefused: true, projectStopPreservedScratch: true, readOnlyJdt: true }, null, 2) + '\n');
});

test('real Buildship Groovy project loader resolves approved Gradle outputs on both Spring JDBC engines', {
  skip: !runtimeFile || !process.env.ROCKETBRAIN_GROOVY_PROJECT_GRADLE_CACHE || !dbs.every(([, file]) => file), timeout: 350000
}, async t => {
  const base = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(base, 'rb-groovy-project-'));
  const root = path.join(owned, 'gradle-application'), runtime = await read(runtimeFile);
  const gradleCache = process.env.ROCKETBRAIN_GROOVY_PROJECT_GRADLE_CACHE;
  let lsp, service;
  t.after(async () => {
    await service?.dispose();
    await lsp?.close();
    const real = await fs.realpath(owned);
    assert.ok(same(real, owned) && same(base, path.dirname(real)) && path.basename(real).startsWith('rb-groovy-project-'));
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const fixture = await prepareGroovyProject(root, { ...runtime, gradleCache, tool: 'gradle' });
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }],
    { gradleHome: runtime.gradleHome, gradleJavaHome: runtime.javaHome });
  settings.java.import.gradle.wrapper.enabled = false;
  const rootUri = uri(root).toString();
  const launch = resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') });
  launch.options.env.GRADLE_USER_HOME = gradleCache;
  lsp = new StdioLsp(launch);
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'Groovy Gradle project' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: {} },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const request = (command, args) => lsp.request('workspace/executeCommand', { command, arguments: args }, 90000);
  await until(async () => {
    const projects = await request('java.project.getAll', []);
    if (!projects.some(value => same(root, fileURLToPath(value)))) return false;
    const { classpaths, projectRoot } = await request('java.project.getClasspaths', [fixture.uri, { scope: 'runtime' }]);
    if (!projectRoot || !same(root, fileURLToPath(projectRoot))) return false;
    for (const candidate of classpaths) {
      const directory = candidate.startsWith('file:') ? fileURLToPath(candidate) : candidate;
      if (!path.isAbsolute(directory)) continue;
      const actual = await fs.stat(path.join(directory, 'fixture/groovyproject/ProjectProbe.class')).catch(() => null);
      if (actual?.isFile()) return true;
    }
    return false;
  }, 150000);
  service = host(root, runtime, request).service;
  const local = await document(path.join(root, 'scripts', 'query.groovy'));
  const options = { document: local, range: rangeFor(local, 'query'), projectUri: fixture.uri, scope: 'runtime' };
  const jdbc = [];
  for (const [engine, config] of dbs) {
    jdbc.push(await withGroovyDatabase(await read(config), engine, async () => {
      const plan = await service.project.review(options);
      assert.equal(plan.project.tool, 'gradle');
      assert.ok(plan.classpath.some(entry => entry.kind === 'directory' && entry.files > 0));
      return expectedOutput(await service.project.run({ id: plan.id, allowExecution: true }), engine);
    }));
  }
  if (process.env.ROCKETBRAIN_GROOVY_PROJECT_GRADLE_RECEIPT) await fs.writeFile(
    process.env.ROCKETBRAIN_GROOVY_PROJECT_GRADLE_RECEIPT,
    JSON.stringify({ tool: 'gradle', liveBuildship: true, actualGradleBuild: true, copiedProjectClassAndResources: true, database: jdbc }, null, 2) + '\n');
});
