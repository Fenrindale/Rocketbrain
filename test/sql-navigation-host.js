'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { owned } = require('./schema-stored-diff-host');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const springBaseline = { people: 2, departments: 1, rolledBackNames: 0 };

async function verifySqlNavigation(runtime, api, vscode, checks) {
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  let folder;
  const opened = [], previousSessions = new Set(api.sessions().map(row => row.id));
  async function active(uri, message) {
    for (let i = 0; i < 100; i++) {
      if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) return vscode.window.activeTextEditor;
      await delay(50);
    }
    throw Error(message);
  }
  async function open(name, text) {
    const uri = vscode.Uri.file(path.join(folder, name));
    await fs.writeFile(uri.fsPath, text, { flag: 'wx' });
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    opened.push({ document, file: uri.fsPath });
    return editor;
  }
  async function run(editor, start, end, expected) {
    const document = editor.document, view = document.getText();
    editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
    const resultId = await vscode.commands.executeCommand('rocketbrain.runQuery');
    const result = api.results().find(item => item.id === resultId);
    assert.ok(result?.result, result?.error || 'The SQL editor returned no result.');
    assert.equal(result.result.rows[0][0], expected);
    assert.equal(document.getText(), view);
    return { resultId, sessionId: result.sessionId };
  }
  try {
    folder = await fs.mkdtemp(path.join(path.dirname(runtime.dbConfigPath), 'rb-navigation-'));
    await api.connectMysql(config);
    const statement = "SELECT CAST(CONCAT('first:',COUNT(*)) AS CHAR CHARACTER SET utf8mb4) AS result_marker FROM rb_spring_person;";
    const before = "SELECT 'sentinel';\n";
    const first = await open('first.sql', before + statement + "\nSELECT 'tail';\n");
    const firstResult = await run(first, before.length, before.length + statement.length, 'first:2');
    const second = await open('second.sql', "SELECT CAST(CONCAT('second:',COUNT(*)) AS CHAR CHARACTER SET utf8mb4) AS result_marker FROM rb_spring_person;\n");
    const secondResult = await run(second, 5, 5, 'second:2');
    assert.notEqual(firstResult.resultId, secondResult.resultId);
    assert.notEqual(firstResult.sessionId, secondResult.sessionId);
    const distraction = await open('unrelated.txt', 'Retain the active query source from its own result.\n');
    const resultCount = api.results().length;
    const seen = new Set(await vscode.commands.getCommands(true));
    for (const command of ['rocketbrain.focusQueryResults', 'rocketbrain.focusQueryEditor', 'rocketbrain.duckdb.run', 'rocketbrain.jdbc.run', 'rocketbrain.jpa.console.run']) {
      assert.ok(seen.has(command), 'Missing native navigation or language command ' + command);
    }

    await vscode.commands.executeCommand('rocketbrain.focusQueryResults');
    await api.activateResult(firstResult.resultId);
    await vscode.commands.executeCommand('rocketbrain.focusQueryEditor');
    const restored = await active(first.document.uri, 'The result did not return to the first SQL editor.');
    assert.equal(restored.document.offsetAt(restored.selection.start), before.length);
    assert.equal(restored.document.offsetAt(restored.selection.end), before.length + statement.length);
    await vscode.window.showTextDocument(distraction.document, { preview: false });

    await vscode.commands.executeCommand('rocketbrain.focusQueryResults');
    await api.activateResult(secondResult.resultId);
    await vscode.commands.executeCommand('rocketbrain.focusQueryEditor');
    const again = await active(second.document.uri, 'The second result did not return to its SQL editor.');
    assert.ok(again.selection.isEmpty);
    assert.equal(again.document.offsetAt(again.selection.active), 5);
    assert.equal(api.results().length, resultCount);
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springBaseline);
    checks.push('Native SQL commands ran an exact selection and an empty-cursor statement against the real Spring database, then restored each separate result source editor and selection without rerunning SQL.');
    return { engine: runtime.dbEngine, version, exactSelection: true, currentStatement: true, resultSourceRoundTrips: 2,
      separateSessions: true, selectionAndCaretRetained: true, nativeCommands: true, noQueryRerun: true, springIsolation: springBaseline };
  } finally {
    try {
      for (const row of api.sessions()) if (!previousSessions.has(row.id)) await api.closeConsoleSession(row.id);
      await api.disconnectMysql();
      const uris = new Set(opened.map(row => row.document.uri.toString()));
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => uris.has(tab.input?.uri?.toString()));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    } finally {
      try {
        for (const row of opened) await fs.unlink(row.file);
        if (folder) await fs.rmdir(folder);
      } finally { await actor.end(); }
    }
  }
}

async function runSqlNavigationChecks(api, vscode, checks) {
  return verifySqlNavigation(await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG), api, vscode, checks);
}

module.exports = { runSqlNavigationChecks, verifySqlNavigation };
