'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const vscode = require('vscode');

const root = process.env.RB_DESKTOP_SMOKE_ROOT;
const extensionId = 'rocketbrain-local.rocketbrain';
const configurationName = 'Desktop smoke · Java App';
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { flag: 'wx' });

async function waitFor(action, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const result = await action();
    if (result) return result;
    if (Date.now() >= deadline) throw Error(message);
    await delay(100);
  }
}

exports.activate = async context => {
  try {
    await exercise(context);
  } catch (error) {
    write('driver-error.json', { message: error.message });
    throw error;
  }
};

async function exercise(context) {
  const extension = vscode.extensions.getExtension(extensionId);
  const api = await extension.activate();
  const appRoot = fs.realpathSync(vscode.env.appRoot);
  const extensionRoot = fs.realpathSync(extension.extensionPath);
  const relative = path.relative(path.join(appRoot, 'extensions'), extensionRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Rocketbrain must be bundled in the installed desktop application.');

  const workspace = vscode.workspace.workspaceFolders[0].uri;
  const app = vscode.Uri.joinPath(workspace, 'src/main/java/dev/rocketbrain/App.java');
  const document = await vscode.workspace.openTextDocument(app);
  await vscode.window.showTextDocument(document, { preview: false });
  const call = document.getText().indexOf('greeter.greet') + 'greeter.gr'.length;
  assert.ok(call > 'greeter.gr'.length);
  await waitFor(async () => {
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', app, document.positionAt(call));
    return definitions?.some(hit => (hit.targetUri || hit.uri).path.endsWith('/Greeter.java'));
  }, 75000, 'JDT did not resolve the owned Java fixture.');

  const snapshot = await api.java.workbench.refresh();
  const project = snapshot.projects.find(item => item.tool === 'maven');
  assert.ok(project, 'The Maven fixture was not imported.');
  await api.java.workbench.saveRunConfiguration({
    projectUri: project.uri, mainClass: 'dev.rocketbrain.App', name: configurationName
  });

  const sessionModes = new Map();
  const ended = new Set();
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
    if (session.type === 'rocketbrain-java' && session.name === configurationName) {
      sessionModes.set(session.id, session.configuration.noDebug ? 'run' : 'debug');
    }
  }), vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', {
    createDebugAdapterTracker(session) {
      if (session.name !== configurationName) return;
      return {
        onDidSendMessage(message) {
          if (message.type !== 'event') return;
          const mode = session.configuration.noDebug ? 'run' : 'debug';
          if (mode === 'run' && message.event === 'output' && /Hello Rocketbrain/.test(message.body?.output || '')) {
            if (!fs.existsSync(path.join(root, 'run-output.json'))) write('run-output.json', { mode, greeting: true });
          }
          if (mode === 'debug' && message.event === 'stopped' && message.body?.reason === 'breakpoint') {
            if (!fs.existsSync(path.join(root, 'debug-stopped.json'))) write('debug-stopped.json', { mode, reason: 'breakpoint' });
          }
        }
      };
    }
  }), vscode.debug.onDidTerminateDebugSession(session => {
    const mode = sessionModes.get(session.id);
    if (!mode || ended.has(mode)) return;
    ended.add(mode);
    write(mode + '-ended.json', { mode, requested: true, terminated: true });
  }));

  const breakpointLine = new vscode.Position(document.positionAt(call).line, 0);
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(app, breakpointLine), true);
  vscode.debug.addBreakpoints([breakpoint]);
  const active = await fs.promises.readFile(path.join(root, 'db-connection.json'), 'utf8');
  const sql = JSON.parse(active);
  assert.equal(sql.host, '127.0.0.1');
  assert.equal(sql.database, 'rocketbrain_fixture');
  await api.connectMysql(sql);
  await vscode.window.showTextDocument(document, { preview: false });
  write('ready.json', { vscode: vscode.version, extension: extension.packageJSON.version,
    bundled: true, extensionPath: relative, jdt: api.java.getState().state });
  await waitFor(() => fs.existsSync(path.join(root, 'quit')), 180000, 'The owned desktop test did not finish.');
  vscode.debug.removeBreakpoints([breakpoint]);
  await vscode.commands.executeCommand('workbench.action.quit');
}
