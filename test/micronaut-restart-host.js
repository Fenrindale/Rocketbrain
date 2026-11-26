'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { debugFixture, get, assertClosed, removeFixture } = require('./helpers/micronaut-debug-fixture');
const { withOwnedDatabase } = require('./micronaut-gradle-host');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { registerMicronautWorkbench } = require('../src/java/micronaut-vscode');
const { micronautMavenProject } = require('../src/java/micronaut-model');
const { buildFingerprint } = require('../src/java/workbench-model');
const { BuildTasks } = require('../src/java/workbench-tasks');
const { execute } = require('../src/java/testing/provision');
const { until } = require('./helpers/stdio-lsp');

const explicit = { allowProjectExecution: true };
const checksum = data => createHash('sha256').update(data).digest('hex');
const versions = ['first-owned-build', 'second-reviewed-build'];
const scope = '/greeting/restart-proof';

async function withProject(parent, run) {
  parent = await fs.realpath(parent);
  const folder = await fs.mkdtemp(path.join(parent, 'rb-micronaut-debug-'));
  const identity = await fs.lstat(folder, { bigint: true });
  try {
    const fixture = await debugFixture(path.join(folder, 'maven'), 'maven', {
      mavenRepository: process.env.ROCKETBRAIN_MICRONAUT_MAVEN_REPO
    });
    const insert = '\n    @Get(value = "/restart-proof", produces = "text/plain")\n' +
      '    public String restartProof() { return "' + versions[0] + '"; }\n';
    fixture.text = fixture.text.replace(/\n\}\s*$/u, insert + '}\n');
    await fs.writeFile(fixture.source, fixture.text);
    return await run(fixture, folder);
  } finally { await removeFixture(folder, parent, identity); }
}

async function exercise(service, fixture, projectUri, { dirty, cancelDuringBuild } = {}) {
  const old = await service.run({ projectUri, environment: 'dev', ...explicit });
  const oldTarget = path.join(fixture.root, 'target', micronautMavenProject({ tool: 'maven', root: fixture.root }).jarName);
  const originalTarget = checksum(await fs.readFile(oldTarget));
  assert.equal(old.sha256, originalTarget);
  assert.equal(await get(old, scope), versions[0]);
  assert.equal(await get(old, '/greeting/jdbc'), '2');
  const checkOld = async () => {
    assert.equal(service.getState().runId, old.runId);
    assert.equal(await get(old, scope), versions[0]);
  };
  const input = await fs.readFile(fixture.source, 'utf8');
  assert.equal(input, fixture.text);
  const updated = input.replace(versions[0], versions[1]);
  const differ = path.relative(fixture.root, fixture.source).split(path.sep).join('/');
  try {
    const clean = await service.prepareRestart();
    assert.equal(clean.baselineObserved, true);
    assert.deepEqual(clean.changes, []);
    await assert.rejects(service.restart({ reviewId: clean.reviewId }), /Explicitly approve/u);
    if (dirty) await dirty(() => assert.rejects(service.prepareRestart(), /Save modified Micronaut/u));
    await fs.writeFile(fixture.source, updated);
    await assert.rejects(service.restart({ reviewId: clean.reviewId, ...explicit }), /changed after review/u);
    await checkOld();

    const invalid = updated.replace('return "' + versions[1] + '"', 'return undeclaredRestartFixtureValue');
    await fs.writeFile(fixture.source, invalid);
    const bad = await service.prepareRestart();
    assert.deepEqual(bad.changes, [{ file: differ, action: 'modified' }]);
    await assert.rejects(service.restart({ reviewId: bad.reviewId, ...explicit }), /Maven did not produce a fresh/u);
    await checkOld();

    await fs.writeFile(fixture.source, updated);
    const approved = await service.prepareRestart();
    assert.equal(approved.runId, old.runId);
    assert.equal(approved.projectUri, projectUri);
    assert.equal(approved.task, 'Maven offline package');
    assert.equal(approved.oldBaseUrl, old.baseUrl);
    assert.deepEqual(approved.changes, [{ file: differ, action: 'modified' }]);
    const sourceDigest = approved.sourceDigest;
    assert.match(sourceDigest, /^[0-9a-f]{64}$/u);
    const blocked = new AbortController();
    blocked.abort();
    await assert.rejects(service.restart({ reviewId: approved.reviewId, ...explicit, cancellation: blocked.signal }), /cancelled/u);
    await checkOld();

    if (cancelDuringBuild) {
      await cancelDuringBuild(cancellation =>
        assert.rejects(service.restart({ reviewId: approved.reviewId, ...explicit, cancellation }), /cancelled/u));
      await checkOld();
    }
    const nextApproval = await service.prepareRestart();
    assert.equal(nextApproval.sourceDigest, sourceDigest);
    nextApproval.changes.length = 0;
    nextApproval.sourceDigest = 'untrusted-client-change';
    const after = await service.restart({ reviewId: nextApproval.reviewId, ...explicit });
    assert.equal(after.sourceDigest, sourceDigest);
    assert.equal(after.previousArtifactSha256, originalTarget);
    assert.equal(after.ownershipVerified, true);
    assert.equal(after.mode, 'owned-jvm-restart');
    assert.equal(after.restartedFrom, old.runId);
    assert.equal(after.environment, old.environment);
    assert.equal(after.projectUri, old.projectUri);
    assert.notEqual(after.sha256, old.sha256);
    assert.notEqual(after.runId, old.runId);
    assert.notEqual(after.baseUrl, old.baseUrl);
    assert.equal(service.getState().runId, after.runId);
    await assertClosed(Number(new URL(old.baseUrl).port));
    assert.equal(await get(after, scope), versions[1]);
    assert.equal(await get(after, '/greeting/jdbc'), '2');
    assert.equal(checksum(await fs.readFile(oldTarget)), originalTarget);
    assert.equal(await fs.readFile(fixture.source, 'utf8'), updated);
    await assert.rejects(service.restart({ reviewId: nextApproval.reviewId, ...explicit }), /current one-use/u);
    const continuing = await service.prepareRestart();
    assert.equal(continuing.runId, after.runId);
    assert.deepEqual(continuing.changes, []);
    assert.equal((await service.stop()).state, 'stopped');
    await assertClosed(Number(new URL(after.baseUrl).port));
    await assert.rejects(service.restart({ reviewId: continuing.reviewId, ...explicit }), /current one-use/u);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    return {
      oldResponse: versions[0], newResponse: versions[1], mode: after.mode, sameEnvironment: true,
      exactSavedSources: true, freshArtifact: true, ownerVerified: true, oldAndNewListenerReleased: true,
      noOriginalTargetWrite: true, staleApprovalRejected: true, failedBuildRetainedOldApp: true,
      preCancelledRetainedOldApp: true, buildCancellationProved: !!cancelDuringBuild,
      dirtyBufferRejected: !!dirty, oneUseApproval: true, nextReviewOwnsNewRun: true,
      isolatedOwnerReceipt: true, micronautHttpJdbc: 2, springJdbcAfterRestart: jdbc
    };
  } finally { await service.stop(); }
}

