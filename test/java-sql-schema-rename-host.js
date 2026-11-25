'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const exec = promisify(execFile);
const newName = 'display"name';
const quote = value => '`' + value.replaceAll('`', '``') + '`';

function testSource(table, peer) {
  return `import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class RenameQueryCase {
    static String run(JdbcTemplate jdbc) {
        String first = jdbc.queryForObject("""
              SELECT p.label AS value_name FROM ${table} p
              WHERE p.id = ? AND p.label <> 'label' /* label */
              """, String.class, 1);
        String second = jdbc.queryForObject("SELECT p.label FROM " + "${table} p WHERE p.id = ?", String.class, 1);
        String sibling = jdbc.queryForObject("SELECT q.label FROM ${peer} q WHERE q.id = ?", String.class, 1);
        return first + "|" + second + "|" + sibling;
    }

    public static void main(String[] args) {
        var source = new DriverManagerDataSource(System.getenv("RB_RENAME_JDBC_URL"),
            System.getenv("RB_RENAME_JDBC_USER"), System.getenv("RB_RENAME_JDBC_PASSWORD"));
        System.out.println("RB_RENAME " + run(new JdbcTemplate(source)));
    }
}
`;
}

async function executeJava(runtime, config, fileText) {
  const javaRuntime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const temp = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(temp, 'rb-java-sql-compile-'));
  const java = tool => path.join(javaRuntime.javaHome, 'bin', tool + (process.platform === 'win32' ? '.exe' : ''));
  const source = path.join(directory, 'RenameQueryCase.java');
  try {
    const classpath = (await fs.readFile(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), 'utf8')).trim();
    await fs.writeFile(source, fileText, { flag: 'wx' });
    await exec(java('javac'), ['-proc:none', '-cp', classpath, '-d', directory, source], { timeout: 25000, windowsHide: true });
    const vendor = runtime.dbEngine === 'mysql' ? 'mysql' : 'mariadb';
    const output = await exec(java('java'), ['-cp', [directory, classpath].join(path.delimiter), 'RenameQueryCase'],
      { timeout: 25000, windowsHide: true, env: { ...process.env,
        RB_RENAME_JDBC_URL: `jdbc:${vendor}://127.0.0.1:${config.port}/${config.database}`,
        RB_RENAME_JDBC_USER: config.user, RB_RENAME_JDBC_PASSWORD: config.password } })
      .catch(error => { throw Error('The generated query verification failed. ' + String(error.stderr ?? '').slice(0, 2000)); });
    const result = output.stdout.split(/\r?\n/).find(line => line.startsWith('RB_RENAME '));
    assert.equal(result, 'RB_RENAME Alpha|Alpha|Beta');
    return result;
  } finally {
    assert.equal(path.dirname(await fs.realpath(directory)), temp);
    assert.match(path.basename(directory), /^rb-java-sql-compile-/);
    await fs.rm(directory, { recursive: true });
  }
}

async function withJavaSqlSchemaCase(runtime, action) {
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const id = randomBytes(5).toString('hex'), table = 'rb_java_rename_' + id, peer = table + '_peer';
  const changed = { kind: 'column', table, column: 'label', newName };
  const original = testSource(table, peer), expected = original.replaceAll('p.label', 'p.`display\\"name`');
  const columns = async name => (await actor.query('SHOW COLUMNS FROM ' + quote(name)))[0].map(item => item.Field);
  try {
    for (const [name, text] of [[table, 'Alpha'], [peer, 'Beta']]) {
      await actor.query(`CREATE TABLE ${quote(name)} (id BIGINT PRIMARY KEY, label VARCHAR(80) NOT NULL) ENGINE=InnoDB`);
      await actor.execute('INSERT INTO ' + quote(name) + ' VALUES (1,?)', [text]);
    }
    const baseline = await executeJava(runtime, config, original);
    const proof = await action({ actor, config, changed, original, expected, columns, peer });
    assert.deepEqual(await columns(table), ['id', newName]);
    assert.deepEqual(await columns(peer), ['id', 'label']);
    assert.equal(await executeJava(runtime, config, proof.after), baseline);
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    return { engine: runtime.dbEngine, version, sourceEdits: proof.sourceEdits, actualJavaBeforeAfter: true, exactQuoteEncoding: true,
      untouchedSibling: true, ...proof.details, jdbc };
  } finally {
    try { await actor.query('DROP TABLE IF EXISTS ' + [table, peer].map(quote).join(',')); }
    finally { await actor.end(); }
  }
}

async function runJavaSqlSchemaRenameChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(workspace, await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
  return withJavaSqlSchemaCase(runtime, async ({ config, changed, original, expected, columns }) => {
    const directory = await fs.mkdtemp(path.join(workspace, 'rb-java-sql-rename-'));
    const javaRoot = path.join(directory, 'java'), queryRoot = path.join(directory, 'queries');
    await Promise.all([fs.mkdir(javaRoot), fs.mkdir(queryRoot)]);
    const file = path.join(javaRoot, 'RenameQueryCase.java'), query = path.join(queryRoot, 'one.sql');
    await fs.writeFile(file, original, { flag: 'wx' });
    await fs.writeFile(query, `SELECT p.label FROM ${changed.table} p`, { flag: 'wx' });
    const scope = { roots: [queryRoot], javaRoots: [javaRoot] };
    let document;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await api.connectMysql({ ...config, readOnly: true });
      await api.sqlAnalysis.refreshMetadata();
      let plan = await api.schemaRename.preview(changed, { scope, includeEmbeddedJava: false });
      assert.equal(plan.sourcePlanId, undefined);
      assert.match(plan.sourceError, /embedded Java SQL/);
      plan = await api.schemaRename.preview(changed, { scope, includeEmbeddedJava: true });
      assert.ok(plan.sourcePlanId, plan.sourceError);
      const java = plan.sourcePreviews.findIndex(item => item.language === 'java');
      assert.ok(java >= 0);
      const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse(`rocketbrain-schema-review:/${plan.id}/${java}/after.java`));
      assert.equal(preview.getText().replaceAll('\r\n', '\n'), expected);
      assert.equal(await fs.readFile(file, 'utf8'), original);
      assert.deepEqual(await columns(changed.table), ['id', 'label']);

      await vscode.window.showTextDocument(document);
      const change = new vscode.WorkspaceEdit();
      change.insert(document.uri, document.positionAt(document.getText().length), '\n');
      assert.equal(await vscode.workspace.applyEdit(change), true);
      await assert.rejects(api.schemaRename.apply(plan.id, { updateSql: true, allowUnverifiedDependencies: true }), /buffer changed/);
      assert.deepEqual(await columns(changed.table), ['id', 'label']);
      await vscode.commands.executeCommand('undo');
      assert.equal(document.getText().replaceAll('\r\n', '\n'), original);

      plan = await api.schemaRename.preview(changed, { scope, includeEmbeddedJava: true });
      const result = await api.schemaRename.apply(plan.id, { updateSql: true, allowUnverifiedDependencies: true });
      assert.equal(result.verified, true);
      assert.equal(result.sourceState, 'applied', JSON.stringify(result));
      assert.equal(result.atomicAcrossDatabaseAndFiles, false);
      const after = document.getText().replaceAll('\r\n', '\n');
      assert.equal(after, expected);
      assert.equal(await fs.readFile(file, 'utf8'), original);
      const sql = await vscode.workspace.openTextDocument(vscode.Uri.file(query));
      assert.ok(sql.getText().includes(quote(newName)));
      checks.push('The reviewed schema rename updated only the bound Java SQL literal spans and SQL file. A stale Java buffer blocked the DDL. The exact edited Java executed using a live JDBC connection.');
      return { after, sourceEdits: plan.sourceDocuments.find(item => item.language === 'java').edits.length,
        details: { nativeReview: true, staleBufferRefused: true, explicitJavaScope: true, diskPreserved: true, databaseAndSourceSeparate: true } };
    } finally {
      try {
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
          .filter(tab => [file, query].includes(tab.input?.uri?.fsPath));
        // Only owned fixture files may be saved to close their transient editor tabs.
        for (const name of [file, query]) {
          const opened = vscode.workspace.textDocuments.find(item => item.uri.fsPath === name);
          if (opened?.isDirty) await opened.save();
        }
        if (tabs.length) await vscode.window.tabGroups.close(tabs);
        await api.disconnectMysql();
      } finally {
        assert.equal(path.dirname(await fs.realpath(directory)), workspace);
        assert.match(path.basename(directory), /^rb-java-sql-rename-/);
        await fs.rm(directory, { recursive: true, maxRetries: 2, retryDelay: 100 }).catch(error => {
          if (!['EBUSY', 'EPERM'].includes(error.code)) throw error;
        });
      }
    }
  });
}

module.exports = { withJavaSqlSchemaCase, runJavaSqlSchemaRenameChecks };
