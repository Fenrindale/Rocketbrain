'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runJavaFxChecks(api, vscode, checks) {
  const [workspace] = vscode.workspace.workspaceFolders || [];
  assert.equal(workspace?.uri.scheme, 'file');
  const projectRoot = fs.mkdtempSync(path.join(workspace.uri.fsPath, 'rb-javafx-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'javafx-app'), projectRoot, { recursive: true });
  const project = vscode.Uri.file(projectRoot);
  await api.java.workbench.resyncProject({ projectUri: project.toString(), allowProjectExecution: true });
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.javafx.build'));
  const uri = (...components) => vscode.Uri.joinPath(project, ...components);
  const document = await vscode.workspace.openTextDocument(uri('src', 'main', 'resources', 'views', 'panel.fxml'));
  const outlines = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
  assert.equal(outlines[0].name, 'Group');
  assert.equal(outlines[0].children[0].children[1].name, 'fx:include');
  assert.equal(outlines[0].children[0].children[0].detail, 'detail');
  const text = document.getText();
  for (const [name, expected] of [['extra.fxml', 'extra.fxml'], ['theme.css', 'theme.css']]) {
    const results = await api.java.fx.definitions(document, document.positionAt(text.indexOf(name)));
    assert.equal(results.length, 1);
    assert.equal(path.basename(results[0].uri.fsPath), expected);
  }
  await api.java.start();
  for (const [needle, name] of [['dev.rocketbrain.fxml.Panel', 'Panel'], ['#recordClick', 'recordClick'], ['"detail"', 'detail']]) {
    const at = document.positionAt(text.indexOf(needle) + 1);
    let result = [];
    for (let attempt = 0; attempt < 20 && !result.length; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1250));
      result = await api.java.fx.definitions(document, at);
    }
    assert.equal(result.length, 1, needle);
    assert.equal((await vscode.workspace.openTextDocument(result[0].uri)).getText(result[0].range), name);
  }
  const task = await api.java.fx.build(project, 'image', { allowProjectExecution: true });
  assert.equal(task.code, 0);
  const image = path.join(projectRoot, 'target', 'rocketbrain-fxml');
  const launcher = path.join(image, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const output = execFileSync(launcher, ['-m', 'dev.rocketbrain.fxml/dev.rocketbrain.fxml.App'], {
    encoding: 'utf8', timeout: 30000, windowsHide: true
  });
  assert.match(output, /ROCKETBRAIN_FXML_OK:detail:extra:1/);
  const springDatabase = await jdbcReadback();
  checks.push('The installed JavaFX workbench navigated Java and resource bindings, then built and ran a modular runtime image.');
  return { outline: true, controller: true, eventHandler: true, injectedField: true, includedResource: true,
    linkedStylesheet: true, javaFxImageRan: true, springDatabase };
}

module.exports = { runJavaFxChecks };
