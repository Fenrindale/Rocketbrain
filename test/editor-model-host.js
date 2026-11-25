'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runEditorModelChecks(api, vscode, checks) {
  const endpoint = process.env.ROCKETBRAIN_LOCAL_MODEL_ENDPOINT;
  const model = process.env.ROCKETBRAIN_LOCAL_MODEL_ID;
  assert.ok(endpoint && model, 'Start the verified owned loopback model fixture before this test.');
  const [folder] = vscode.workspace.workspaceFolders || [];
  assert.equal(folder?.uri.scheme, 'file');
  const file = path.join(folder.uri.fsPath, 'LocalModel_' + randomUUID().replaceAll('-', '') + '.java');
  const initial = 'final class LocalModel { int value() { return 42; } }\n';
  await fs.writeFile(file, initial, { flag: 'wx' });
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const position = document.getText().indexOf('return 42;');
  const range = new vscode.Range(document.positionAt(position), document.positionAt(position + 'return 42;'.length));
  const answer = await api.codeModel.explain(document, range, 'What integer is returned by this Java statement? Reply with the actual number.', { endpoint, model });
  assert.match((await vscode.workspace.openTextDocument(answer.uri)).getText(), /\b42\b/);
  const review = await api.codeModel.prepareEdit(document, range,
    'Replace this Java return statement with return 43; and output only that one Java statement.', { endpoint, model });
  const proposed = await vscode.workspace.openTextDocument(review.after);
  assert.match(proposed.getText(), /\breturn\s+43\s*;/);
  assert.match(document.getText(), /\breturn\s+42\s*;/);
  assert.equal(await fs.readFile(file, 'utf8'), initial);
  assert.equal(await api.codeModel.apply(review.id), true);
  for (let attempt = 0; attempt < 30 && !/\breturn\s+43\s*;/.test(document.getText()); attempt++) await delay(40);
  assert.match(document.getText(), /\breturn\s+43\s*;/);
  await assert.rejects(() => api.codeModel.apply(review.id), /current local model edit/);
  const jdbc = await jdbcReadback();
  checks.push('A real local model explained the selected statement, generated a native diff and applied the reviewed result once.');
  return { explanation: true, nativeDiff: true, unchangedBeforeApproval: true, appliedOnce: true, jdbc };
}

module.exports = { runEditorModelChecks };
