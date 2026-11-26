'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { positionOf, until } = require('./helpers/stdio-lsp');

async function runPythonTypeChecks(api, vscode, checks) {
  const [folder] = vscode.workspace.workspaceFolders;
  const root = await fs.realpath(folder.uri.fsPath);
  const moduleName = 'rb_types_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const modelUri = vscode.Uri.file(path.join(root, moduleName + '.py'));
  const sourceUri = vscode.Uri.file(path.join(root, moduleName + '_consumer.py'));
  const model = 'class Row:\n    balance: int\n\n    def __init__(self, balance: int) -> None:\n        self.balance = balance\n\n'
    + 'def compute(row: Row) -> int:\n    return row.balance\n';
  const source = 'from ' + moduleName + ' import Row, compute\nrow = Row(35)\nwrong: str = compute(row)\nrow.ba\n';
  const owned = new Set();
  const isOwned = uri => uri?.scheme === 'file' && [...owned].some(file => path.relative(file, uri.fsPath) === '');
  const remember = async (uri, content) => { await fs.writeFile(uri.fsPath, content, { flag: 'wx' }); owned.add(uri.fsPath); };
  const analysis = api.python.types;
  try {
    await remember(modelUri, model);
    await remember(sourceUri, source);
    const [declaration, consumer] = await Promise.all([vscode.workspace.openTextDocument(modelUri), vscode.workspace.openTextDocument(sourceUri)]);
    await vscode.window.showTextDocument(consumer, { preview: false });
    const result = await vscode.commands.executeCommand('rocketbrain.python.startTypes');
    assert.equal(result?.version, '1.1.414');
    assert.equal(analysis.state()?.state, 'running');
    const diagnostics = () => vscode.languages.getDiagnostics(sourceUri);
    const code = entry => typeof entry.code === 'object' ? entry.code.value : entry.code;
    await until(() => diagnostics().some(item => code(item) === 'reportAssignmentType' && item.range.start.line === 2), 30000);
    const at = (needle, offset) => {
      const located = positionOf(source, needle, offset);
      return new vscode.Position(located.line, located.character);
    };
    const call = at('compute(row)', 2);
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', sourceUri, call);
    assert.ok(hover.some(item => item.contents.some(part => /compute.*-> int/u.test(part.value ?? part))));
    const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', sourceUri, call);
    assert.ok(locations.some(item => path.relative(modelUri.fsPath, (item.targetUri ?? item.uri).fsPath) === ''));
    const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', sourceUri, at('row.ba\n', 6));
    assert.ok(completion.items.some(item => (item.label.label ?? item.label) === 'balance'));
    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', sourceUri, call, 'reviewedTotal');
    assert.equal(rename?.entries().length, 2);
    assert.ok(rename.entries().every(([uri, edits]) => isOwned(uri) && edits.every(edit => edit.newText === 'reviewedTotal')));
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    assert.match(declaration.getText(), /def reviewedTotal\(/u);
    assert.match(consumer.getText(), /reviewedTotal\(row\)/u);
    const correction = new vscode.WorkspaceEdit();
    correction.replace(sourceUri, new vscode.Range(2, 7, 2, 10), 'int');
    assert.equal(await vscode.workspace.applyEdit(correction), true);
    const feedback = () => diagnostics().some(item => code(item) === 'reportAttributeAccessIssue') &&
      diagnostics().every(item => code(item) !== 'reportAssignmentType');
    await until(feedback, 20000);
    assert.equal(await consumer.save(), true);
    assert.equal(await declaration.save(), true);
    checks.push('Installed Pyright diagnostics, typed hover/completion, cross-file definition and native rename use the same opened Python documents.');
    return { pyright: result.version, nativeTypeDiagnostic: true, correctionClearedDiagnostic: true,
      typedHover: true, typedCompletion: true, exactCrossFileDefinition: true, nativeRenameFiles: 2 };
  } finally {
    await analysis.stop();
    for (const document of vscode.workspace.textDocuments.filter(doc => isOwned(doc.uri) && doc.isDirty)) await document.save();
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => isOwned(tab.input?.uri));
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    for (const file of owned) {
      assert.equal(path.relative(root, path.dirname(await fs.realpath(file))), '');
      await fs.unlink(file);
    }
  }
}

module.exports = { runPythonTypeChecks };
