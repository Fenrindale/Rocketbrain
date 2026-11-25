'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { workspacePath, workspaceRoots } = require('../java/workbench-model');
const { localPython, pythonEnvironment } = require('./local-python');
const inspector = require('./python-inspector-source.json');

const debugType = 'rocketbrain-python';
const probe = 'import importlib.util,json,sys;print(json.dumps(dict(version=sys.version.split()[0],venv=sys.prefix!=sys.base_prefix,debug=importlib.util.find_spec("debugpy") is not None)))';

function pythonJson(python, program, input, { signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-X', 'utf8', '-c', program], { signal, cwd, env: pythonEnvironment(),
      timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(Error('The configured Python interpreter could not complete inspection.')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(Error('Python inspection returned invalid JSON.')); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

function inspectPythonSource(python, source, options) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 512 * 1024) throw Error('Inspect Python source up to 512 KiB.');
  return pythonJson(localPython(python), inspector, source, options);
}

function launchArguments(args) {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.includes('\0')) ||
      Buffer.byteLength(args.join('\0')) > 8192) throw Error('Specify up to 64 local Python program arguments.');
  return [...args];
}

function registerPython(vscode) {
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-python');
  const selector = { scheme: 'file', language: 'python' };
  const subscriptions = [diagnostics];
  const running = new Set();
  let disposed = false;
  const config = uri => vscode.workspace.getConfiguration('rocketbrain.python', uri);

  function localContext(folder) {
    if (disposed || !vscode.workspace.isTrusted || folder?.uri.scheme !== 'file') {
      throw Error('Choose a trusted local Python workspace.');
    }
    const [root] = workspaceRoots([folder]);
    return { folder, root, python: localPython(config(folder.uri).get('path')) };
  }

  function target(folder, input = {}) {
    const selected = localContext(folder);
    const active = vscode.window.activeTextEditor?.document.uri;
    const program = input.program || (active?.scheme === 'file' ? active.toString() : '');
    const source = workspacePath(program, [selected.root], { directory: false });
    if (!source.toLowerCase().endsWith('.py')) throw Error('Select a local Python source file in this workspace.');
    const cwd = input.cwd ? workspacePath(input.cwd, [selected.root]) : path.dirname(source);
    return { ...selected, source, cwd, args: launchArguments(input.args) };
  }

  async function inspect(document, cancellation) {
    if (disposed || !vscode.workspace.isTrusted || document.languageId !== 'python' || document.uri.scheme !== 'file') return null;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || !config(folder.uri).get('path')) return null;
    const { python } = localContext(folder);
    const version = document.version;
    const abort = new AbortController();
    const listener = cancellation?.onCancellationRequested?.(() => abort.abort());
    if (cancellation?.isCancellationRequested) abort.abort();
    running.add(abort);
    try {
      const result = await inspectPythonSource(python, document.getText(), { signal: abort.signal });
      if (disposed || !vscode.workspace.isTrusted || document.version !== version || document.isClosed || abort.signal.aborted) return null;
      return result;
    } finally { listener?.dispose(); running.delete(abort); }
  }

  function range([start, end]) {
    return new vscode.Range(new vscode.Position(...start), new vscode.Position(...end));
  }

  function symbol(item, insideClass = false) {
    const classType = item.kind === 'class';
    const kind = classType ? vscode.SymbolKind.Class : insideClass ? vscode.SymbolKind.Method : vscode.SymbolKind.Function;
    const entry = new vscode.DocumentSymbol(item.name, item.kind, kind, range(item.range), range(item.selection));
    entry.children = item.children.map(child => symbol(child, classType));
    return entry;
  }

  async function lint(document) {
    const result = await inspect(document).catch(() => null);
    if (!result) return;
    if (!result.error) { diagnostics.delete(document.uri); return; }
    const start = document.validatePosition(new vscode.Position(...result.error.position));
    const end = document.validatePosition(new vscode.Position(start.line, start.character + 1));
    diagnostics.set(document.uri, [new vscode.Diagnostic(new vscode.Range(start, end), result.error.message, vscode.DiagnosticSeverity.Error)]);
  }

  function launchConfig(folder, input) {
    if (input.request && input.request !== 'launch') throw Error('Use the local Python Launch configuration.');
    const { source, cwd, python, args } = target(folder, input);
    return { type: debugType, request: 'launch', name: input.name || path.basename(source), program: source,
      cwd, python: [python], args, console: input.console === 'integratedTerminal' ? input.console : 'internalConsole',
      stopOnEntry: input.stopOnEntry === true, justMyCode: input.justMyCode !== false, redirectOutput: true, subProcess: false };
  }

  subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    async provideDocumentSymbols(document, token) {
      const result = await inspect(document, token).catch(() => null);
      return result?.symbols.map(item => symbol(item)) || [];
    }
  }));
  subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => void lint(document)));
  subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => void lint(document)));
  subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('rocketbrain.python.path')) return;
    diagnostics.clear();
    vscode.workspace.textDocuments.forEach(document => void lint(document));
  }));

  subscriptions.push(vscode.debug.registerDebugConfigurationProvider(debugType, {
    resolveDebugConfiguration(_folder, input) { return { ...input, type: debugType, request: input.request || 'launch' }; },
    resolveDebugConfigurationWithSubstitutedVariables(folder, input) {
      try { return launchConfig(folder, input); }
      catch (error) { void vscode.window.showErrorMessage(error.message); return undefined; }
    }
  }));
  subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(debugType, {
    async createDebugAdapterDescriptor(session) {
      const interpreter = localContext(session.workspaceFolder).python;
      const state = await pythonJson(interpreter, probe, '');
      if (!state.debug) throw Error('Install debugpy in the selected Python interpreter.');
      return new vscode.DebugAdapterExecutable(interpreter, ['-I', '-m', 'debugpy.adapter'], {
        cwd: session.configuration.cwd, env: pythonEnvironment()
      });
    }
  }));

  function command(name, run) {
    subscriptions.push(vscode.commands.registerCommand(`rocketbrain.python.${name}`, async () => {
      try {
        const doc = vscode.window.activeTextEditor?.document;
        const folder = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) || vscode.workspace.workspaceFolders?.[0];
        return await run(folder);
      } catch (error) { void vscode.window.showErrorMessage(error.message); }
    }));
  }
  command('select', async folder => {
    if (!vscode.workspace.isTrusted || folder?.uri.scheme !== 'file') throw Error('Choose a trusted local Python workspace.');
    const home = folder.uri.fsPath;
    const guesses = ['.venv', 'venv'].map(name => path.join(home, name, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
    const choices = guesses.filter(file => fs.existsSync(file)).map(file => ({ label: path.relative(home, file), file }));
    const chosen = await vscode.window.showQuickPick([...choices, { label: 'Browse for Python interpreter' }], { title: 'Select Python Interpreter' });
    if (!chosen) return;
    const selected = chosen.file || (await vscode.window.showOpenDialog({ canSelectMany: false,
      defaultUri: folder.uri, title: 'Select Python Executable' }))?.[0]?.fsPath;
    if (!selected) return;
    const python = localPython(selected);
    const found = await pythonJson(python, probe, '');
    if (!vscode.workspace.isTrusted) return;
    await config(folder.uri).update('path', python, vscode.ConfigurationTarget.WorkspaceFolder);
    void vscode.window.showInformationMessage('Python ' + found.version + (found.venv ? ' · virtual environment' : ''));
    return found;
  });
  command('run', async folder => {
    const { source, python, cwd } = target(folder);
    const task = new vscode.Task({ type: debugType, id: randomUUID() }, folder, path.basename(source), 'Rocketbrain Python',
      new vscode.ProcessExecution(python, [source], { cwd, env: pythonEnvironment() }), []);
    return vscode.tasks.executeTask(task);
  });
  command('debug', folder => vscode.debug.startDebugging(folder, launchConfig(folder, {})));

  return { inspect, launchConfig, dispose() {
    disposed = true;
    for (const abort of running) abort.abort();
    subscriptions.forEach(item => item.dispose());
  } };
}

module.exports = { registerPython, inspectPythonSource, launchArguments };
