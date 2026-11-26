'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createWorkspaceIndex, indexScope, indexStorage, readGeneration } = require('../src/java/workspace-index');
const { indexConfiguration } = require('../src/java/workspace-index-vscode');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { collectProjects } = require('../src/java/workbench-model');
const { StdioLsp, positionOf, until } = require('./helpers/stdio-lsp');
const { buildIndexFixture, querySpring } = require('./helpers/java-workspace-index-fixture');

function uri(file) {
  return { scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href };
}

function owned(t, release) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'rb-java-index-')));
  const workspace = path.join(base, 'workspace'), storage = path.join(base, 'storage');
  for (const folder of [workspace, storage]) fs.mkdirSync(folder);
  const folders = [{ uri: uri(workspace), name: 'index-fixture' }];
  const scope = indexScope(folders, uri(storage));
  const records = new Map();
  const memento = { get: key => records.get(key), update: async (key, value) => records.set(key, value) };
  t.after(async () => {
    await release?.();
    const prefix = path.join(fs.realpathSync.native(os.tmpdir()), 'rb-java-index-');
    const current = fs.realpathSync.native(base);
    assert.ok(current.startsWith(prefix), 'Clean up only the owned Java index fixture');
    fs.rmSync(current, { recursive: true, force: true });
  });
  return { base, workspace, folders, scope, memento };
}

function reviewedFixture(t, { fail = false } = {}) {
  const ownedProject = owned(t);
  const { workspace, scope, memento } = ownedProject;
  const main = path.join(workspace, 'Main.java');
  fs.writeFileSync(main, 'final class Main {}');
  const legacy = path.join(scope.storage, 'engine', 'workspace-data');
  fs.mkdirSync(legacy, { recursive: true });
  const sentinel = path.join(legacy, 'old-index');
  fs.writeFileSync(sentinel, 'old bytes');
  let dirty = false, settings = 'projectJdks: JDK25', generation = null, session = 1;
  let starts = 0, stops = 0, workspaceData = legacy;
  const sourceRoots = [{ path: workspace, scope: 'main', generated: false }];
  const projects = [{ root: workspace, tool: 'maven', jdk: 'jdk25', compliance: '25', sourceRoots, libraries: [] }];
  const service = createWorkspaceIndex({
    memento, deadlineMs: 100, pollMs: 1,
    context: () => ({ scope, settings, documents: () => [{ isDirty: dirty, uri: uri(main) }] }),
    current: () => ({ generation, workspaceData, session, runtimeIdentity: 'engine', applied: 'initialize' }),
    observe: async () => projects,
    stop: async () => { stops++; workspaceData = undefined; },
    start: async (selected, candidate) => {
      starts++;
      if (fail && candidate) throw Error('fixture refused import');
      workspaceData = path.join(indexStorage(selected, candidate), 'engine', 'workspace-data');
      fs.mkdirSync(workspaceData, { recursive: true });
      generation = candidate;
      return { generation, workspaceData, session: ++session, runtimeIdentity: 'engine', applied: 'initialize' };
    }
  });
  return { ...ownedProject, service, main, sentinel, legacy, sourceRoots, actions: () => [starts, stops],
    dirty: value => { dirty = value; }, settings: value => { settings = value; }, epoch: () => session++ };
}

test('a fresh workspace index promotes only its verified generation and retains the old index bytes', async t => {
  const f = reviewedFixture(t);
  const plan = await f.service.review();
  assert.deepEqual(plan.projects.map(item => item.tool), ['maven']);
  await assert.rejects(f.service.apply(plan.id), /approve/u);
  const receipt = await f.service.apply(plan.id, { approved: true });
  assert.equal(receipt.state, 'rebuilt');
  assert.deepEqual(f.actions(), [1, 1]);
  assert.equal(readGeneration(f.scope, f.memento), receipt.generation);
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'old bytes');
  assert.notEqual(receipt.workspaceData, receipt.previousWorkspaceData);
  assert.ok(receipt.priorRetained);
  assert.equal(readGeneration({ ...f.scope, key: 'other-workspace' }, f.memento), null);
  await assert.rejects(f.service.apply(plan.id, { approved: true }), /approve/u);
});

