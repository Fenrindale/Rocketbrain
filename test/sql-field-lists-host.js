'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runSqlFieldListChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  const fixture = await mysql.createConnection(config);
  const name = 'rb_field_list_' + randomBytes(5).toString('hex'), table = '`' + name + '`';
  async function proposal(template, title) {
    const offset = template.indexOf('|');
    const content = template.replace('|', '');
    const document = await vscode.workspace.openTextDocument({ language:'sql', content });
    const position = document.positionAt(offset);
    const options = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
    const item = options.items.find(candidate => candidate.label === title);
    assert.ok(item, title);
    assert.ok(item.range.start.isEqual(position) && item.range.end.isEqual(position));
    assert.equal(typeof item.insertText, 'string');
    return { fields:item.insertText, sql:content.slice(0, offset) + item.insertText + content.slice(offset) };
  }
  try {
    await fixture.query('CREATE TABLE ' + table + ' (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(24), ' +
      'nickname VARCHAR(24), name_length INT GENERATED ALWAYS AS (CHAR_LENGTH(name)) STORED)');
    await api.connectMysql(config);
    const insert = await proposal('INSERT INTO ' + table + ' (|) VALUES (?,?)', 'Observed writable INSERT columns');
    assert.equal(insert.fields, '`name`, `nickname`');
    await fixture.beginTransaction();
    try {
      await fixture.execute(insert.sql, ['value', 'observed']);
      const select = await proposal('SELECT | FROM ' + table + ' AS p', 'Visible SELECT columns');
      assert.equal(select.fields, '`p`.`id`, `p`.`name`, `p`.`nickname`, `p`.`name_length`');
      const [[row]] = await fixture.query(select.sql);
      assert.deepEqual([row.name, row.nickname, row.name_length], ['value', 'observed', 5]);
      const group = await proposal('SELECT p.name, COUNT(*) AS total FROM ' + table + ' p GROUP BY |',
        'Projected GROUP BY columns');
      assert.equal(group.fields, '`p`.`name`');
      const [[grouped]] = await fixture.query(group.sql);
      assert.equal(grouped.name, 'value');
      assert.equal(Number(grouped.total), 1);
    } finally { await fixture.rollback(); }
    const [[remaining]] = await fixture.query('SELECT COUNT(*) AS total FROM ' + table);
    assert.equal(Number(remaining.total), 0);
    const state = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(state.ok);
    assert.deepEqual(await state.json(), { people:2, departments:1, rolledBackNames:0 });
    checks.push('The native SQL completion provider inserted SELECT, writable INSERT and projected GROUP BY lists. The server executed all three in a rolled back fixture transaction.');
    return { engine:runtime.dbEngine, selectColumns:4, writableInsertColumns:2, groupingColumns:1, rollback:true };
  } finally {
    try { await api.disconnectMysql(); await fixture.query('DROP TABLE IF EXISTS ' + table); }
    finally { await fixture.end(); }
  }
}

module.exports = { runSqlFieldListChecks };
