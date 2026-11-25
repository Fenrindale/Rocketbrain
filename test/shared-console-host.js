'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runSharedConsoleChecks(api, vscode, checks) {
  const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const table = 'rb_shared_' + randomBytes(5).toString('hex');
  const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, table + '.sql');
  const actor = await mysql.createConnection(config);
  const logging = api.activityLog.snapshot().enabled;
  let createdFile;
  const query = async (document, sql, fromDisk = false) => {
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const content = document.getText();
    if (!fromDisk && content !== sql) assert.equal(await editor.edit(edit => {
      edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(content.length)), sql);
    }), true);
    const start = document.positionAt(0);
    const end = document.positionAt(document.getText().length);
    editor.selection = new vscode.Selection(start, end);
    const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
    const result = api.results().find(item => item.id === id);
    assert.ok(result?.result, result?.error || `No SQL result for ${table}`);
    return result;
  };
  const getLabel = 'SELECT label FROM ' + table + ' WHERE id=1;';
  const update = value => `UPDATE ${table} SET label='${value}' WHERE id=1;`;
  const jdbcBaseline = { people: 2, departments: 1, rolledBackNames: 0 };
  try {
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY,label VARCHAR(20) NOT NULL) ENGINE=InnoDB');
    await actor.query(`INSERT INTO ${table} VALUES (1,'original')`);
    await api.activityLog.setEnabled(true);
    await api.connectMysql(config);
    assert.deepEqual(await jdbcReadback(), jdbcBaseline);
    await fs.writeFile(filename, getLabel, { flag: 'wx' });
    createdFile = true;
    const source = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    const first = await query(source, getLabel, true);
    const id = first.sessionId;
    const originalConnection = api.sessionState().connectionId;
    assert.ok(originalConnection);
    assert.deepEqual(first.result.rows, [['original']]);

    const other = await vscode.workspace.openTextDocument({ language: 'sql', content: getLabel });
    const dedicated = await query(other, getLabel);
    assert.notEqual(dedicated.sessionId, id);
    assert.notEqual(api.sessionState().connectionId, originalConnection);
    await vscode.window.showTextDocument(source);
    const shared = (await vscode.commands.executeCommand('rocketbrain.openSharedConsole')).document;
    assert.notEqual(shared.uri.toString(), source.uri.toString());
    const sameConnection = await query(shared, 'SELECT CONNECTION_ID();');
    assert.equal(sameConnection.sessionId, id);
    assert.equal(String(sameConnection.result.rows[0][0]), String(originalConnection));
    assert.equal(api.sessions().filter(item => item.id === id).length, 1);
    assert.equal(api.sessions().find(item => item.id === id).openEditors, 2);

    await api.configureConsoleSession(id, { readOnly: false, autocommit: false });
    await vscode.commands.executeCommand('rocketbrain.beginTransaction');
    await query(shared, update('committed'));
    const pending = await query(source, getLabel, true);
    assert.deepEqual(pending.result.rows, [['committed']]);
    assert.equal(api.sessionState().readOnly, false);
    assert.deepEqual((await query(other, getLabel)).result.rows, [['original']]);
    assert.ok((await api.databaseCatalog()).tables.some(item => item.name === table));
    const { entries } = api.activityLog.snapshot();
    const metadata = new Set(entries.filter(item => item.category === 'metadata').map(item => item.session));
    const consoles = new Set(entries.filter(item => item.category === 'query').map(item => item.session));
    assert.ok(metadata.size);
    assert.equal(consoles.size, 2);
    for (const metadataId of metadata) assert.ok(!consoles.has(metadataId));
    await vscode.window.showTextDocument(source);
    await vscode.commands.executeCommand('rocketbrain.commit');
    assert.deepEqual((await query(other, getLabel)).result.rows, [['committed']]);

    await vscode.window.showTextDocument(source);
    await vscode.commands.executeCommand('rocketbrain.beginTransaction');
    const sourceTab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(tab => tab.input?.uri?.toString() === source.uri.toString());
    assert.ok(sourceTab);
    assert.equal(await vscode.window.tabGroups.close(sourceTab), true);
    for (let n = 0; n < 30 && api.sessions().find(item => item.id === id).openEditors > 1; n++) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(api.sessions().find(item => item.id === id).openEditors, 1);
    assert.equal(api.sessions().find(item => item.id === id).inTransaction, true);
    await query(shared, update('rolled-back'));
    assert.deepEqual((await query(shared, getLabel)).result.rows, [['rolled-back']]);
    await vscode.commands.executeCommand('rocketbrain.rollback');
    assert.deepEqual((await query(other, getLabel)).result.rows, [['committed']]);

    await api.closeConsoleSession(id);
    assert.ok(!api.sessions().some(item => item.id === id));
    await assert.rejects(api.controlConsoleSession(id, 'commit'), /existing console/);
    const reopened = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    const resetSource = await query(reopened, getLabel, true);
    const resetShared = await query(shared, getLabel);
    assert.notEqual(resetSource.sessionId, resetShared.sessionId);
    assert.ok(api.sessions().filter(item => [resetSource.sessionId, resetShared.sessionId].includes(item.id))
      .every(item => item.readOnly && item.editorCount === 1));
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, jdbcBaseline);
    checks.push('The installed shared SQL console reused the physical connection and transaction while independent SQL and metadata kept their own sessions.');
    return { engine: runtime.dbEngine, samePhysicalConnection: true, transactionShared: true, dedicatedIsolation: true,
      metadataSeparation: true, commitFromSibling: true, rollbackFromSibling: true, editorCloseRetained: true,
      allBindingsDetached: true, jdbc };
  } finally {
    try {
      for (const session of api.sessions()) await api.closeConsoleSession(session.id);
      await api.disconnectMysql();
      await api.activityLog.setEnabled(logging);
    } finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + table); }
      finally {
        await actor.end();
        if (createdFile) await fs.unlink(filename);
      }
    }
  }
}

module.exports = { runSharedConsoleChecks };
