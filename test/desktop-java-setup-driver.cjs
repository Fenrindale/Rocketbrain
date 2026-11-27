'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const vscode = require('vscode');

const root = process.env.RB_JAVA_SETUP_SMOKE_ROOT;
const phase = process.env.RB_JAVA_SETUP_SMOKE_PHASE;
const phaseFile = name => path.join(root, `${phase}-${name}.json`);
const write = (name, value) => fs.writeFileSync(phaseFile(name), JSON.stringify(value), { flag: 'wx' });

exports.activate = async () => {
  try {
    const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
    const api = await extension.activate();
    const extensionPath = path.relative(path.join(vscode.env.appRoot, 'extensions'), extension.extensionPath);
    if (!extensionPath || extensionPath.startsWith('..') || path.isAbsolute(extensionPath)) {
      throw Error('The Java extension is not bundled with this installation.');
    }
    write('activated', { product: vscode.env.appName, extension: extension.packageJSON.version });
    const until = Date.now() + 420000;
    let ready = false;
    while (Date.now() < until && !fs.existsSync(phaseFile('quit'))) {
      if (fs.existsSync(phaseFile('sample')) && !fs.existsSync(phaseFile('database-state'))) {
        write('database-state', api.java.getState());
      }
      const state = api.java.getState();
      if (state.ready && !ready) {
        ready = true;
        const project = vscode.workspace.workspaceFolders[0].uri;
        const app = vscode.Uri.joinPath(project, 'src/main/java/dev/rocketbrain/App.java');
        const document = await vscode.workspace.openTextDocument(app);
        const offset = document.getText().indexOf('greeter.greet') + 'greeter.gr'.length;
        const hits = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', app, document.positionAt(offset));
        write('ready', { state, definition: hits?.some(hit => (hit.targetUri || hit.uri).path.endsWith('/Greeter.java')) });
      }
      await delay(125);
    }
    await vscode.commands.executeCommand('workbench.action.quit');
  } catch (error) {
    write('error', { message: error.message });
    throw error;
  }
};
