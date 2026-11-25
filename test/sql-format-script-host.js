'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');

function corpus(prefix, dialect) {
  const table = `${prefix}_rows`, trigger = `${prefix}_trigger`, procedure = `${prefix}_populate`, fn = `${prefix}_echo`, event = `${prefix}_event`;
  const commonHead = [
    `CREATE TABLE ${table}(id INT PRIMARY KEY, payload VARCHAR(80) NOT NULL);`,
    'DELIMITER //',
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW BEGIN SET NEW.payload=CONCAT(NEW.payload,'|trg;//'); ` +
      "IF NEW.id > 2 THEN SET NEW.payload=CONCAT(NEW.payload,'|high'); END IF; END//",
    `CREATE FUNCTION ${fn}(x VARCHAR(80)) RETURNS VARCHAR(80) DETERMINISTIC RETURN CONCAT(x,'|fn;$$')//`,
    `CREATE EVENT ${event} ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DISABLE DO BEGIN SET @rb_fmt_event_seen=1; END//`,
    'DELIMITER ~rb~',
    `CREATE PROCEDURE ${procedure}() outer_label:BEGIN DECLARE n INT DEFAULT 0; ` +
      '/* statement body, Korean comment 한국어\nDELIMITER ignored\n*/\n' +
      'step_label: WHILE n < 3 DO SET n=n+1; IF n=2 THEN ITERATE step_label; ' +
      'ELSEIF n>3 THEN LEAVE step_label; ELSE SET @rb_fmt_observed=n; END IF; ' +
      `INSERT INTO ${table}(id,payload) VALUES(n,${fn}(CASE n WHEN 1 THEN 'one;~rb~' ELSE 'three;~rb~' END)); ` +
      'END WHILE step_label; REPEAT SET n=n-1; UNTIL n=1 END REPEAT; CASE n WHEN 1 THEN ' +
      `UPDATE ${table} SET payload=CONCAT(payload,'|case') WHERE id=1; ELSE SET n=5; END CASE; ` +
      'break_label: LOOP LEAVE break_label; END LOOP break_label; END outer_label~rb~',
    'DELIMITER ;',
    `CALL ${procedure}();`
  ];
  if (dialect === 'mariadb') commonHead.push('DELIMITER $$', 'BEGIN NOT ATOMIC IF 1 THEN SELECT 17; END IF; END$$', 'DELIMITER ;');
  const sampleQueries = [
    i => `SELECT ${i},  CONCAT('alpha   beta; //', '한글') AS value FROM dual WHERE 1=1 ORDER BY 1;`,
    i => `SELECT COUNT(*) AS n, ${i} FROM ${table} a LEFT JOIN ${table} b ON a.id=b.id WHERE a.id > 0 HAVING COUNT(*) > 0;`,
    i => `WITH sample AS (SELECT ${i} AS id) SELECT s.id,  'it''s;quoted' FROM sample AS s WHERE s.id >= 0 LIMIT 1;`,
    i => `SELECT ${i}, SUM(id) AS total FROM ${table} WHERE id IN (1,3) GROUP BY payload ORDER BY total ASC,payload ASC;`,
    i => `SELECT /* preserve semi; and DELIMITER $$ */ ${i},  CASE WHEN ${i} % 2 = 0 THEN 2 ELSE 3 END;`
  ];
  const count = dialect === 'mariadb' ? 93 : 94;
  const script = [...commonHead, ...Array.from({ length: count }, (_, i) => sampleQueries[i % sampleQueries.length](i))].join('\n') + '\n';
  return { script, table, trigger, procedure, fn, event };
}