test('workspace index review refuses dirty, configured JDK, disk input, active engine and cancellation drift pre-swap', async t => {
  const f = reviewedFixture(t);
  f.dirty(true);
  await assert.rejects(f.service.review(), /Save modified/u);
  f.dirty(false);
  let plan = await f.service.review();
  f.settings('projectJdks: JDK26');
  await assert.rejects(f.service.apply(plan.id, { approved: true }), /configuration changed/u);
  plan = await f.service.review();
  fs.appendFileSync(f.main, '\n');
  await assert.rejects(f.service.apply(plan.id, { approved: true }), /project\/source model changed/u);
  plan = await f.service.review();
  f.epoch();
  await assert.rejects(f.service.apply(plan.id, { approved: true }), /active Java index changed/u);
  plan = await f.service.review();
  await assert.rejects(f.service.apply(plan.id, { approved: true, cancellation: AbortSignal.abort() }), /cancelled/u);
  assert.deepEqual(f.actions(), [0, 0]);
  assert.equal(readGeneration(f.scope, f.memento), null);
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'old bytes');
});

test('an incomplete replacement restarts the retained index without promoting or deleting any generation', async t => {
  const f = reviewedFixture(t, { fail: true });
  const plan = await f.service.review();
  await assert.rejects(f.service.apply(plan.id, { approved: true }), /fixture refused import.*restored the prior/u);
  assert.deepEqual(f.actions(), [2, 2]);
  assert.equal(readGeneration(f.scope, f.memento), null);
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'old bytes');
  assert.equal(fs.readdirSync(path.join(f.scope.storage, 'index-generations')).length, 1);
});

test('an exact missing optional source stays scoped and the next rebuild retains the active saved generation', async t => {
  const f = reviewedFixture(t);
  f.sourceRoots.push({ path: path.join(f.workspace, 'src/test/resources'), unavailable: true });
  const first = await f.service.review();
  const built = await f.service.apply(first.id, { approved: true });
  const nextSentinel = path.join(built.workspaceData, 'second-index');
  fs.writeFileSync(nextSentinel, 'second bytes');
  f.sourceRoots.push({ path: path.join(f.base, 'outside'), unavailable: true });
  await assert.rejects(f.service.review(), /outside the reviewed workspace/u);
  f.sourceRoots.pop();
  const second = await f.service.review();
  const next = await f.service.apply(second.id, { approved: true });
  assert.equal(next.previousWorkspaceData, built.workspaceData);
  assert.equal(readGeneration(f.scope, f.memento), next.generation);
  assert.equal(fs.readFileSync(nextSentinel, 'utf8'), 'second bytes');
  assert.equal(fs.readFileSync(f.sentinel, 'utf8'), 'old bytes');
});

test('workspace and folder settings independently capture configured per-project JDKs', () => {
  let scopedJdk = 'jdk-A';
  const editor = { workspace: { getConfiguration: (_, scope) => ({
    get: key => key === 'projectJdks' && scope ? [{ project: scope.fsPath, javaHome: scopedJdk }] : undefined
  }) } };
  const folders = [{ uri: uri(path.resolve('a-project')) }];
  const before = indexConfiguration(editor, folders);
  scopedJdk = 'jdk-B';
  assert.notEqual(indexConfiguration(editor, folders), before);
});

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const configPath = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_JAVA_INDEX_CLASSPATH;
const mavenHome = process.env.ROCKETBRAIN_JAVA_INDEX_MAVEN_HOME;
const mysqlConfig = process.env.ROCKETBRAIN_JAVA_INDEX_MYSQL_CONFIG;
const mariaConfig = process.env.ROCKETBRAIN_JAVA_INDEX_MARIADB_CONFIG;

