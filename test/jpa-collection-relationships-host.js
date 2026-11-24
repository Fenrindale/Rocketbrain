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
  throw Error('JDT did not import the Spring fixture for the collection relationship check.');
}

async function javaProof(api, runtime, config, sources, classes) {
  const { javaHome } = api.java.getState();
  const exe = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const classpath = (await fs.readFile(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), 'utf8')).trim();
  assert.ok(classpath.includes('hibernate-core') && classpath.includes('jakarta.persistence'));
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-collection-relations-'));
  const proof = path.join(__dirname, 'fixtures/jpa-entity-proof/GeneratedCollectionRelationshipProof.java');
  const url = runtime.dbEngine === 'mysql' ? 'jdbc:mysql://127.0.0.1:' + config.port + '/' + config.database
    + '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : 'jdbc:mariadb://127.0.0.1:' + config.port + '/' + config.database;
  const options = { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 55000 };
  try {
    await execFile(exe('javac'), ['-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', directory, proof, ...sources], options);
    const { stdout } = await execFile(exe('java'), ['-cp', directory + path.delimiter + classpath, 'GeneratedCollectionRelationshipProof', ...classes], {
      ...options, env: { ...process.env, RB_GENERATED_ENTITY_JDBC_URL: url,
        RB_GENERATED_ENTITY_JDBC_USER: config.user, RB_GENERATED_ENTITY_JDBC_PASSWORD: config.password }
    });
    assert.match(stdout, /ROCKETBRAIN_JPA_COLLECTION_JDBC_OK/);
  } catch (error) {
    throw Error([error.message, error.stdout, error.stderr].filter(Boolean).join('\n').replaceAll(config.password, '[redacted]'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function memberSource({ pkg, child, member, owner }) {
  return `package ${pkg};
import jakarta.persistence.*;

@Entity
@Table(name = "${child}")
public class ${member} {
    @Id @Column(name = "id", nullable = false)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "owner_id", referencedColumnName = "id", nullable = false)
    private ${owner} ownerReference;

    public ${member}() {}
    public ${owner} getOwnerReference() { return ownerReference; }
}
`;
}

async function runJpaCollectionRelationshipChecks(api, vscode, checks) {
  const generator = api.jpaScaffold;
  assert.ok(generator);
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const marker = await readJson(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.ok(['localhost', '127.0.0.1'].includes(config.host));
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const pkg = 'fixture.boot';
  const workspace = vscode.workspace.workspaceFolders.find(folder => !path.relative(runtime.projectPath, folder.uri.fsPath)) ?? vscode.workspace.workspaceFolders[0];
  const { project, root } = await springSourceRoot(api, workspace.uri.fsPath, pkg);
  const dir = path.join(root.path, ...pkg.split('.'));
  const suffix = randomBytes(5).toString('hex');
  const [owner, child, tag, join] = ['owner', 'child', 'tag', 'join'].map(name => 'rb_jpa_col_' + name + '_' + suffix);
  const [ownerName, childName, tagName] = ['CollectionOwner', 'CollectionChild', 'CollectionTag'].map(name => 'RbJpa' + name + suffix);
  const [fkChild, fkOwner, fkTag] = ['child', 'owner', 'tag'].map(role => 'fk_col_' + role + '_' + suffix);
  const tables = [], sources = [], reviews = new Set();
  const actor = await mysql.createConnection(config);
  const q = value => '`' + value + '`';

  const prepare = async (table, name, relationships) => {
    const plan = await generator.prepare({ table, name, packageName: pkg, projectUri: project.uri, sourceRootId: root.id, relationships });
    reviews.add(plan.id);
    return plan;
  };
  const apply = async plan => {
    const source = await generator.apply(plan.id);
    sources.push(source.path);
    assert.equal(await fs.readFile(source.path, 'utf8'), plan.text);
    return source.path;
  };
  const writeMember = async (member, owner) => {
    const file = path.join(dir, member + '.java');
    const original = memberSource({ pkg, child, member, owner });
    await fs.writeFile(file, original, { flag: 'wx' });
    sources.push(file);
    return { file, original };
  };
  const inverse = (file, name) => ({ kind: 'inverseOneToMany', foreignKey: fkChild, childTable: child,
    targetType: pkg + '.' + name, targetUri: vscode.Uri.file(file).toString(), mappedBy: 'ownerReference', property: 'members' });
  try {
    await actor.query('CREATE TABLE ' + q(owner) + ' (id BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    tables.unshift(owner);
    await actor.query('CREATE TABLE ' + q(child) + ' (id BIGINT NOT NULL PRIMARY KEY, owner_id BIGINT NOT NULL, CONSTRAINT ' +
      q(fkChild) + ' FOREIGN KEY (owner_id) REFERENCES ' + q(owner) + ' (id)) ENGINE=InnoDB');
    tables.unshift(child);
    await actor.query('CREATE TABLE ' + q(tag) + ' (tag_id BIGINT NOT NULL, tenant_id INT NOT NULL, PRIMARY KEY (tenant_id,tag_id)) ENGINE=InnoDB');
    tables.unshift(tag);
    await actor.query('CREATE TABLE ' + q(join) + ' (owner_id BIGINT NOT NULL, tag_tenant INT NOT NULL, tag_id BIGINT NOT NULL,' +
      ' PRIMARY KEY (owner_id,tag_tenant,tag_id), CONSTRAINT ' + q(fkOwner) + ' FOREIGN KEY (owner_id) REFERENCES ' + q(owner) + ' (id),' +
      ' CONSTRAINT ' + q(fkTag) + ' FOREIGN KEY (tag_tenant,tag_id) REFERENCES ' + q(tag) + ' (tenant_id,tag_id)) ENGINE=InnoDB');
    tables.unshift(join);
    await actor.query('INSERT INTO ' + q(owner) + ' VALUES (71)');
    await actor.query('INSERT INTO ' + q(child) + ' VALUES (1,71),(2,71)');
    await actor.query('INSERT INTO ' + q(tag) + ' VALUES (8100000001,17),(8100000002,18)');
    await actor.query('INSERT INTO ' + q(join) + ' VALUES (71,17,8100000001)');
    await api.connectMysql(config);

    const target = await apply(await prepare(tag, tagName));
    const authored = await writeMember(childName, ownerName);
    const manyToMany = { kind: 'joinTableManyToMany', joinTable: join, ownerForeignKey: fkOwner, targetForeignKey: fkTag,
      targetType: pkg + '.' + tagName, targetUri: vscode.Uri.file(target).toString(), property: 'tags' };
    const review = await prepare(owner, ownerName, [inverse(authored.file, childName), manyToMany]);
    assert.deepEqual(review.relationships.map(item => item.cardinality), ['OneToMany', 'ManyToMany']);
    assert.equal(review.relationships[0].mappedBy, 'ownerReference');
    assert.deepEqual(review.relationships[1].targetColumns.map(item => item.physicalReference), ['tenant_id', 'tag_id']);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(review.uri));
    assert.equal(document.getText(), review.text);
    assert.notEqual(vscode.workspace.fs.isWritableFileSystem(document.uri.scheme), true);
    const after = await apply(review);
    assert.equal(await fs.readFile(authored.file, 'utf8'), authored.original);
    await javaProof(api, runtime, config, [after, authored.file, target], [ownerName, childName, tagName].map(name => pkg + '.' + name));
    const [links] = await actor.query('SELECT COUNT(*) AS n FROM ' + q(join));
    assert.equal(Number(links[0].n), 1);

    const staleOwner = 'RbJpaStaleChildOwner' + suffix;
    const staleChild = 'RbJpaStaleChild' + suffix;
    const anotherChild = await writeMember(staleChild, staleOwner);
    const childReview = await prepare(owner, staleOwner, [inverse(anotherChild.file, staleChild)]);
    await fs.appendFile(anotherChild.file, '\n// Modified after the preview\n');
    await assert.rejects(generator.apply(childReview.id), /relationship target Java source changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(childReview.fileUri).fsPath), { code: 'ENOENT' });
    const joinReview = await prepare(owner, 'RbJpaStaleJoinOwner' + suffix, [manyToMany]);
    await actor.query('ALTER TABLE ' + q(join) + ' ADD COLUMN payload INT NULL');
    await assert.rejects(generator.apply(joinReview.id), /Relationship metadata changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(joinReview.fileUri).fsPath), { code: 'ENOENT' });
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6500) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('Generated inverse @OneToMany resolves the existing child mappedBy owner without editing it. Hibernate reads both directions and adds a many-to-many link using the verified composite FK, then rolls back.');
    checks.push('Changes to the mappedBy source and the join-table column set invalidate the reviewed collection mappings.');
    const report = { version: process.env.ROCKETBRAIN_RELEASE_VERSION || '0.35.0', engine: runtime.dbEngine,
      inverseOneToMany: true, mappedByVerified: true, joinTableManyToMany: true, usedExactForeignKeys: true,
      ownedSourceOnly: true, hibernateReadAndWrite: true, rolledBack: true, staleChildRefused: true, staleJoinTableRefused: true, isolation };
    const output = path.resolve(__dirname, '../test-output', (process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.35') +
      '-native-jpa-collection-relationships-' + runtime.dbEngine + '.json');
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    for (const id of reviews) generator.discard(id);
    for (const file of sources) await fs.unlink(file);
    try { for (const table of tables) await actor.query('DROP TABLE ' + q(table)); }
    finally { await actor.end(); await vscode.commands.executeCommand('rocketbrain.useDemo'); }
  }
}

module.exports = { runJpaCollectionRelationshipChecks };