async function queryWithNativeClient(client, config, dialect, text) {
  assert(path.isAbsolute(client) && (dialect === 'mysql' ? /^mysql(?:\.exe)?$/i : /^mariadb(?:\.exe)?$/i).test(path.basename(client)));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-sql-format-client-'));
  const defaults = path.join(root, 'fixture.cnf');
  const lines = { host: config.host, port: config.port, user: config.user, password: config.password, database: config.database };
  try {
    await fs.writeFile(defaults, '[client]\n' + Object.entries(lines).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n',
      { flag: 'wx', mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const args = ['--defaults-file=fixture.cnf', ...(dialect === 'mysql' ? ['--no-login-paths', '--ssl-mode=DISABLED'] : ['--skip-ssl']),
        '--binary-mode', '--comments', '--local-infile=0', '--protocol=TCP', '--default-character-set=utf8mb4', '--batch', '--raw', '--skip-column-names'];
      const child = spawn(client, args, { cwd: root, windowsHide: true, timeout: 15000, shell: false });
      let output = '', errors = '';
      child.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk;
        if (output.length > 200000) child.kill();
      });
      child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(0, 4000); });
      child.stdin.on('error', () => {});
      child.once('error', reject);
      child.once('close', code => {
        if (code === 0 && output.length <= 200000) resolve(output);
        else reject(Error('Owned native SQL fixture client failed: ' + errors.replaceAll(config.password, '[redacted]')));
      });
      child.stdin.end(text);
    });
  } finally {
    await fs.unlink(defaults).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(root);
  }
}

