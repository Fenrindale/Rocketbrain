'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { lockName } = require('../src/java/maven-external-models');
const { until } = require('./helpers/stdio-lsp');
const { modelRepository, reactorAt, runMaven, compileAndQuery } = require('./helpers/maven-snapshot-model-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function eclipseProjects(project, classpathFile, repository, group, owner) {
  const classpath = (await fs.readFile(classpathFile, 'utf8')).trim().split(path.delimiter);
  const moduleArtifact = path.join(repository, ...group.split('.'), 'core', '1.0.0', 'core-1.0.0.jar');
  assert.ok(classpath.some(file => !path.relative(file, moduleArtifact)), 'Maven did not resolve the reactor core JAR.');
  const libraries = classpath.filter(file => path.relative(file, moduleArtifact));
  assert.ok(libraries.some(file => path.basename(file) === 'jspecify-1.0.0.jar'));
  assert.ok(libraries.some(file => path.basename(file) === 'spring-jdbc-7.0.10.jar'));
  const coreName = owner + '-core';
  const folders = ['core', 'app'].map(module => path.join(project.root, module));
  for (const [index, folder] of folders.entries()) {
    const app = index === 1, name = app ? owner + '-app' : coreName;
    await fs.writeFile(path.join(folder, '.project'), '<projectDescription><name>' + xml(name) +
      '</name><projects>' + (app ? '<project>' + xml(coreName) + '</project>' : '') +
      '</projects><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>' +
      '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' });
    const entries = ['<classpathentry kind="src" path="src/main/java"/>',
      '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
      ...(app ? ['<classpathentry kind="src" path="/' + xml(coreName) + '" combineaccessrules="false"/>',
        ...libraries.map(file => '<classpathentry kind="lib" path="' + xml(file.split(path.sep).join('/')) + '"/>')] : []),
      '<classpathentry kind="output" path="bin"/>'];
    await fs.writeFile(path.join(folder, '.classpath'), '<classpath>' + entries.join('') + '</classpath>', { flag: 'wx' });
    await fs.mkdir(path.join(folder, '.settings'));
    await fs.mkdir(path.join(folder, 'bin'));
    await fs.writeFile(path.join(folder, '.settings', 'org.eclipse.jdt.core.prefs'),
      'eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.compliance=17\n' +
      'org.eclipse.jdt.core.compiler.source=17\norg.eclipse.jdt.core.compiler.codegen.targetPlatform=17\n');
  }
  return folders;
}

async function eclipseImport(api, vscode, project, folders, source, dest) {
  // Explicit Eclipse import uses the exact offline Maven classpath without changing the user's m2e cache settings.
  const poms = [project.root, ...folders].map(folder => path.join(folder, 'pom.xml'));
  const saved = [];
  try {
    for (const file of poms) {
      await fs.rename(file, file + '.rb-saved');
      saved.push(file);
    }
    const descriptors = folders.map(folder => vscode.Uri.file(path.join(folder, '.project')).toString());
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', descriptors, [], []);
    const classpath = file => api.java.executeWorkspaceCommand('java.project.getClasspaths', vscode.Uri.file(file).toString(), { scope: 'runtime' });
    await until(async () => {
      const sourcePaths = await classpath(source), targetPaths = await classpath(path.dirname(dest));
      if (!sourcePaths?.projectRoot || !targetPaths?.projectRoot) return false;
      assert.equal(path.relative(folders[1], fileURLToPath(sourcePaths.projectRoot)), '');
      assert.equal(path.relative(folders[0], fileURLToPath(targetPaths.projectRoot)), '');
      assert.ok(sourcePaths.classpaths.some(file => !path.relative(file, path.join(folders[0], 'bin'))));
      assert.ok(sourcePaths.classpaths.some(file => path.basename(file) === 'jspecify-1.0.0.jar'));
      return true;
    }, 45000);
  } finally {
    for (const file of saved.reverse()) await fs.rename(file + '.rb-saved', file);
  }
}

async function runMavenSnapshotMoveChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await api.java.start();
  const tools = { javaHome: api.java.getState().javaHome,
    mavenHome: vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome') };
  assert.ok(tools.javaHome && tools.mavenHome);
  const repository = await fs.realpath(process.env.ROCKETBRAIN_MAVEN_MODEL_REPO);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const databaseFolder = path.dirname(await fs.realpath(spring.dbConfigPath));
  const dbOwner = JSON.parse(await fs.readFile(path.join(databaseFolder, 'owner.json'), 'utf8'));
  assert.equal(spring.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.deepEqual([dbOwner.id, dbOwner.kind], [path.basename(databaseFolder), {
    mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1'
  }[spring.dbEngine]]);
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-snapshot-move-'));
  const identity = await fs.lstat(root, { bigint: true });
  const remote = await modelRepository();
  let folders = [];
  try {
    const generation = remote.publish(1);
    const project = await reactorAt(path.join(root, 'reactor'), remote, repository);
    await runMaven(project, tools, ['validate'], ['-U']);
    await project.setOffline(true);
    await fs.writeFile(path.join(project.root, lockName), JSON.stringify({ version: 2,
      models: generation.models.map(({ file: _file, ...pin }) => pin) }, null, 2) + '\n');
    const source = path.join(project.root, 'app', 'src/main/java/fixture/snapshot/SnapshotUtility.java');
    const destination = path.join(project.root, 'core', 'src/main/java/fixture/destination/SnapshotUtility.java');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(path.join(path.dirname(destination), 'Anchor.java'), 'package fixture.destination; public final class Anchor {}\n');
    await fs.writeFile(source, 'package fixture.snapshot;\npublic final class SnapshotUtility {\n  public static int zero() { return 0; }\n}\n');
    const app = await fs.readFile(project.source, 'utf8');
    await fs.writeFile(project.source, app.replace('Marker.value()', '(Marker.value() + SnapshotUtility.zero())'));
    const classpathFile = path.join(root, 'classpath-before.txt');
    await compileAndQuery(project, tools, database, spring.dbEngine, generation, classpathFile);
    folders = await eclipseProjects(project, classpathFile, repository, remote.fixtureGroup, path.basename(root));
    await eclipseImport(api, vscode, project, folders, source, destination);

    const metadata = path.join(repository, ...generation.models[0].file.slice(1).split('/').slice(0, -1),
      'maven-metadata-' + generation.models[0].repositoryId + '.xml');
    const original = await fs.readFile(metadata);
    const prepare = async () => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
      return api.java.move.prepareCrossProject(document, vscode.Uri.file(destination));
    };
    const check = plan => {
      assert.equal(plan.move.buildKind, 'maven-reactor');
      assert.equal(plan.move.semantic.afterErrors, 0);
      for (const pin of generation.models) {
        assert.ok(plan.move.buildProof.externalMavenModels.some(model => model.sha256 === pin.sha256 &&
          model.resolvedVersion === pin.resolvedVersion && model.repositoryId === pin.repositoryId));
        assert.ok(plan.warnings.some(warning => warning.includes(pin.artifactId) && warning.includes(pin.resolvedVersion)));
      }
    };
    const stale = await prepare();
    check(stale);
    try {
      await fs.appendFile(metadata, '\n');
      await assert.rejects(api.java.refactoring.apply(stale.id), /origin metadata changed/u);
      assert.ok(await fs.stat(source));
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
      const fresh = await prepare();
      check(fresh);
      assert.equal((await api.java.refactoring.apply(fresh.id)).state, 'applied');
      for (const change of fresh.documents) {
        const address = change.resourceOperation === 'rename' ? change.newUri : change.uri;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(address));
        if (doc.isDirty) assert.equal(await doc.save(), true);
      }
      await assert.rejects(fs.stat(source), { code: 'ENOENT' });
      assert.match(await fs.readFile(destination, 'utf8'), /package fixture\.destination;/u);
      assert.match(await fs.readFile(project.source, 'utf8'), /fixture\.destination\.SnapshotUtility/u);
    } finally { await fs.writeFile(metadata, original); }
    const built = await compileAndQuery(project, tools, database, spring.dbEngine, generation, path.join(root, 'classpath-after.txt'));
    checks.push('Installed Move showed both SNAPSHOT pins, rejected stale Maven metadata and applied a freshly reviewed cross-project utility Move.');
    return { nativeMove: true, eclipseImportOfMavenClasspath: true, pinWarnings: 2, staleMetadataRejected: true,
      refreshedMoveApplied: true, mavenAfterMove: built, jdbc: await jdbcReadback() };
  } finally {
    try {
      if (folders.length) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [],
        folders.map(folder => vscode.Uri.file(folder).toString()));
    } finally {
      try { await remote.close(); }
      finally {
        const current = await fs.realpath(root), stat = await fs.lstat(current, { bigint: true });
        assert.deepEqual([current, path.dirname(current), stat.dev, stat.ino], [root, workspace, identity.dev, identity.ino]);
        assert.match(path.basename(current), /^rb-snapshot-move-/u);
        await fs.rm(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runMavenSnapshotMoveChecks, eclipseProjects, eclipseImport };
