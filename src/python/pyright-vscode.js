'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { workspaceRoots, workspacePath } = require('../java/workbench-model');
const { pyrightLaunch, analysisSettings } = require('./pyright-runtime');

const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
const modeValues = ['basic', 'standard', 'strict'];

function reviewedRename(edit, root, newName) {
  if (!edit) return undefined;
  if (edit.changes && edit.documentChanges) throw Error('Pyright returned conflicting representations of the rename.');
  const documents = edit.documentChanges ?? Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
    textDocument: { uri }, edits
  }));
  if (!Array.isArray(documents) || !documents.length || documents.length > 100) throw Error('Pyright returned an unsupported rename scope.');
  let count = 0;
  for (const item of documents) {
    const uri = item?.textDocument?.uri;
    if (typeof uri !== 'string' || !uri.startsWith('file:') || !Array.isArray(item.edits) || !item.edits.length) {
      throw Error('Pyright rename can edit source text in the reviewed workspace.');
    }
    let physical;
    try { physical = workspacePath(fileURLToPath(uri), [root], { directory: false }); }
    catch { throw Error('Pyright rename would change a file outside the reviewed workspace.'); }
    if (!/\.pyi?$/iu.test(physical) || item.edits.some(change => change.newText !== newName || !change.range)) {
      throw Error('The proposed Pyright rename contains unsupported source changes.');
    }
    count += item.edits.length;
    if (count > 5000) throw Error('Pyright rename exceeds the review limit.');
  }
  return edit;
}

function registerPythonTypes(vscode, onChanged) {
  const output = vscode.window.createOutputChannel('Rocketbrain Python Analysis', { log: true });
  let active, stopped = false, epoch = 0, pending = Promise.resolve();
  const subscriptions = [output];
  const config = uri => vscode.workspace.getConfiguration('rocketbrain.python', uri);

  function serial(action) {
    const task = pending.then(action, action);
    pending = task.catch(() => {});
    return task;
  }

  function trusted() {
    if (stopped || !vscode.workspace.isTrusted) throw Error('Trust this local workspace to start Python type analysis.');
  }

  function contains(document, record = active) {
    if (!record || !vscode.workspace.isTrusted || document?.uri.scheme !== 'file' || document.languageId !== 'python') return false;
    try { return !!workspacePath(document.uri.fsPath, [record.launch.root], { directory: false }); }
    catch { return false; }
  }

  async function release() {
    const old = active;
    active = undefined;
    if (!old) return;
    try { await old.client.stop(5000); }
    finally { old.watcher.dispose(); onChanged(); }
  }

  function stop() {
    epoch += 1;
    return serial(release);
  }

  async function start(folder) {
    const requestedAt = ++epoch;
    return serial(async () => {
      trusted();
      if (requestedAt !== epoch || folder?.uri.scheme !== 'file' || folder.uri.authority) {
        throw Error('Choose a current local workspace folder for Python analysis.');
      }
      const [root] = workspaceRoots([folder]);
      if (active?.ready && path.relative(active.launch.root, root) === '') return active.summary;
      await release();
      const selected = config(folder.uri);
      const mode = selected.get('typeCheckingMode', 'standard');
      if (!modeValues.includes(mode)) throw Error('Choose a supported Python type checking mode.');
      const launch = await pyrightLaunch({ workspace: root, serverHome: selected.get('typeServerHome'),
        nodePath: selected.get('typeNodePath'), python: selected.get('path') });
      trusted();
      if (requestedAt !== epoch) return undefined;
      const scope = { uri: vscode.Uri.file(launch.root), name: folder.name, index: folder.index };
      const settings = analysisSettings(launch.interpreter, mode);
      const { LanguageClient, ErrorAction, CloseAction } = require('vscode-languageclient/node');
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope,
        '**/{*.py,*.pyi,pyrightconfig.json,pyproject.toml}'));
      const record = { launch, watcher, ready: false };
      const bounded = (event, next) => {
        const document = event.document ?? event;
        return contains(document, record) ? next(event) : undefined;
      };
      record.client = new LanguageClient('rocketbrain-python-types', 'Rocketbrain Python Analysis',
        { command: launch.command, args: launch.args, options: launch.options }, {
          workspaceFolder: scope, outputChannel: output, markdown: { isTrusted: false },
          documentSelector: [{ scheme: 'file', language: 'python', pattern: new vscode.RelativePattern(scope, '**/*.{py,pyi}') }],
          synchronize: { fileEvents: watcher },
          middleware: {
            didOpen: bounded, didChange: bounded, didSave: bounded,
            workspace: {
              configuration: params => params.items.map(item => item.section?.split('.')
                .reduce((section, name) => section?.[name], settings) ?? null),
              handleApplyEdit: () => ({ applied: false, failureReason: 'Use the editor action that requested the Python edit.' })
            },
            async provideRenameEdits(document, position, newName, token) {
              if (!record.ready || active !== record || !contains(document, record) || token.isCancellationRequested ||
                  !identifier.test(newName) || newName.length > 128) return undefined;
              const openVersions = new Map(vscode.workspace.textDocuments.map(value => [value.uri.toString(), value.version]));
              const client = record.client;
              const edit = await client.sendRequest('textDocument/rename', {
                textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
                position: client.code2ProtocolConverter.asPosition(position), newName
              }, token);
              if (active !== record || token.isCancellationRequested || vscode.workspace.textDocuments.some(value =>
                contains(value, record) && openVersions.has(value.uri.toString()) && openVersions.get(value.uri.toString()) !== value.version)) {
                return undefined;
              }
              const verified = reviewedRename(edit, launch.root, newName);
              return verified ? client.protocol2CodeConverter.asWorkspaceEdit(verified) : undefined;
            }
          },
          errorHandler: { error: () => ({ action: ErrorAction.Shutdown }), closed: () => {
            if (active === record) {
              active = undefined;
              watcher.dispose();
              onChanged();
            }
            return { action: CloseAction.DoNotRestart };
          } }
        });
      active = record;
      let timer;
      try {
        await Promise.race([record.client.start(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Python type analysis did not start. Check its Output channel.')), 30000);
        })]);
        trusted();
        if (active !== record || requestedAt !== epoch) throw Error('Python type analysis changed during startup.');
        await record.client.sendNotification('workspace/didChangeConfiguration', { settings });
        record.ready = true;
        record.summary = { state: 'running', workspace: scope.uri.toString(), version: launch.version, mode };
        onChanged();
        return record.summary;
      } catch (error) {
        if (active === record) await release();
        throw error;
      } finally { clearTimeout(timer); }
    });
  }

  function command(name, operation) {
    subscriptions.push(vscode.commands.registerCommand('rocketbrain.python.' + name, async () => {
      try { return await operation(); }
      catch (error) { void vscode.window.showErrorMessage(error.message); }
    }));
  }
  command('startTypes', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];
    const result = await start(folder);
    if (result) void vscode.window.showInformationMessage('Python type analysis started for ' + folder.name + '.');
    return result;
  });
  command('stopTypes', stop);
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (active && event.affectsConfiguration('rocketbrain.python')) void stop().catch(error => output.appendLine(error.message));
  }));
  subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (active && !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(active.launch.root))) {
      void stop().catch(error => output.appendLine(error.message));
    }
  }));

  return { start, stop, contains(document) { return active?.ready === true && contains(document); }, state: () => active?.summary,
    dispose() {
      stopped = true;
      void stop().catch(() => {});
      subscriptions.forEach(value => value.dispose());
    }
  };
}

module.exports = { registerPythonTypes, reviewedRename };