async function verifySqlFormatScript(configPath, client, format) {
  const owner = path.dirname(await fs.realpath(configPath));
  const marker = JSON.parse(await fs.readFile(path.join(owner, 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(marker.kind));
  assert.equal(path.basename(owner), marker.id);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert(config.password);
  const actor = await mysql.createConnection(config);
  const cases = [];
  try {
    const [[server]] = await actor.query('SELECT VERSION() version, @@SESSION.sql_mode sqlMode, @@datadir datadir');
    assert.equal(path.dirname(await fs.realpath(server.datadir)).toLowerCase(), owner.toLowerCase());
    const dialect = /mariadb/i.test(server.version) ? 'mariadb' : 'mysql';
    const options = { dialect, sqlMode: server.sqlMode.split(',').filter(Boolean), indent: '  ' };
    let reference;
    for (const style of ['original', 'expanded', 'compact']) {
      const current = corpus('rb_fmt_' + randomUUID().replaceAll('-', '').slice(0, 10), dialect);
      cases.push(current);
      const keywordCase = style === 'compact' ? 'lower' : 'upper';
      const formatted = style === 'original' ? current.script : await format(current.script, { ...options, style, keywordCase });
      if (style !== 'original') {
        assert.notEqual(formatted, current.script);
        assert.equal(formatted, await format(formatted, { ...options, style, keywordCase }));
        assert.match(formatted, /outer_label:BEGIN\r?\n  DECLARE n INT/i);
        assert.match(formatted, /END WHILE step_label;\r?\n  REPEAT/i);
        assert.ok(formatted.startsWith(keywordCase === 'lower' ? 'create TABLE' : 'CREATE TABLE'));
        assert.match(formatted, /DELIMITER ~rb~\r?\n/);
        assert.ok(formatted.includes('/* statement body, Korean comment 한국어\nDELIMITER ignored\n*/'));
      }
      const output = await queryWithNativeClient(client, config, dialect, formatted);
      const [rows] = await actor.query('SELECT id,payload FROM ' + current.table + ' ORDER BY id');
      assert.deepEqual(rows, [{ id: 1, payload: 'one;~rb~|fn;$$|trg;//|case' }, { id: 3, payload: 'three;~rb~|fn;$$|trg;//|high' }]);
      const [[scheduled]] = await actor.execute('SELECT STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = ?', [current.event]);
      assert.equal(scheduled.STATUS, 'DISABLED');
      if (reference === undefined) reference = output;
      else assert.equal(output, reference);
    }
    return { dialect, serverVersion: server.version, statementsPerStyle: 100, verifiedStyles: ['expanded', 'compact'],
      keywordStyles: ['upper', 'lower'], nativeClient: true, identicalResults: true, idempotent: true,
      proceduralControls: ['if', 'case', 'while', 'repeat', 'loop'], storedKinds: ['procedure', 'function', 'trigger', 'disabled event'],
      anonymousMariaDbBlock: dialect === 'mariadb' };
  } finally {
    try {
      for (const { table, trigger, procedure, fn, event } of cases) {
        await actor.query('DROP EVENT IF EXISTS ' + event);
        await actor.query('DROP TRIGGER IF EXISTS ' + trigger);
        await actor.query('DROP PROCEDURE IF EXISTS ' + procedure);
        await actor.query('DROP FUNCTION IF EXISTS ' + fn);
        await actor.query('DROP TABLE IF EXISTS ' + table);
      }
    } finally { await actor.end(); }
  }
}

function formattingResult(document, edits) {
  const original = document.getText();
  const replacements = edits.map(edit => ({
    start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText
  })).sort((a, b) => a.start - b.start || a.end - b.end);
  let offset = 0, output = '';
  for (const { start, end, text } of replacements) {
    assert.ok(offset <= start && start <= end && end <= original.length, 'Overlapping or invalid SQL formatting edit ranges');
    output += original.slice(offset, start) + text;
    offset = end;
  }
  return output + original.slice(offset);
}

async function runSqlFormatScriptChecks(api, vscode, checks) {
  const client = process.env.ROCKETBRAIN_SQL_FORMAT_TEST_CLIENT;
  if (!client) throw Error('Supply ROCKETBRAIN_SQL_FORMAT_TEST_CLIENT for the disposable fixture engine.');
  const spring = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  const configPath = spring ? (JSON.parse(await fs.readFile(spring, 'utf8'))).dbConfigPath : process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG;
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  await api.connectMysql(config);
  const setting = vscode.workspace.getConfiguration('rocketbrain.sql');
  const previous = setting.inspect('formatting.style')?.workspaceValue;
  const previousCase = setting.inspect('formatting.keywordCase')?.workspaceValue;
  try {
    const evidence = await verifySqlFormatScript(configPath, client, async (source, options) => {
      await setting.update('formatting.style', options.style, vscode.ConfigurationTarget.Workspace);
      await setting.update('formatting.keywordCase', options.keywordCase, vscode.ConfigurationTarget.Workspace);
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: source });
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      editor.options = { tabSize: 2, insertSpaces: true };
      const version = document.version;
      const edits = (await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri,
        { tabSize: 2, insertSpaces: true })) ?? [];
      const expectedText = formattingResult(document, edits);
      let settle;
      const synchronized = new Promise(resolve => { settle = resolve; });
      const subscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document && event.document.version > version) settle(true);
      });
      const timer = setTimeout(() => settle(false), 5000);
      try {
        const changed = await vscode.commands.executeCommand('rocketbrain.sql.format');
        assert.equal(changed, edits.length > 0, 'SQL formatting command and provider must agree on whether an edit is needed');
        if (changed) {
          assert.ok(document.version > version || await synchronized, 'The SQL editor did not observe its formatting edit');
          const canonicalEol = text => text.replaceAll('\r\n', '\n');
          assert.equal(canonicalEol(document.getText()), canonicalEol(expectedText),
            'SQL formatting command must apply the provider text');
        }
        return document.getText();
      } finally {
        clearTimeout(timer);
        subscription.dispose();
      }
    });
    checks.push('SQL Format Document preserved the results of 100 statements per layout through the native database client.');
    return { ...evidence, nativeFormatDocument: true };
  } finally {
    await setting.update('formatting.style', previous, vscode.ConfigurationTarget.Workspace);
    await setting.update('formatting.keywordCase', previousCase, vscode.ConfigurationTarget.Workspace);
    await api.disconnectMysql();
  }
}

module.exports = { runSqlFormatScriptChecks, verifySqlFormatScript };
