'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');

async function runForeignKeyJoinChecks(api, vscode) {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG, 'utf8'));
  await api.connectMysql(config);
  try {
    await api.sqlAnalysis.refreshMetadata();
    const source = 'SELECT COUNT(*) AS matches FROM rb_spring_person AS p LEFT JOIN rb_spring_dep';
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: source });
    const editor = await vscode.window.showTextDocument(document);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
      document.uri, document.positionAt(source.length));
    const selected = completions.items.find(item => typeof item.insertText === 'string' &&
      item.insertText.includes('`rb_spring_department` ON `p`.`department_id`'));
    assert.ok(selected, 'Expected a completion from the live Spring schema FK.');
    assert.ok(selected.insertText.includes('`rb_spring_department`.`id`'));
    assert.equal(document.getText(selected.range), 'rb_spring_dep');
    assert.equal(await editor.edit(edit => edit.replace(selected.range, selected.insertText)), true);
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    const last = api.results().at(-1);
    assert.equal(last.state, 'done', last.error);
    assert.deepEqual(last.result.columns, ['matches']);
    assert.equal(Number(last.result.rows[0][0]), 2);
    return { acceptedEditorCompletion: true, realResultRowsJoined: 2, liveForeignKey: true };
  } finally {
    await api.disconnectMysql();
  }
}

module.exports = { runForeignKeyJoinChecks };
