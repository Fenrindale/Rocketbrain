'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectMavenResolution } = require('../src/java/maven-resolution');
const { render } = require('../src/java/maven-resolution-vscode');
const { jdbcReadback } = require('./java-source-analysis-host');
const { fixtureRepository, consumer, resolveClasspath, runConsumer, version, repositoryId } =
  require('./helpers/maven-snapshot-fixture');

async function ownedDatabase() {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const kind = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' };
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.ok(kind[config.dbEngine]);
  const directory = path.dirname(await fs.realpath(config.dbConfigPath));
  const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
  assert.deepEqual([owner.kind, owner.id], [kind[config.dbEngine], path.basename(directory)]);
  return { engine: config.dbEngine, database: JSON.parse(await fs.readFile(config.dbConfigPath, 'utf8')) };
}

async function inFixture(parent, tools, action) {
  const boundary = await fs.realpath(parent);
  const root = await fs.mkdtemp(path.join(boundary, 'rb-maven-snapshot-'));
  const identity = await fs.lstat(root, { bigint: true });
  const cache = await fs.realpath(process.env.ROCKETBRAIN_SNAPSHOT_MAVEN_REPO);
  let fixture;
  try {
    fixture = await fixtureRepository(root, tools, cache);
    const initial = await fixture.publish(1);
    const project = await consumer(path.join(root, 'consumer'), fixture, cache);
    const classpath = await resolveClasspath(project, tools);
    return await action({ root, cache, fixture, project, initial, classpath });
  } finally {
    try { await fixture?.close(); }
    finally {
      const current = await fs.realpath(root), stat = await fs.lstat(current, { bigint: true });
      assert.deepEqual([current, path.dirname(current), stat.dev, stat.ino], [root, boundary, identity.dev, identity.ino]);
      assert.match(path.basename(root), /^rb-maven-snapshot-/u);
      await fs.rm(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    }
  }
}

async function observe(run, fixture, expected, repository = run.cache) {
  const before = fixture.requests.length;
  const report = await run.inspect(repository);
  const node = report.nodes.find(node => node.artifact === fixture.artifact && node.state === 'selected');
  assert.equal(report.mavenVersion, '3.9.11');
  assert.equal(report.dependencyPlugin, '3.11.0');
  assert.equal(node.version, version);
  assert.deepEqual([report.snapshotCache.selected, report.snapshotCache.examined], [1, 1]);
  if (expected) {
    const observation = node.snapshotCache;
    assert.equal(observation.state, 'selected-cache-file');
    assert.equal(observation.origin, 'timestamped-cache-match');
    assert.equal(observation.repositoryId, repositoryId);
    assert.equal(observation.sha256, expected.sha256);
    assert.equal(observation.resolvedVersion, expected.resolved);
    assert.match(observation.fileName, /-1\.2-SNAPSHOT\.jar$/u);
    if (run.verify) assert.deepEqual(await run.verify(report, node), observation);
    const view = await run.show(report, node);
    assert.ok(view.includes(observation.sha256) && view.includes(observation.resolvedVersion));
    assert.ok(view.includes('repository ID ' + repositoryId));
    assert.ok(!view.includes(fixture.url) && !view.includes(run.cache));
  }
  assert.equal(fixture.requests.length, before, 'Inspecting and verifying cached SNAPSHOTs must stay offline.');
  return { report, node };
}

async function exercise(run, context, tools) {
  const { root, fixture, project, initial, classpath } = context;
  const { database, engine } = await ownedDatabase();
  const initialJdbc = await jdbcReadback();
  const first = await observe(run, fixture, initial);
  assert.ok(fixture.requests.includes(initial.request), 'Maven fetched the first timestamped artifact from the owned repository.');
  await runConsumer(project, tools, classpath, database, engine, initial.marker);
  await run.openPom?.(first.report, first.node);

  const updated = await fixture.publish(2);
  const newClasspath = await resolveClasspath(project, tools);
  if (run.verify) await assert.rejects(run.verify(first.report, first.node), /snapshot cache evidence changed/u);
  const second = await observe(run, fixture, updated);
  assert.ok(fixture.requests.includes(updated.request), 'Maven fetched the second timestamped artifact.');
  assert.notEqual(second.node.snapshotCache.sha256, first.node.snapshotCache.sha256);
  await runConsumer(project, tools, newClasspath, database, engine, updated.marker);

  const wrong = path.join(root, 'different-repository');
  await fs.mkdir(wrong);
  const unavailable = await observe(run, fixture, null, wrong);
  assert.equal(unavailable.node.snapshotCache.state, 'unavailable');
  assert.match(unavailable.node.snapshotCache.reason, /selected repository/u);

  const trackingPath = path.join(fixture.folder, '_remote.repositories');
  const observedTracking = await fs.readFile(trackingPath, 'utf8');
  const alternate = path.join(fixture.folder, 'maven-metadata-rb-alternate.xml');
  try {
    await fs.copyFile(path.join(fixture.folder, 'maven-metadata-' + repositoryId + '.xml'), alternate);
    await fs.appendFile(trackingPath, '\n' + updated.jarName + '>rb-alternate=\n');
    if (run.verify) await assert.rejects(run.verify(second.report, second.node), /snapshot cache evidence changed/u);
    const ambiguous = await observe(run, fixture, null);
    assert.equal(ambiguous.node.snapshotCache.origin, 'ambiguous');
    assert.equal(ambiguous.node.snapshotCache.sha256, updated.sha256);
    assert.equal(ambiguous.node.snapshotCache.repositoryId, undefined);
  } finally {
    await fs.writeFile(trackingPath, observedTracking);
    await fs.rm(alternate, { force: true });
  }
  assert.deepEqual(await jdbcReadback(), initialJdbc);
  return { engine, versions: [initial.resolved, updated.resolved], actualTwoSnapshotDownloads: true,
    selectedHashes: [initial.sha256, updated.sha256], separateMavenRepository: true, offlineObservation: true,
    loadedBothSpringJdbcConsumers: true, refreshedCacheInspection: true,
    oldArtifactEvidenceRejected: Boolean(run.verify), ambiguousOriginUnassigned: true,
    wrongRepositoryUnassigned: true, jdbc: initialJdbc };
}

async function runMavenSnapshotChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await api.java.start();
  const tools = { javaHome: api.java.getState().javaHome,
    mavenHome: vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome') };
  assert.ok(tools.mavenHome);
  return inFixture(workspace, tools, async context => {
    const { project, cache, root } = context;
    const workbench = api.java.workbench, service = workbench.mavenResolution;
    try {
      const imported = await workbench.resyncProject({ projectUri: project.uri, allowProjectExecution: true });
      assert.ok(imported.projects.some(item => !path.relative(item.root, project.root) && item.tool === 'maven'));
      const actual = await exercise({
        cache,
        inspect: snapshotRepository => service.inspect({ projectUri: project.uri, allowProjectExecution: true, snapshotRepository }),
        async show(report, node) {
          const editor = await service.showReport(report.id, node.id);
          assert.equal(editor.document.uri.scheme, 'rocketbrain-maven-resolution');
          assert.match(editor.document.lineAt(editor.selection.start.line).text, /1\.2-SNAPSHOT:compile/u);
          return editor.document.getText();
        },
        async openPom(report, node) {
          const anchor = await service.openPom(report.id, node.id);
          assert.equal(anchor.kind, 'direct');
          const editor = vscode.window.activeTextEditor;
          assert.equal(path.relative(editor.document.uri.fsPath, path.join(project.root, 'pom.xml')), '');
          assert.match(editor.document.getText(editor.selection), /<version>1\.2-SNAPSHOT<\/version>/u);
        }
      }, context, tools);
      checks.push('Maven cached two timestamped snapshots, and the dependency view verified the exact chosen artifacts offline before the Spring JDBC consumer loaded each build.');
      return { ...actual, nativeView: true, nativePomNavigation: true };
    } finally {
      const active = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const uri = tab.input?.uri;
        const relative = uri?.scheme === 'file' && path.relative(root, uri.fsPath);
        return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
      });
      if (active.length) await vscode.window.tabGroups.close(active);
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [project.uri]).catch(() => {});
    }
  });
}

async function headless() {
  const { javaHome } = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const tools = { javaHome, mavenHome: await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME) };
  return inFixture(os.tmpdir(), tools, async context => ({
    ...await exercise({
      cache: context.cache,
      inspect: snapshotRepository => inspectMavenResolution({ project: context.project, tools, workspaceRoot: context.root,
        trusted() {}, allowProjectExecution: true, snapshotRepository }),
      verify: (report, node) => report.validateSnapshot(node.id),
      show: report => render(report).text
    }, context, tools),
    nativeView: false
  }));
}

module.exports = { runMavenSnapshotChecks };
if (require.main === module) headless().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
