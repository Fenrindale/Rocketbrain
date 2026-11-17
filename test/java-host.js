'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

async function eventually(action, timeout = 120000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await action(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 700)); }
  throw last || new Error('Timed out waiting for Java language providers.');
}
function positionOf(vscode, text, marker, offset = 0) { const before = text.slice(0, text.indexOf(marker) + offset).split('\n'); return new vscode.Position(before.length - 1, before.at(-1).length); }

async function runJavaChecks(api, vscode, checks) {
  assert.ok(api.java, 'Rocketbrain exports its independent Java controller');
  await api.java.start();
  assert.equal(api.java.getState().state, 'running', api.java.getState().message);
  const uri = vscode.Uri.file(path.join(__dirname, 'fixtures/java/maven/src/main/java/dev/rocketbrain/App.java'));
  const doc = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(doc);
  const text = doc.getText();
  const completion = await eventually(async () => {
    const response = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, positionOf(vscode, text, 'greeter.greet', 'greeter.'.length));
    return response?.items.some(item => String(typeof item.label === 'string' ? item.label : item.label.label).startsWith('greet')) ? response : false;
  });
  assert.ok(completion.items.length);
  const definition = await eventually(async () => {
    const response = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, positionOf(vscode, text, 'greeter.greet', 'greeter.'.length + 1));
    return response?.some(item => (item.uri || item.targetUri)?.path.endsWith('/Greeter.java')) ? response : false;
  });
  assert.ok(definition.length);
  const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', uri, positionOf(vscode, text, 'greeter.greet', 'greeter.'.length + 1), 'welcome');
  assert.ok(rename.entries().some(([file]) => file.path.endsWith('/Greeter.java')));
  const libraryDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, positionOf(vscode, text, 'String[]', 1));
  const libraryUri = libraryDefinitions?.[0]?.uri || libraryDefinitions?.[0]?.targetUri;
  assert.equal(libraryUri?.scheme, 'jdt');
  const library = await vscode.workspace.openTextDocument(libraryUri);
  assert.match(library.getText(), /class String\b/);
  checks.push('Independent JDT LS supplies Java completion, cross-file definition and rename through VS Code language APIs.');
  checks.push('Rocketbrain jdt virtual documents open real JDK library source.');
  const edit = new vscode.WorkspaceEdit(); edit.insert(uri, positionOf(vscode, text, 'System.out.println'), 'int broken = "wrong";\n        ');
  await vscode.workspace.applyEdit(edit);
  try {
    await eventually(() => vscode.languages.getDiagnostics(uri).find(item => item.severity === vscode.DiagnosticSeverity.Error && /(?:String|int|convert|mismatch)/i.test(item.message)));
    checks.push('Independent Java engine publishes a real type error in the editor.');
  } finally {
    const restore = new vscode.WorkspaceEdit(); restore.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); await vscode.workspace.applyEdit(restore);
  }
  const endpoints = await api.java.spring.endpoints();
  assert.ok(endpoints.some(item => item.name === 'GET /api/ping'));
  assert.ok(endpoints.some(item => item.name === 'POST /api/messages'));
  const propsUri = vscode.Uri.file(path.join(__dirname, 'fixtures/java/spring/application.properties'));
  const propsDoc = await vscode.workspace.openTextDocument(propsUri); await vscode.window.showTextDocument(propsDoc);
  const properties = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', propsUri, new vscode.Position(3, 0));
  assert.ok(properties.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'rocketbrain.fixture.greeting'));
  checks.push('Rocketbrain Spring source scanner finds literal endpoints and its settings completion reads local Spring metadata.');
  assert.equal(api.java.getState().springMode, 'local-semantic-index');
  return { javaEngine: api.java.getState(), springEndpoints: endpoints.map(item => item.name), externalJavaExtensionRequired: false, fullSpringSemanticEngine: false };
}

module.exports = { runJavaChecks };
