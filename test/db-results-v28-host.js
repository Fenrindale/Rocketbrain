'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { inspectXlsx, sheetToImport } = require('../src/db/grid-xlsx');

async function runDbResultsV28Checks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  const actor = await require('mysql2/promise').createConnection({
    ...config, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true
  });
  const tag = randomBytes(5).toString('hex'), source = 'rb_export_source_' + tag, replay = 'rb_export_replay_' + tag;
  const note = "='quoted'\\한국\r\n<img>";
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state');
    assert.ok(response.ok);
    return response.json();
  };
  let connected, sessionId, editor;
  try {
    const isolation = await probe();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    await actor.query('CREATE TABLE ' + source + ' (id BIGINT UNSIGNED PRIMARY KEY, exact_amount DECIMAL(24,8), ' +
      'literal_text VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, options_doc JSON, nullable_text VARCHAR(40), ' +
      'raw_bytes BLOB, flag_bits BIT(5), when_at DATETIME(6), approximate DOUBLE) ENGINE=InnoDB');
    await actor.execute('INSERT INTO ' + source + ' VALUES (?,?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?,?)', [
      '18446744073709551615', '1234567890123456.12345678', note, '{"large":9007199254740993}', null,
      Buffer.from([0, 10, 255]), 21, '2025-11-16 12:34:56.123456', 0.1,
      '9007199254740993', '-12.00000000', '0x00ff', null, '', Buffer.alloc(0), 0, '2025-11-16 01:02:03.000001', -12.25
    ]);
    await api.connectMysql(config);
    connected = true;
    const sql = 'SELECT * FROM ' + source + ' ORDER BY id DESC';
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: sql }));
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    const record = api.results().at(-1);
    sessionId = record?.sessionId;
    assert.equal(record?.state, 'done', record?.error);
    assert.equal(record.result.rowCount, 2);

    const exported = format => api.exportResult(record.id, format).data;
    const json = JSON.parse(exported('json').toString('utf8'));
    assert.deepEqual(json.columns.map(column => column.kind), ['integer', 'decimal', 'text',
      runtime.dbEngine === 'mariadb' ? 'text' : 'json-text', 'text', 'binary-hex', 'bit', 'temporal', 'float']);
    assert.deepEqual(json.rows, record.result.rows);
    assert.equal(json.rows[0][0], '18446744073709551615');
    assert.equal(json.rows[0][1], '1234567890123456.12345678');
    assert.match(json.rows[0][3], /9007199254740993/);
    assert.deepEqual(json.rows.map(row => [row[2], row[4], row[5], row[6]]), [
      [note, null, '0x000aff', '0x15'], ['0x00ff', '', '0x', '0x00']
    ]);

    const workbook = await inspectXlsx(exported('xlsx'));
    const sheet = sheetToImport(workbook, { sheetId: workbook.sheets[0].id, formulaPolicy: 'reject', blankPolicy: 'null' });
    assert.equal(sheet.formulaCount, 0);
    assert.deepEqual(sheet.headers, record.result.columns);
    assert.deepEqual(sheet.rows[0].slice(0, 3), json.rows[0].slice(0, 3));
    assert.deepEqual(sheet.nulls.map(row => row[4]), [true, false]);
    assert.equal(sheet.rows[1][4], '');
    assert.equal(sheet.rows[1][7], '2025-11-16 01:02:03.000001');
    assert.match(exported('csv').toString('utf8'), /"'='quoted'/);

    const copiedSql = api.exportResult(record.id, 'insert', { table: replay }).data.toString('utf8');
    await actor.query('CREATE TEMPORARY TABLE ' + replay + ' LIKE ' + source);
    await actor.query("SET SESSION sql_mode = 'ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES'");
    const statements = copiedSql.split('\n').filter(line => line.startsWith('INSERT '));
    assert.equal(statements.length, 2);
    for (const statement of statements) await actor.query(statement);
    const expected = (await actor.query(sql))[0], actual = (await actor.query('SELECT * FROM ' + replay + ' ORDER BY id DESC'))[0];
    assert.deepEqual(actual, expected);
    assert.throws(() => api.exportResult(record.id, 'insert', { table: replay, columns: ['duplicate', 'duplicate'] }), /one unique destination column/);
    assert.deepEqual(await probe(), isolation);
    checks.push('Native SQL result exports generate CSV, typed JSON, static XLSX and INSERT from the same captured rows. An independent workbook read verifies NULL, empty text, formula-like text and exact decimal/BIGINT; replay into a disposable temporary table matches original server values under NO_BACKSLASH_ESCAPES and ANSI_QUOTES.');
    return { rows: 2, formats: ['csv', 'json', 'xlsx', 'insert'], exactReplay: true, actualWorkbookRead: true, isolation };
  } finally {
    try {
      if (sessionId) await api.closeConsoleSession(sessionId);
      if (editor && vscode.window.activeTextEditor?.document === editor.document) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      if (connected) await vscode.commands.executeCommand('rocketbrain.useDemo');
    } finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + source); }
      finally { await actor.end(); }
    }
  }
}

module.exports = { runDbResultsV28Checks };
