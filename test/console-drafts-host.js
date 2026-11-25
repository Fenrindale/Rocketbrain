'use strict';

const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

const title = 'Owned unexecuted SQL draft';
const sql = "-- 미실행 SQL\r\nSELECT '봄' AS label, DATABASE() AS active_schema;\r\n";
const offsets = [sql.length - 2, sql.indexOf('SELECT')];
const jdbcBaseline = { people: 2, departments: 1, rolledBackNames: 0 };
const hash = value => createHash('sha256').update(value).digest('hex');

async function runtimeConfig() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.deepEqual(await jdbcReadback(), jdbcBaseline);
  return { runtime, config };
}

async function seedConsoleDraft(api, vscode, receipt) {
  const { runtime, config } = await runtimeConfig();
  const profiles = api.dbConnections;
  const saved = await profiles.save({ profile: { id:randomUUID(), name:'Draft test profile', host:config.host, port:config.port,
    user:config.user, database:config.database, tls:{ mode:'disabled' } }, password:config.password });
  const entry = await profiles.openDedicatedConsole({ id:saved.id, revision:saved.revision, password:config.password });
  const editor = vscode.window.activeTextEditor, document = editor.document, before = document.getText();
  assert.equal(document.uri.toString(), entry.uri);
  assert.equal(api.results().length, 0);
  const draft = await api.sqlDrafts.track(editor, title);
  assert.equal(draft.bytes, Buffer.byteLength(before));
  const full = new vscode.Range(document.positionAt(0), document.positionAt(before.length));
  assert.equal(await editor.edit(edit => {
    edit.setEndOfLine(vscode.EndOfLine.CRLF);
    edit.replace(full, sql);
  }), true);
  editor.selection = new vscode.Selection(...offsets.map(offset => document.positionAt(offset)));
  assert.equal(document.getText(), sql);
  assert.equal(document.isDirty, true);
  const updated = await until(() => {
    const snapshot = api.sqlDrafts.list().find(item => item.id === draft.id);
    return snapshot?.revision !== draft.revision && snapshot?.bytes === Buffer.byteLength(sql) ? snapshot : false;
  }, 5000);
  assert.equal(api.results().length, 0);
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString(), before);
  await fs.writeFile(receipt, JSON.stringify({ id:draft.id, revision:updated.revision, hostPid:process.pid, engine:runtime.dbEngine,
    profileId:saved.id, profileRevision:saved.revision, textHash:hash(sql), checkpoints:1 }), { flag:'wx' });
}

async function runConsoleDraftChecks(api, vscode, checks, receipt) {
  const { runtime, config } = await runtimeConfig();
  const seed = JSON.parse(await fs.readFile(receipt, 'utf8'));
  assert.notEqual(seed.hostPid, process.pid);
  assert.equal(seed.engine, runtime.dbEngine);
  assert.deepEqual(api.sessions(), []);
  assert.deepEqual(api.results(), []);
  const actions = await vscode.commands.getCommands(true);
  for (const action of ['track', 'open', 'checkpoint', 'remove']) assert.ok(actions.includes('rocketbrain.sqlDraft.' + action));
  const snapshot = api.sqlDrafts.list().find(item => item.id === seed.id);
  assert.ok(snapshot);
  assert.equal(snapshot.title, title);
  const restored = await api.sqlDrafts.open(seed.id);
  const editor = vscode.window.activeTextEditor, document = editor.document;
  assert.equal(document.uri.toString(), restored);
  assert.equal(hash(document.getText()), seed.textHash);
  assert.equal(document.eol, vscode.EndOfLine.CRLF);
  assert.deepEqual([document.offsetAt(editor.selection.anchor), document.offsetAt(editor.selection.active)], offsets);
  assert.equal(document.isDirty, false);
  assert.equal(api.sqlDrafts.isRecovered(document), true);

  const profiles = api.dbConnections;
  const live = await profiles.openDedicatedConsole({ id:seed.profileId, revision:seed.profileRevision, password:config.password });
  const onlineEditor = vscode.window.activeTextEditor;
  assert.equal(onlineEditor.document.uri.toString(), live.uri);
  await profiles.connect({ id:seed.profileId, password:config.password });
  await vscode.window.showTextDocument(document, { preview:false });
  await assert.rejects(api.describeSqlScript('SELECT 1', { document }), /active database/i);
  assert.equal(await vscode.commands.executeCommand('rocketbrain.runQuery'), undefined);
  assert.deepEqual(api.results(), []);
  assert.equal(api.sessions().length, 1);
  await assert.rejects(api.sqlDrafts.remove(seed.id, snapshot.revision), /Close the open SQL draft/);

  await vscode.window.showTextDocument(onlineEditor.document, { preview:false });
  const starter = onlineEditor.document;
  assert.equal(await onlineEditor.edit(edit => edit.replace(new vscode.Range(starter.positionAt(0), starter.positionAt(starter.getText().length)), sql)), true);
  onlineEditor.selection = new vscode.Selection(starter.positionAt(0), starter.positionAt(starter.getText().length));
  const resultId = await vscode.commands.executeCommand('rocketbrain.runQuery');
  assert.deepEqual(api.results().find(item => item.id === resultId)?.result?.rows, [['봄',config.database]]);
  await api.closeConsoleSession(live.sessionId);
  await profiles.remove({ id:seed.profileId, expectedRevision:seed.profileRevision, disconnect:true });
  const jdbc = await jdbcReadback();
  assert.deepEqual(jdbc, jdbcBaseline);
  checks.push('A previous VS Code process opted in and saved dirty SQL. The new process restored exact SQL, CRLF, and the reversed selection without a connection.');
  checks.push('Saved SQL remained offline even with another real profile open. Only the explicit copy to a dedicated console ran the SELECT.');
  return { engine:runtime.dbEngine, separateHostPid:true, textAndSelection:true, exactCrlf:true, offlineRestored:true,
    explicitCopyRan:true, initiallyUnexecuted:true, autosavedWithoutDocumentSave:true, jdbc };
}

module.exports = { seedConsoleDraft, runConsoleDraftChecks };
