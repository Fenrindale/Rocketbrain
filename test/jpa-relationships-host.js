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

async function springProject(api, workspace, packageName) {
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
  throw Error('JDT did not import the Spring fixture for the relationship generation check.');
}

async function javaProof(api, runtime, config, sources, classes, ids) {
  const { javaHome } = api.java.getState();
  const exe = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const classpath = (await fs.readFile(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), 'utf8')).trim();
  assert.ok(classpath.includes('hibernate-core') && classpath.includes('jakarta.persistence'));
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-owning-relations-'));
  const proof = path.join(__dirname, 'fixtures/jpa-entity-proof/GeneratedRelationshipProof.java');
  const url = runtime.dbEngine === 'mysql' ? 'jdbc:mysql://127.0.0.1:' + config.port + '/' + config.database
    + '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : 'jdbc:mariadb://127.0.0.1:' + config.port + '/' + config.database;
  const options = { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 55000 };
  try {
    await execFile(exe('javac'), ['-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', directory, proof, ...sources], options);
    const { stdout } = await execFile(exe('java'), ['-cp', directory + path.delimiter + classpath, 'GeneratedRelationshipProof', ...classes, ...ids.map(String)], {
      ...options, env: { ...process.env, RB_GENERATED_ENTITY_JDBC_URL: url,
        RB_GENERATED_ENTITY_JDBC_USER: config.user, RB_GENERATED_ENTITY_JDBC_PASSWORD: config.password }
    });
    assert.match(stdout, /ROCKETBRAIN_JPA_ASSOCIATION_JDBC_OK/);
  } catch (error) {
    throw Error([error.message, error.stdout, error.stderr].filter(Boolean).join('\n').replaceAll(config.password, '[redacted]'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function runJpaRelationshipChecks(api, vscode, checks) {
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
  const { project, root } = await springProject(api, workspace.uri.fsPath, pkg);
  const suffix = randomBytes(5).toString('hex');
  const names = ['Account', 'Profile', 'Membership'].map(name => 'RbJpa' + name + suffix);
  const [account, profile, membership] = ['account', 'profile', 'membership'].map(name => 'rb_jpa_rel_' + name + '_' + suffix);
  const fkAccount = 'fk_account_' + suffix, fkProfile = 'fk_profile_' + suffix;
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

  try {
    await actor.query('CREATE TABLE ' + q(account) + ' (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB');
    tables.unshift(account);
    await actor.query('CREATE TABLE ' + q(profile) + ' (entry_id BIGINT NOT NULL, tenant_id INT NOT NULL, PRIMARY KEY (tenant_id, entry_id)) ENGINE=InnoDB');
    tables.unshift(profile);
    await actor.query('CREATE TABLE ' + q(membership) + ' (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,' +
      ' account_id BIGINT NULL, profile_tenant_id INT NOT NULL, profile_entry_id BIGINT NOT NULL,' +
      ' KEY ix_profile (profile_tenant_id, profile_entry_id), UNIQUE KEY uq_profile (profile_tenant_id, profile_entry_id),' +
      ' CONSTRAINT ' + q(fkAccount) + ' FOREIGN KEY (account_id) REFERENCES ' + q(account) + ' (id),' +
      ' CONSTRAINT ' + q(fkProfile) + ' FOREIGN KEY (profile_tenant_id, profile_entry_id) REFERENCES ' + q(profile) + ' (tenant_id, entry_id)) ENGINE=InnoDB');
    tables.unshift(membership);
    const [createdAccount] = await actor.query('INSERT INTO ' + q(account) + ' () VALUES ()');
    await actor.query('INSERT INTO ' + q(profile) + ' VALUES (8765432101,17), (8765432102,18)');
    const [createdMembership] = await actor.execute('INSERT INTO ' + q(membership) + ' (account_id, profile_tenant_id, profile_entry_id) VALUES (?, 17, 8765432101)', [createdAccount.insertId]);
    await api.connectMysql(config);
    const accountSource = await apply(await prepare(account, names[0]));
    const profileSource = await apply(await prepare(profile, names[1]));
    const requested = [
      { foreignKey: fkAccount, targetType: pkg + '.' + names[0], targetUri: vscode.Uri.file(accountSource).toString(), property: 'accountReference', mode: 'association' },
      { foreignKey: fkProfile, targetType: pkg + '.' + names[1], targetUri: vscode.Uri.file(profileSource).toString(), property: 'profileReference', mode: 'scalar' }
    ];
    const preview = await prepare(membership, names[2], requested);
    assert.deepEqual(preview.relationships.map(item => item.cardinality), ['ManyToOne', 'OneToOne']);
    assert.deepEqual(preview.relationships[1].columns.map(item => item.physicalReference), ['tenant_id', 'entry_id']);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(preview.uri));
    assert.equal(document.getText(), preview.text);
    assert.match(preview.text, /insertable = false, updatable = false/);
    assert.doesNotMatch(preview.text, /private Long accountId/);
    await apply(preview);
    await javaProof(api, runtime, config, sources, names.map(name => pkg + '.' + name), [createdAccount.insertId, createdMembership.insertId]);
    const [rowCount] = await actor.query('SELECT COUNT(*) AS n FROM ' + q(membership));
    assert.equal(Number(rowCount[0].n), 1);

    const stale = await prepare(membership, 'RbJpaRelationshipStaleDb' + suffix, requested);
    await actor.query('ALTER TABLE ' + q(membership) + ' DROP INDEX uq_profile');
    await assert.rejects(generator.apply(stale.id), /Relationship metadata changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(stale.fileUri).fsPath), { code: 'ENOENT' });
    const sourceStale = await prepare(membership, 'RbJpaRelationshipStaleTarget' + suffix, requested);
    assert.equal(sourceStale.relationships[1].cardinality, 'ManyToOne');
    await fs.appendFile(profileSource, '\n// Changed after preview\n');
    await assert.rejects(generator.apply(sourceStale.id), /relationship target Java source changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(sourceStale.fileUri).fsPath), { code: 'ENOENT' });
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6500) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('Observed foreign keys generate exact owning Jakarta associations. Real Hibernate reads a single-column many-to-one and composite unique one-to-one, writes through the selected sole owner, and rolls back the fixture insert.');
    checks.push('Changing the source unique index or selected Java target after review blocks the write without creating a file.');
    const report = { version: process.env.ROCKETBRAIN_RELEASE_VERSION || '0.34.0', engine: runtime.dbEngine, spring: true,
      nativePreview: true, singleManyToOne: true, orderedCompositeOneToOne: true, provenUnique: true,
      scalarWriteOwner: true, relationshipWriteOwner: true, hibernateReadAndWrite: true, rolledBack: true,
      staleUniqueRejected: true, staleTargetSourceRejected: true, isolation };
    const output = path.resolve(__dirname, '../test-output', (process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.34') +
      '-native-jpa-relationships-' + runtime.dbEngine + '.json');
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    for (const id of reviews) generator.discard(id);
    for (const file of sources) await fs.unlink(file);
    try { for (const table of tables) await actor.query('DROP TABLE ' + q(table)); }
    finally { await actor.end(); await vscode.commands.executeCommand('rocketbrain.useDemo'); }
  }
}

module.exports = { runJpaRelationshipChecks };
