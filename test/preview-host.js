'use strict';
// Shows actual extension commands and real sample SQL for a local Craft Anything capture.
const vscode = require('vscode');
const path = require('node:path');
exports.run = async () => {
  await vscode.extensions.getExtension('rocketbrain-local.rocketbrain').activate();
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Rocketbrain Dark', vscode.ConfigurationTarget.Global);
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const java = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder, 'src/main/java/dev/rocketbrain/CatalogService.java')));
  await vscode.window.showTextDocument(java, { preview: false });
  const sql = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder, 'queries/projects.sql')));
  await vscode.window.showTextDocument(sql, { preview: false });
  await vscode.commands.executeCommand('rocketbrain.runQuery');
  await vscode.commands.executeCommand('workbench.view.extension.rocketbrain');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.window.showTextDocument(sql, { preview: false });
  await new Promise(() => {});
};
