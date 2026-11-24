'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const mysql = require('mysql2/promise');

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function springSourceRoot(api, workspace, packageName) {
  await api.java.start();
  const stop = Date.now() + 90000;
  while (Date.now() < stop) {
    const { projects } = await api.java.workbench.refresh();
    const project = projects.find(item => !path.relative(workspace, item.root));
    const root = project?.sourceRoots.find(item => !path.relative(path.join(workspace, 'src/main/java'), item.path) &&
      item.packages.some(pkg => pkg.name === packageName));
    if (project && root) return { project, root };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('JDT did not import the Spring fixture for the scoped relationship check.');
}

async function javaProof(api, runtime, config, sources, classes, schema) {
  const { javaHome } = api.java.getState();
  const exe = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const classpath = (await fs.readFile(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), 'utf8')).trim();
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-scoped-relations-'));
  const proof = path.join(__dirname, 'fixtures/jpa-entity-proof/GeneratedScopedRelationshipProof.java');
  const url = runtime.dbEngine === 'mysql' ? 'jdbc:mysql://127.0.0.1:' + config.port + '/' + config.database
    + '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : 'jdbc:mariadb://127.0.0.1:' + config.port + '/' + config.database;
  const options = { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 55000 };
  try {
    await execFile(exe('javac'), ['-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', directory, proof, ...sources], options);
    const { stdout } = await execFile(exe('java'), ['-cp', directory + path.delimiter + classpath,
      'GeneratedScopedRelationshipProof', ...classes, schema], {
      ...options, env: { ...process.env, RB_GENERATED_ENTITY_JDBC_URL: url,
        RB_GENERATED_ENTITY_JDBC_USER: config.user, RB_GENERATED_ENTITY_JDBC_PASSWORD: config.password }
    });
    assert.match(stdout, /ROCKETBRAIN_JPA_SCOPED_JDBC_OK/);
  } catch (error) {
    throw Error([error.message, error.stdout, error.stderr].filter(Boolean).join('\n').replaceAll(config.password, '[redacted]'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function runJpaScopedRelationshipChecks(api, vscode, checks) {
  const generator = api.jpaScaffold;
  assert.ok(generator && api.relationshipTargetCatalog);
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const ownerDir = path.dirname(runtime.dbConfigPath);
  const marker = await readJson(path.join(ownerDir, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.ok(['localhost', '127.0.0.1'].includes(config.host));
  const crossConfig = process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG;
  assert.ok(crossConfig && !path.relative(path.join(ownerDir, 'cross-schema.json'), crossConfig), 'Use the owned cross-schema fixture.');
  const cross = await readJson(crossConfig);
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  assert.equal(cross.fixtureId, marker.id);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const remoteSchema = cross.schemas[1];
  const pkg = 'fixture.boot';
  const workspace = vscode.workspace.workspaceFolders.find(folder => !path.relative(runtime.projectPath, folder.uri.fsPath)) ?? vscode.workspace.workspaceFolders[0];
  const { project, root } = await springSourceRoot(api, workspace.uri.fsPath, pkg);
  const suffix = randomBytes(5).toString('hex');
  const name = 'RbJpaScopedNode' + suffix, external = 'RbJpaScopedExternal' + suffix;
  const table = 'rb_jpa_scoped_' + suffix, selfFk = 'fk_self_' + suffix, remoteFk = 'fk_remote_' + suffix;
  const tables = [], paths = [], reviews = new Set();
  const actor = await mysql.createConnection(config);
  const q = value => '`' + value + '`';
  const remoteTable = q(remoteSchema) + '.' + q(table);
  const prepare = async name => {
    const preview = await generator.prepare({ table, name, packageName: pkg, projectUri: project.uri, sourceRootId: root.id,
      relationships: requested });
    reviews.add(preview.id);
    return preview;
  };
  const targetPath = path.join(root.path, ...pkg.split('.'), external + '.java');
  const targetSource = `package ${pkg};
import jakarta.persistence.*;

@Entity
@Table(name = "${table}", catalog = "${remoteSchema}")
public class ${external} {
    @Id @Column(name = "id", nullable = false)
    private Long id;

    public ${external}() {}
    public Long getId() { return id; }
}
`;
  const requested = [
    { kind: 'selfReference', foreignKey: selfFk, property: 'parentReference', mode: 'association' },
    { kind: 'crossSchemaAssociation', foreignKey: remoteFk, targetSchema: remoteSchema, targetTable: table,
      targetType: pkg + '.' + external, targetUri: vscode.Uri.file(targetPath).toString(), property: 'remoteReference', mode: 'scalar' }
  ];
  try {
    await actor.query('CREATE TABLE ' + remoteTable + ' (id BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    tables.unshift(remoteTable);
    await actor.query('CREATE TABLE ' + q(table) + ' (id BIGINT NOT NULL PRIMARY KEY, parent_id BIGINT NULL, remote_id BIGINT NULL,' +
      ' CONSTRAINT ' + q(selfFk) + ' FOREIGN KEY(parent_id) REFERENCES ' + q(table) + '(id),' +
      ' CONSTRAINT ' + q(remoteFk) + ' FOREIGN KEY(remote_id) REFERENCES ' + remoteTable + '(id)) ENGINE=InnoDB');
    tables.unshift(q(table));
    await actor.query('INSERT INTO ' + remoteTable + ' VALUES (91)');
    await actor.query('INSERT INTO ' + q(table) + ' VALUES (11,NULL,NULL)');
    await actor.query('INSERT INTO ' + q(table) + ' VALUES (12,11,91)');
    await fs.writeFile(targetPath, targetSource, { flag: 'wx' });
    paths.push(targetPath);
    await api.connectMysql(config);
    await assert.rejects(api.relationshipTargetCatalog({ table, foreignKey: remoteFk, targetSchema: remoteSchema, targetTable: 'other_table' }),
      /no longer proves/);
    const review = await prepare(name);
    assert.deepEqual(review.relationships.map(item => item.kind), ['selfReference', 'crossSchemaAssociation']);
    assert.equal(review.relationships[0].targetType, pkg + '.' + name);
    assert.equal(review.relationships[1].targetSchema, remoteSchema);
    const previewDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(review.uri));
    assert.equal(previewDocument.getText(), review.text);
    const created = await generator.apply(review.id);
    paths.push(created.path);
    assert.equal(await fs.readFile(targetPath, 'utf8'), targetSource);
    assert.equal(await fs.readFile(created.path, 'utf8'), review.text);
    await javaProof(api, runtime, config, paths, [name, external].map(type => pkg + '.' + type), remoteSchema);
    const [rows] = await actor.query('SELECT COUNT(*) AS n FROM ' + q(table));
    assert.equal(Number(rows[0].n), 2);

    const stale = await prepare('RbJpaScopedStaleDb' + suffix);
    await actor.query('ALTER TABLE ' + remoteTable + ' ADD COLUMN new_note VARCHAR(20) NULL');
    await assert.rejects(generator.apply(stale.id), /Relationship metadata changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(stale.fileUri).fsPath), { code: 'ENOENT' });
    const staleSource = await prepare('RbJpaScopedStaleSource' + suffix);
    await fs.appendFile(targetPath, '\n// Changed after preview\n');
    await assert.rejects(generator.apply(staleSource.id), /relationship target Java source changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(staleSource.fileUri).fsPath), { code: 'ENOENT' });
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6500) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('Generated self-reference and explicit cross-schema associations use actual foreign keys. Hibernate reads both and writes through the reviewed self/remote owners, then rolls back.');
    checks.push('The same-named local table is distinguished from the explicitly mapped remote catalog; substituted targets and stale remote metadata/source are rejected.');
    const report = { version: process.env.ROCKETBRAIN_RELEASE_VERSION || '0.36.0', engine: runtime.dbEngine,
      selfReference: true, crossSchemaAssociation: true, qualifiedSameNameTarget: true, readBackBoth: true, writeModes: true, rolledBack: true,
      staleCrossCatalogRejected: true, staleTargetSourceRejected: true, wrongFkTargetRefused: true, isolation };
    const output = path.resolve(__dirname, '../test-output', (process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.36') +
      '-native-jpa-scoped-relationships-' + runtime.dbEngine + '.json');
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    for (const review of reviews) generator.discard(review);
    for (const file of paths) await fs.unlink(file);
    try { for (const name of tables) await actor.query('DROP TABLE ' + name); }
    finally { await actor.end(); await vscode.commands.executeCommand('rocketbrain.useDemo'); }
  }
}

module.exports = { runJpaScopedRelationshipChecks };