test('stock JDT LS replaces a real Maven + Gradle index with equivalent source bindings and Spring JDBC against both engines',
  { skip: !configPath || !classpathFile || !mavenHome || !mysqlConfig || !mariaConfig, timeout: 510000 }, async t => {
    const f = owned(t, () => stop());
    const runtime = readJson(configPath), tools = { ...runtime, mavenHome };
    const fixture = await buildIndexFixture(f.workspace, tools);
    const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }],
      { gradleHome: runtime.gradleHome, gradleJavaHome: runtime.javaHome });
    const rootUri = pathToFileURL(f.workspace).href;
    const engineState = { session: 0 };
    let lsp;
    async function stop() {
      if (!lsp) return;
      await lsp.close();
      lsp = undefined;
    }
    async function start(scope, generation) {
      const launch = resolveLaunch({ javaHome: runtime.javaHome, serverPath: runtime.serverPath,
        storagePath: indexStorage(scope, generation) });
      lsp = new StdioLsp(launch);
      const result = await lsp.request('initialize', {
        processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'index-fixture' }],
        capabilities: { workspace: { workspaceFolders: true, configuration: true, applyEdit: true }, textDocument: { definition: { linkSupport: true } } },
        initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings,
          extendedClientCapabilities: { progressReportProvider: true, classFileContentsSupport: true } }
      }, 90000);
      assert.ok(result.capabilities.definitionProvider);
      lsp.notify('initialized', {});
      for (const file of [fixture.mavenReader, fixture.gradleReader]) lsp.notify('textDocument/didOpen', {
        textDocument: { uri: pathToFileURL(file).href, languageId: 'java', version: 1, text: fs.readFileSync(file, 'utf8') }
      });
      Object.assign(engineState, { session: engineState.session + 1, generation, runtimeIdentity: launch.identity,
        workspaceData: launch.data, applied: 'owned-java-25' });
      return { ...engineState };
    }
    const observe = async () => (await collectProjects({ folders: f.folders,
      request: (command, args) => lsp.request('workspace/executeCommand', { command, arguments: args }, 30000) })).projects;
    const source = fs.readFileSync(fixture.gradleReader, 'utf8');
    const definitions = async () => until(async () => {
      const response = await lsp.request('textDocument/definition', {
        textDocument: { uri: pathToFileURL(fixture.gradleReader).href }, position: positionOf(source, 'GeneratedLabel.value', 16)
      }, 30000);
      const binding = response?.find(item => {
        const link = item.uri || item.targetUri;
        return link?.startsWith('file:') && fs.realpathSync.native(fileURLToPath(link)) === fs.realpathSync.native(fixture.generated);
      });
      return binding && { file: path.relative(f.workspace, fixture.generated), line: (binding.range || binding.targetSelectionRange).start.line };
    }, 90000);
    const spring = async when => {
      const actual = [];
      for (const [engine, file] of [['mysql', mysqlConfig], ['mariadb', mariaConfig]]) {
        actual.push(await querySpring(path.join(f.base, when, engine), fixture, runtime, engine, classpathFile, readJson(file)));
      }
      return actual;
    };
    await start(f.scope, null);
    const model = await until(async () => {
      const projects = await observe();
      return ['maven','gradle'].every(tool => projects.some(item => item.tool === tool)) &&
        projects.some(item => item.sourceRoots.some(root => root.generated && !root.unavailable)) && projects;
    }, 90000);
    assert.equal(model.length, 2);
    const before = await definitions(), original = lsp.process.pid;
    const sentinel = path.join(engineState.workspaceData, 'rocketbrain-test-retained');
    fs.writeFileSync(sentinel, 'owned original index');
    const databaseBefore = await spring('before');
    const service = createWorkspaceIndex({ context: () => ({ scope: f.scope, settings: 'owned-java-25', documents: () => [] }),
      current: () => ({ ...engineState }), observe, start, stop, memento: f.memento });
    const plan = await service.review();
    assert.ok(plan.projects.some(project => project.generatedRoots > 0));
    const result = await service.apply(plan.id, { approved: true });
    assert.equal(result.state, 'rebuilt');
    assert.notEqual(result.workspaceData, result.previousWorkspaceData);
    assert.notEqual(lsp.process.pid, original);
    const after = await definitions();
    assert.deepEqual(after, before);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'owned original index');
    assert.equal(readGeneration(f.scope, f.memento), result.generation);
    const databaseAfter = await spring('after');
    assert.deepEqual(databaseAfter, databaseBefore);
    const report = { buildTools: ['maven', 'gradle'], projects: plan.projects.length, inputFiles: plan.inputFiles,
      generatedDefinition: after, actualJvmRestart: true, oldIndexRetained: result.priorRetained,
      generationCommitted: true, before: databaseBefore, after: databaseAfter };
    if (process.env.ROCKETBRAIN_JAVA_INDEX_RECEIPT) {
      fs.writeFileSync(process.env.ROCKETBRAIN_JAVA_INDEX_RECEIPT, JSON.stringify(report, null, 2) + '\n');
    }
  });
