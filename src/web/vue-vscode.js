'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { inspectVueProject, selectNode, checkVueProject, vueDefinition, startVueServer, inside } = require('./vue-tools');

const namespace = 'rocketbrain.vue';
const selector = { language: 'vue', scheme: 'file' };

function registerVueWorkbench(context, vscode) {
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-vue');
  const checks = new Map();
  const results = new Map();
  const servers = new Map();
  const pendingStarts = new Map();
  let definitionCount = 0;
  let closing = false;
  let watcher;

  function trusted() {
    if (closing || !vscode.workspace.isTrusted) throw Error('Trust this workspace before using its Vue tools.');
  }

  async function inspect(uri) {
    trusted();
    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== 'file' || !workspace || workspace.uri.scheme !== 'file') throw Error('Open a Vue file in a local workspace.');
    return inspectVueProject(workspace.uri.fsPath, uri.fsPath);
  }

  async function chooseProject() {
    trusted();
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active)) return { uri: active, project: await inspect(active) };
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    const picked = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder =>
      ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'Choose a Vue Project' }))?.folder;
    if (picked) return { uri: picked.uri, project: await inspect(picked.uri) };
  }

  function nodeFor(uri) {
    return selectNode(vscode.workspace.getConfiguration(namespace, uri).get('nodePath'));
  }

  function clear(root) {
    checks.get(root)?.abort();
    results.delete(root);
    renderDiagnostics();
  }

  function handleSourceChange(file) {
    if (!/\.(?:vue|[cm]?[jt]sx?|json)$/i.test(file) || file.split(path.sep).some(name => ['node_modules', '.git', 'dist'].includes(name))) return;
    for (const root of new Set([...checks.keys(), ...results.keys()])) if (inside(root, file)) clear(root);
  }

  function observeProjectSources() {
    if (watcher) return;
    watcher = vscode.workspace.createFileSystemWatcher('**/*.{vue,ts,tsx,js,jsx,mts,cts,mjs,cjs,json}');
    context.subscriptions.push(watcher, watcher.onDidCreate(uri => handleSourceChange(uri.fsPath)),
      watcher.onDidChange(uri => handleSourceChange(uri.fsPath)), watcher.onDidDelete(uri => handleSourceChange(uri.fsPath)));
  }

  function renderDiagnostics() {
    const grouped = new Map();
    const severity = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, message: vscode.DiagnosticSeverity.Information };
    for (const result of results.values()) for (const item of result.diagnostics) {
      if (!grouped.has(item.file)) grouped.set(item.file, []);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(item.line, item.column, item.line, item.column + 1),
        item.message, severity[item.severity]);
      diagnostic.source = 'Vue (vue-tsc)';
      diagnostic.code = item.code;
      grouped.get(item.file).push(diagnostic);
    }
    diagnostics.clear();
    diagnostics.set([...grouped].map(([file, entries]) => [vscode.Uri.file(file), entries]));
  }

  function confirm(title, project, node, detail, action) {
    return vscode.window.showInformationMessage(title, { modal: true,
      detail: [project.root, node, ...detail].join('\n') }, action);
  }

  async function check() {
    const choice = await chooseProject();
    if (!choice) return;
    const { uri, project } = choice;
    if (checks.has(project.root)) throw Error('A check is already running for this Vue project.');
    if (!project.config || !project.installed['vue-tsc']) throw Error('Install vue-tsc and choose a Vue project with a TypeScript configuration.');
    function saved() {
      if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file' && inside(project.root, doc.uri.fsPath))) {
        throw Error('Save changes in the Vue project before checking it.');
      }
    }
    saved();
    const node = await nodeFor(uri);
    const approval = await confirm('Run the installed Vue compiler?', project, node,
      [project.config, 'vue-tsc ' + project.installed['vue-tsc'].version], 'Check Project');
    if (approval !== 'Check Project') return;
    trusted();
    saved();
    if (checks.has(project.root)) return;
    const controller = new AbortController();
    observeProjectSources();
    checks.set(project.root, controller);
    try {
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Vue project',
        cancellable: true }, async (_progress, token) => {
        const abort = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { return await checkVueProject(project, node, { signal: controller.signal }); }
        finally { abort.dispose(); }
      });
      if (controller.signal.aborted) return;
      trusted();
      results.set(project.root, report);
      renderDiagnostics();
      const totals = report.diagnostics.length + report.projectDiagnostics.length;
      if (report.clean) void vscode.window.showInformationMessage('Vue project check passed.');
      else {
        const global = report.projectDiagnostics[0];
        void vscode.window.showWarningMessage(`Vue project check reported ${totals} issues and ${report.skipped} unmapped diagnostics.` +
          (global ? ` ${global.code} ${global.message.slice(0, 250)}` : ''));
      }
      return report;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally { checks.delete(project.root); }
  }

  async function start() {
    const choice = await chooseProject();
    if (!choice) return;
    const { uri, project } = choice;
    if (servers.has(project.root) || pendingStarts.has(project.root)) throw Error('The Vue dev server for this project is already running or starting.');
    if (!project.installed.vite) throw Error('Install Vite in this Vue project before launching it.');
    const node = await nodeFor(uri);
    const approval = await confirm('Launch the workspace Vue dev server?', project, node,
      ['Vite ' + project.installed.vite.version, 'Vite loads the project configuration and plugins.'], 'Start Dev Server');
    if (approval !== 'Start Dev Server') return;
    trusted();
    if (servers.has(project.root) || pendingStarts.has(project.root)) return;
    const controller = new AbortController();
    pendingStarts.set(project.root, controller);
    try {
      const server = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Vue dev server',
        cancellable: true }, async (_progress, token) => {
        const abort = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { return await startVueServer(project, node, { signal: controller.signal }); }
        finally { abort.dispose(); }
      });
      if (controller.signal.aborted || closing || !vscode.workspace.isTrusted) { await server.stop(); return; }
      servers.set(project.root, server);
      void server.closed.then(() => { if (servers.get(project.root) === server) servers.delete(project.root); });
      void vscode.window.showInformationMessage('Vue dev server is serving ' + server.url, 'Open Preview').then(answer => {
        if (answer === 'Open Preview' && servers.get(project.root) === server && vscode.workspace.isTrusted) {
          return vscode.env.openExternal(vscode.Uri.parse(server.url));
        }
      });
      return { url: server.url };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally { pendingStarts.delete(project.root); }
  }

  async function stop() {
    const available = [...servers].map(([root, server]) => ({ label: path.basename(root), description: server.url, server }));
    if (!available.length) { void vscode.window.showInformationMessage('No Rocketbrain Vue dev server is running.'); return; }
    const picked = available.length === 1 ? available[0] : await vscode.window.showQuickPick(available, { title: 'Stop Vue Dev Server' });
    await picked?.server.stop();
  }

  async function disposeWork() {
    for (const controller of [...checks.values(), ...pendingStarts.values()]) controller.abort();
    results.clear();
    if (!closing) diagnostics.clear();
    await Promise.allSettled([...servers.values()].map(server => server.stop()));
  }

  const links = vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position, token) {
      if (closing || !vscode.workspace.isTrusted || token.isCancellationRequested || definitionCount >= 4 ||
          !vscode.workspace.getConfiguration(namespace, document.uri).get('enableDefinitions')) return;
      definitionCount++;
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        const version = document.version;
        const project = await inspect(document.uri);
        const source = document.getText();
        const definition = await vueDefinition(project, await nodeFor(document.uri), {
          file: document.uri.fsPath, source, offset: document.offsetAt(position), signal: controller.signal });
        if (!definition || document.version !== version || controller.signal.aborted || !vscode.workspace.isTrusted) return;
        const sameFile = definition.file === await fs.realpath(document.uri.fsPath);
        const origin = new vscode.Range(document.positionAt(definition.origin.start), document.positionAt(definition.origin.end));
        const target = sameFile ?
          new vscode.Range(document.positionAt(definition.target.start), document.positionAt(definition.target.end)) : new vscode.Range(0, 0, 0, 0);
        return [{ originSelectionRange: origin, targetRange: target, targetSelectionRange: target,
          targetUri: sameFile ? document.uri : vscode.Uri.file(definition.file) }];
      } catch { return; }
      finally { subscription.dispose(); definitionCount--; }
    }
  });

  function register(name, action) {
    return vscode.commands.registerCommand(namespace + '.' + name, async () => {
      try { return await action(); }
      catch (error) { void vscode.window.showErrorMessage('Rocketbrain Vue: ' + error.message); }
    });
  }

  context.subscriptions.push(diagnostics, links,
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && event.document.uri.scheme === 'file') handleSourceChange(event.document.uri.fsPath);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void disposeWork(); }),
    register('checkProject', check), register('startDevServer', start), register('stopDevServer', stop),
    { dispose() { closing = true; void disposeWork(); } });
  return { inspect };
}

module.exports = { registerVueWorkbench };