async function headless(fixture, folder) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const javaHome = await fs.realpath(runtime.javaHome);
  const mavenHome = await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME || runtime.mavenHome);
  const tools = { javaHome, mavenHome };
  const uri = pathToFileURL(fixture.root).href;
  const project = { uri, root: fixture.root, name: 'Owned Micronaut restart', id: 'fixture', tool: 'maven',
    jdk: javaHome, buildFingerprint: buildFingerprint(fixture.root) };
  const tasks = new BuildTasks({ tools: () => tools, storagePath: folder,
    runner: { execute: (spec, options) => execute(spec.command, spec.args, { ...options, cwd: spec.cwd, env: spec.env }) } });
  const documents = [];
  const registration = () => ({ dispose() {} });
  let logs = '', observeBuild;
  const vscode = {
    Uri: { parse: value => value },
    workspace: { isTrusted: true, textDocuments: documents,
      workspaceFolders: [{ uri: { scheme: 'file', toString: () => uri } }],
      getConfiguration: () => ({ get: key => tools[key] }) },
    window: { createOutputChannel: () => ({
      append(chunk) {
        logs = (logs + chunk).slice(-9000);
        if (observeBuild && logs.includes('Scanning for projects')) observeBuild();
      },
      appendLine() {}, dispose() {}
    }) },
    commands: { registerCommand: registration },
    languages: { registerCompletionItemProvider: registration, registerDefinitionProvider: registration }
  };
  const java = { getState: () => runtime, workbench: {
    getSnapshot: () => ({ projects: [project] }),
    discoverTasks: options => tasks.discover(project, options),
    runTask: options => tasks.run(project, options.taskId, options)
  } };
  const service = registerMicronautWorkbench(vscode, java);
  try {
    return await exercise(service, fixture, uri, {
      dirty: async verify => {
        documents.push({ isDirty: true, uri: { scheme: 'file', fsPath: fixture.source } });
        try { await verify(); } finally { documents.pop(); }
      },
      cancelDuringBuild: async run => {
        const cancellation = new AbortController();
        const timer = setTimeout(() => cancellation.abort(), 30000);
        logs = '';
        let observed = false;
        observeBuild = () => { observed = true; cancellation.abort(); };
        try { await run(cancellation.signal); assert.equal(observed, true); }
        finally { clearTimeout(timer); observeBuild = undefined; }
      }
    });
  } catch (error) {
    if (logs) process.stderr.write(logs + '\n');
    throw error;
  } finally { await service.dispose(); }
}

async function runMicronautRestartChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api, workspace);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.micronaut.restart'));
  const service = api.java.micronaut;
  assert.equal(typeof service.prepareRestart, 'function');
  const result = await withOwnedDatabase(() => withProject(workspace, async fixture => {
    const projectUri = vscode.Uri.file(fixture.root).toString();
    const sourceUri = vscode.Uri.file(fixture.source);
    try {
      const imported = await api.java.workbench.resyncProject({ projectUri, ...explicit });
      assert.ok(imported.projects.some(project => !path.relative(project.root, fixture.root) && project.tool === 'maven'));
      const observed = imported.projects.find(project => !path.relative(project.root, fixture.root));
      const dirty = async verify => {
        const document = await vscode.workspace.openTextDocument(sourceUri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const original = document.getText(), pos = document.positionAt(original.length);
        assert.equal(await editor.edit(edit => edit.insert(pos, '// unsaved fixture line\n')), true);
        await until(() => document.isDirty, 5000);
        try { await verify(); }
        finally {
          await vscode.commands.executeCommand('undo');
          await until(() => !document.isDirty && document.getText() === original, 5000);
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      };
      return await exercise(service, fixture, observed.uri, { dirty });
    } finally {
      await service.stop();
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    }
  }));
  checks.push('Reviewed changed Micronaut Java, refused stale and failed builds with the old JVM still serving, built a fresh Maven JAR, switched to its owned loopback JVM, and verified the new HTTP behavior and Spring JDBC.');
  return result;
}

module.exports = { runMicronautRestartChecks };

if (require.main === module) {
  withOwnedDatabase(() => withProject(os.tmpdir(), headless)).then(result =>
    console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
