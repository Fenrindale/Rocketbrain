'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { mavenBuild, moveClientProof } = require('../src/java/move-builds');
const { lockName } = require('../src/java/maven-external-models');
const { jdbcReadback } = require('./java-source-analysis-host');
const { modelRepository, reactorAt, runMaven, compileAndQuery } = require('./helpers/maven-snapshot-model-fixture');

async function ownedDatabase() {
  const fixture = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { dbEngine: engine, dbConfigPath } = fixture;
  assert.equal(engine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const folder = path.dirname(await fs.realpath(dbConfigPath));
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  const kind = engine === 'mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1';
  assert.deepEqual([owner.id, owner.kind], [path.basename(folder), kind]);
  const database = JSON.parse(await fs.readFile(dbConfigPath, 'utf8'));
  return { database, engine };
}

function acceptedBuild(project, remote, generation) {
  const build = mavenBuild(project.root);
  const proof = moveClientProof(build, 'app', 'core');
  assert.equal(build.kind, 'maven-reactor');
  assert.equal(build.edgeKinds.get('app').get('core'), 'compile');
  assert.ok(proof);
  const contract = build.modelContracts.find(item => item.module === 'app');
  assert.ok(contract.inheritedDependencies.includes('org.springframework:spring-jdbc'));
  assert.ok(contract.managedFields.some(item => item.identity === remote.fixtureGroup + ':core' &&
    item.fields.includes('version') && item.fields.includes('scope')));
  const recorded = new Map(build.externalModels.pins.map(model => [model.coordinate, model]));
  for (const { groupId, artifactId, version, repositoryId, resolvedVersion, sha256 } of generation.models) {
    const coordinate = [groupId, artifactId, version].join(':');
    assert.deepEqual(recorded.get(coordinate), { coordinate, sha256, repositoryId, resolvedVersion });
  }
  assert.ok(!build.files.some(file => build.externalModels.files.includes(file)), 'External evidence cannot become a Move edit target.');
  assert.doesNotThrow(() => build.externalModels.validate());
  return build;
}

async function checkSnapshotModels(directory, tools) {
  const base = await fs.realpath(directory), root = await fs.mkdtemp(path.join(base, 'rb-snapshot-models-'));
  const identity = await fs.lstat(root, { bigint: true });
  const remote = await modelRepository();
  try {
    const repository = await fs.realpath(process.env.ROCKETBRAIN_MAVEN_MODEL_REPO);
    const { database, engine } = await ownedDatabase();
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    const first = remote.publish(1);
    const project = await reactorAt(path.join(root, 'reactor'), remote, repository);
    const lock = path.join(project.root, lockName);
    const pin = (generation, format = 2) => fs.writeFile(lock, JSON.stringify({ version: format,
      models: generation.models.map(({ file, ...fields }) => format === 1 ?
        { groupId: fields.groupId, artifactId: fields.artifactId, version: fields.version, sha256: fields.sha256 } : fields)
    }, null, 2) + '\n');
    const cacheFile = model => path.join(repository, ...model.file.slice(1).split('/'));
    await runMaven(project, tools, ['validate'], ['-U']);
    await project.setOffline(true);
    await pin(first, 1);
    assert.throws(() => mavenBuild(project.root), /literal release coordinates/u);
    await pin(first);
    const firstRequestCount = remote.downloads.length;
    const preview = acceptedBuild(project, remote, first);
    const actualFirst = await compileAndQuery(project, tools, database, engine, first, path.join(root, 'classpath-first.txt'));
    assert.equal(remote.downloads.length, firstRequestCount);
    for (const model of first.models) assert.ok(remote.downloads.includes(model.file));

    const target = first.models[0];
    const trackingFile = path.join(path.dirname(cacheFile(target)), '_remote.repositories');
    const originalTracking = await fs.readFile(trackingFile, 'utf8');
    const metadata = path.join(path.dirname(cacheFile(target)), 'maven-metadata-' + target.repositoryId + '.xml');
    const originalMetadata = await fs.readFile(metadata, 'utf8');
    try {
      await fs.appendFile(trackingFile, '\n' + path.basename(cacheFile(target)) + '>alternate-source=\n');
      assert.throws(() => preview.externalModels.validate(), /origin is unavailable, locally installed or ambiguous/u);
    } finally { await fs.writeFile(trackingFile, originalTracking); }
    try {
      await fs.appendFile(metadata, '\n');
      assert.throws(() => preview.externalModels.validate(), /origin metadata changed/u);
    } finally { await fs.writeFile(metadata, originalMetadata); }
    try {
      await fs.writeFile(metadata, originalMetadata.replace('<value>', '<value></value><value>'));
      assert.throws(() => mavenBuild(project.root), /different timestamped POM/u);
    } finally { await fs.writeFile(metadata, originalMetadata); }
    await project.setOffline(false);
    assert.throws(() => preview.externalModels.validate(), /--offline/u);

    const second = remote.publish(2);
    await runMaven(project, tools, ['validate'], ['-U']);
    await project.setOffline(true);
    assert.throws(() => preview.externalModels.validate(), /different timestamped POM/u);
    assert.throws(() => mavenBuild(project.root), /different timestamped POM/u);
    await pin(second);
    const secondRequestCount = remote.downloads.length;
    const secondReview = acceptedBuild(project, remote, second);
    const actualSecond = await compileAndQuery(project, tools, database, engine, second, path.join(root, 'classpath-second.txt'));
    assert.equal(remote.downloads.length, secondRequestCount);
    for (const model of second.models) assert.ok(remote.downloads.includes(model.file));
    assert.doesNotThrow(() => secondReview.externalModels.validate());
    assert.deepEqual(await jdbcReadback(), jdbc);
    return { engine, maven: '3.9.11', parentAndBom: true, uniqueSnapshotOrigin: true, actualTwoGenerationsDownloaded: true,
      builds: [actualFirst, actualSecond], reviewedVersions: [first.resolvedVersion, second.resolvedVersion],
      offlineMovePlanner: true, staleTimestampedPomsRejected: true, staleOfflineSettingsRejected: true,
      metadataMutationRejected: true, ambiguousCacheOriginRejected: true, duplicateMetadataRejected: true,
      externalFilesUneditable: true, jdbc };
  } finally {
    try { await remote.close(); }
    finally {
      const current = await fs.realpath(root), stat = await fs.lstat(current, { bigint: true });
      assert.deepEqual([current, path.dirname(current), stat.dev, stat.ino], [root, base, identity.dev, identity.ino]);
      assert.match(path.basename(current), /^rb-snapshot-models-/u);
      await fs.rm(current, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    }
  }
}

async function runMavenSnapshotModelChecks(api, vscode, checks) {
  const mavenHome = vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome');
  await api.java.start();
  const javaHome = api.java.getState().javaHome;
  assert.ok(javaHome && mavenHome);
  const result = await checkSnapshotModels(os.tmpdir(), { javaHome, mavenHome });
  checks.push('Maven downloaded two external SNAPSHOT parent and BOM generations; offline Move proof pinned each model and each effective build ran against Spring JDBC.');
  return result;
}

module.exports = { runMavenSnapshotModelChecks };
if (require.main === module) {
  (async () => {
    const { javaHome } = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
    const mavenHome = await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
    return checkSnapshotModels(os.tmpdir(), { javaHome, mavenHome });
  })().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
