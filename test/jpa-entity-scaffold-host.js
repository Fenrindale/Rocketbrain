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

async function importedProject(api, workspace, packageName) {
  const stop = Date.now() + 90000;
  while (Date.now() < stop) {
    const { projects } = await api.java.workbench.refresh();
    const project = projects.find(item => path.relative(workspace, item.root) === '');
    const root = project?.sourceRoots.find(item => item.packages.some(pkg => pkg.name === packageName) &&
      path.relative(path.join(workspace, 'src/main/java'), item.path) === '');
    if (project && root) return { project, root };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('JDT did not import the live Spring project for entity generation.');
}

async function probe(api, runtime, config, sources, classes, id) {
  const home = api.java.getState().javaHome;
  const exe = name => path.join(home, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const classpath = (await fs.readFile(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), 'utf8')).trim();
  assert.ok(classpath.includes('hibernate-core') && classpath.includes('jakarta.persistence') && classpath.includes('mariadb-java-client'));
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-generated-jpa-'));
  const proof = path.join(__dirname, 'fixtures/jpa-entity-proof/GeneratedJpaProof.java');
  const url = runtime.dbEngine === 'mysql' ? 'jdbc:mysql://127.0.0.1:' + config.port + '/' + config.database
    + '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : 'jdbc:mariadb://127.0.0.1:' + config.port + '/' + config.database;
  const options = { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 45000 };
  try {
    await execFile(exe('javac'), ['-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', directory, proof, ...sources], options);
    const { stdout } = await execFile(exe('java'), ['-cp', directory + path.delimiter + classpath, 'GeneratedJpaProof', ...classes, String(id)], {
      ...options, env: { ...process.env, RB_GENERATED_ENTITY_JDBC_URL: url,
        RB_GENERATED_ENTITY_JDBC_USER: config.user, RB_GENERATED_ENTITY_JDBC_PASSWORD: config.password }
    });
    assert.match(stdout, /ROCKETBRAIN_JPA_ENTITY_READBACK_OK/);
  } catch (error) {
    const message = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
    throw Error(message.replaceAll(config.password, '[redacted]'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function runJpaEntityScaffoldChecks(api, vscode, checks) {
  const generator = api.jpaScaffold;
  assert.ok(generator && (await vscode.commands.getCommands()).includes('rocketbrain.jpa.generateEntity'));
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const marker = await readJson(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.ok(['localhost', '127.0.0.1'].includes(config.host));
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const packageName = 'fixture.boot';
  const workspace = vscode.workspace.workspaceFolders.find(folder => fsMatch(runtime.projectPath, folder.uri.fsPath)) ?? vscode.workspace.workspaceFolders[0];
  await api.java.start();
  const { project, root } = await importedProject(api, workspace.uri.fsPath, packageName);
  const suffix = randomBytes(5).toString('hex');
  const accountTable = 'rb_jpa_account_' + suffix;
  const entryTable = 'rb_jpa_entry_' + suffix;
  const names = ['RbJpaAccount' + suffix, 'RbJpaEntry' + suffix];
  const dir = path.join(root.path, ...packageName.split('.'));
  const ownedJava = new Set(), ownedTables = [], previews = new Set();
  const actor = await mysql.createConnection(config);
  const quote = identifier => '`' + identifier + '`';
  const prepare = async (table, name) => {
    const review = await generator.prepare({ table, name, packageName, projectUri: project.uri, sourceRootId: root.id });
    previews.add(review.id);
    return review;
  };
  try {
    await actor.query('CREATE TABLE ' + quote(accountTable) + ' (' + [
      'id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY', '`order` VARCHAR(50) NOT NULL', 'amount DECIMAL(15,4) NOT NULL',
      'recorded_at DATETIME(6) NOT NULL', 'recorded_on DATE NOT NULL', 'active BIT(1) NOT NULL', 'category CHAR(2) NOT NULL',
      'rating DOUBLE NOT NULL', 'sequence_number SMALLINT NOT NULL', 'nullable_label VARCHAR(20) NULL'
    ].join(', ') + ') ENGINE=InnoDB');
    ownedTables.unshift(accountTable);
    await actor.query('CREATE TABLE ' + quote(entryTable) + ' (entry_id BIGINT NOT NULL, tenant_id INT NOT NULL, ' +
      'account_id BIGINT NOT NULL, PRIMARY KEY (tenant_id, entry_id), FOREIGN KEY (account_id) REFERENCES ' + quote(accountTable) + ' (id)) ENGINE=InnoDB');
    ownedTables.unshift(entryTable);
    const [account] = await actor.execute('INSERT INTO ' + quote(accountTable) + ' (`order`,amount,recorded_at,recorded_on,active,category,rating,sequence_number) ' +
      'VALUES (?, ?, ?, ?, b\'1\', ?, ?, ?)', ['reviewed', '12.3400', '2026-03-15 08:09:10.123456', '2026-03-15', 'GO', 3.25, 10]);
    await actor.execute('INSERT INTO ' + quote(entryTable) + ' (entry_id, tenant_id, account_id) VALUES (?, ?, ?)', [8765432101, 17, account.insertId]);
    await api.connectMysql(config);

    for (const [index, table] of [accountTable, entryTable].entries()) {
      const review = await prepare(table, names[index]);
      assert.deepEqual(review.keyColumns, index === 0 ? ['id'] : ['tenant_id', 'entry_id']);
      assert.equal(review.comparison.mismatches, 0);
      assert.equal(review.comparison.matches, index === 0 ? 10 : 3);
      const proof = await vscode.workspace.openTextDocument(vscode.Uri.parse(review.uri));
      assert.equal(proof.getText(), review.text);
      assert.notEqual(vscode.workspace.fs.isWritableFileSystem(proof.uri.scheme), true);
      await assert.rejects(fs.access(path.join(dir, names[index] + '.java')), { code: 'ENOENT' });
      const created = await generator.apply(review.id);
      ownedJava.add(created.path);
      assert.equal(await fs.readFile(created.path, 'utf8'), review.text);
      await assert.rejects(generator.apply(review.id), /current JPA entity preview/);
    }
    await probe(api, runtime, config, [...ownedJava], names.map(name => packageName + '.' + name), account.insertId);
    checks.push('Catalog-based JPA scaffolding previews and applies reviewed Java source, maps an identity and an ordered composite key, and reads actual IDs and scalar values with Hibernate/JDBC.');

    const staleTable = await prepare(accountTable, 'RbJpaStaleDb' + suffix);
    await actor.query('ALTER TABLE ' + quote(accountTable) + ' ADD COLUMN new_note VARCHAR(30) NULL');
    await assert.rejects(generator.apply(staleTable.id), /database table changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(staleTable.fileUri).fsPath), { code: 'ENOENT' });
    const staleSource = await prepare(entryTable, 'RbJpaStaleSource' + suffix);
    const guardName = 'RbJpaGuard' + suffix;
    const guard = path.join(dir, guardName + '.java');
    await fs.writeFile(guard, 'package ' + packageName + ';\nclass ' + guardName + ' {}\n', { flag: 'wx' });
    ownedJava.add(guard);
    await assert.rejects(generator.apply(staleSource.id), /Java source or project changed/);
    await assert.rejects(fs.access(vscode.Uri.parse(staleSource.fileUri).fsPath), { code: 'ENOENT' });
    const before = await fs.readFile([...ownedJava][0], 'utf8');
    await assert.rejects(prepare(accountTable, names[0]), /already exists|already uses/);
    assert.equal(await fs.readFile([...ownedJava][0], 'utf8'), before);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6000) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('Live-table changes, changed Java package contents and occupied Java names block source creation. The running Spring fixture retained its seed data.');

    const report = { version: process.env.ROCKETBRAIN_RELEASE_VERSION || '0.32.0', engine: runtime.dbEngine,
      actualSpringProject: true, readOnlyJavaPreview: true, exactAppliedSource: true, identity: true, compositeKey: true,
      numericAndTemporalReadback: true, quotedSqlColumn: true, nullableColumn: true, scalarForeignKey: true,
      staleTableRejected: true, stalePackageRejected: true, occupiedTargetPreserved: true, isolation };
    const output = path.join(__dirname, '../test-output', (process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.32') +
      '-native-jpa-entity-scaffold-' + runtime.dbEngine + '.json');
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    for (const id of previews) generator.discard(id);
    for (const file of ownedJava) await fs.unlink(file);
    try {
      for (const table of ownedTables) await actor.query('DROP TABLE ' + quote(table));
    } finally {
      await actor.end();
      await vscode.commands.executeCommand('rocketbrain.useDemo');
    }
  }
}

function fsMatch(left, right) { return path.relative(left, right) === ''; }

module.exports = { runJpaEntityScaffoldChecks };
