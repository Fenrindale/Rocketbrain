'use strict';

const assert = require('node:assert/strict');
const { fixture, verifyDuckDb } = require('./duckdb-fixture');

async function runDuckDbChecks(api, vscode, checks) {
  const binary = process.env.ROCKETBRAIN_DUCKDB_TEST_BIN;
  assert.ok(binary);
  const commands = await vscode.commands.getCommands(true);
  for (const action of ['open', 'close', 'newQuery', 'browse', 'functions', 'run']) assert.ok(commands.includes('rocketbrain.duckdb.' + action));
  assert.ok((await vscode.languages.getLanguages()).includes('duckdb-sql'));
  const result = await fixture(binary, async file => {
    const proof = await verifyDuckDb(api.duckdb, file);
    await api.duckdb.open(binary, file.database);
    try {
      const uri = await vscode.commands.executeCommand('rocketbrain.duckdb.newQuery');
      assert.equal(vscode.window.activeTextEditor.document.languageId, 'duckdb-sql');
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
      const run = await vscode.commands.executeCommand('rocketbrain.duckdb.run');
      assert.deepEqual(run.rows, [['v' + proof.version]]);
      const document = await vscode.workspace.openTextDocument({ language: 'duckdb-sql', content: 'SELECT list_su' });
      const suggestions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 14));
      assert.ok(suggestions.items.some(item => item.label === 'list_sum' && item.detail.includes('DuckDB')));
      const call = await vscode.workspace.openTextDocument({ language: 'duckdb-sql', content: "SELECT date_diff('day', DATE '2026-11-01', DATE '2026-11-03')" });
      const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', call.uri, new vscode.Position(0, 10));
      assert.ok(hover.some(item => item.contents.some(content => content.value?.includes('date_diff'))));
      return { ...proof, registeredEditor: true, commandResult: true, functionCompletion: true, functionHover: true };
    } finally { await vscode.commands.executeCommand('rocketbrain.duckdb.close'); }
  });
  checks.push('DuckDB independent local read-only fixture, native functions and dialect, editor and results');
  return result;
}

module.exports = { runDuckDbChecks };
