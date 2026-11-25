'use strict';

const { randomUUID } = require('node:crypto');
const { settingsIndex, actionsIndex, gitIndex, gitSummary, rankItems } = require('./navigation-index');

const HISTORY_KEY = 'rocketbrain.recentFiles';
const MAX_RECENT_FILES = 30;
const MAX_FILES = 1500;
const MAX_RESULTS = 120;
const EXCLUDED_FILES = '**/{node_modules,.git}/**';

const searchHint = 'Search files, symbols, actions, settings and Git · # symbols · > actions · @ settings · % Git · $ database';

function registerNavigation(vscode, context, { databaseSearch, hasLiveDatabase = () => false } = {}) {
  let disposed = false;
  let recentFiles = readHistory(context.workspaceState.get(HISTORY_KEY, []));
  let historyTask = Promise.resolve();
  const openPickers = new Set();
  const gitReports = new Map();

  function enqueueHistory(task) {
    historyTask = historyTask.catch(() => {}).then(task);
    return historyTask;
  }

  function isWorkspaceFile(uri) {
    return uri && uri.scheme === 'file' && Boolean(vscode.workspace.getWorkspaceFolder(uri));
  }

  async function existingUri(value) {
    try {
      const uri = typeof value === 'string' ? vscode.Uri.parse(value, true) : value;
      if (!isWorkspaceFile(uri)) return undefined;
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.File) !== 0 ? uri : undefined;
    } catch {
      return undefined;
    }
  }

  async function pruneHistory() {
    const uris = await Promise.all(recentFiles.map(existingUri));
    recentFiles = uris.filter(Boolean).map(uri => uri.toString()).slice(0, MAX_RECENT_FILES);
    if (!disposed) await context.workspaceState.update(HISTORY_KEY, recentFiles);
    return uris.filter(Boolean).slice(0, MAX_RECENT_FILES);
  }

  function rememberEditor(editor) {
    const uri = editor && editor.document.uri;
    if (!isWorkspaceFile(uri)) return;
    void enqueueHistory(async () => {
      if (disposed) return;
      const existing = await existingUri(uri);
      if (disposed || !existing) return;
      const value = uri.toString();
      recentFiles = [value, ...recentFiles.filter(entry => entry !== value)].slice(0, MAX_RECENT_FILES);
      await context.workspaceState.update(HISTORY_KEY, recentFiles);
    }).catch(() => {});
  }

  function fileItem(uri) {
    const relativePath = vscode.workspace.asRelativePath(uri, true);
    const name = relativePath.split(/[\\/]/).pop() || relativePath;
    return { type: 'file', label: name, description: relativePath, uri, alwaysShow: true };
  }

  function managePicker(picker, accept) {
    let closed = false;
    const listeners = [];
    const cleanup = [];
    let resolveClosed;
    const finished = new Promise(resolve => { resolveClosed = resolve; });
    const session = {
      get closed() { return closed; },
      finished,
      add: disposable => listeners.push(disposable),
      onClose: callback => cleanup.push(callback),
      close() {
        if (closed) return;
        closed = true;
        openPickers.delete(session);
        for (const callback of cleanup) callback();
        for (const listener of listeners) listener.dispose();
        picker.dispose();
        resolveClosed();
      }
    };
    openPickers.add(session);
    session.add(picker.onDidHide(() => session.close()));
    session.add(picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (!item) return;
      picker.hide();
      void Promise.resolve().then(() => accept(item)).catch(() => {
        void vscode.window.showErrorMessage('Rocketbrain could not open the selected item.');
      });
    }));
    return session;
  }

  async function openItem(item) {
    if (item.type === 'action') {
      const available = actionsIndex(vscode.extensions.all, await vscode.commands.getCommands(true));
      if (!available.some(action => action.command === item.command)) throw Error('The selected action is no longer available.');
      await vscode.commands.executeCommand(item.command);
      return { command: item.command };
    }
    if (item.type === 'setting') {
      if (!/^[\w.-]{1,200}$/.test(item.key)) throw Error('Choose a known setting.');
      await vscode.commands.executeCommand('workbench.action.openSettings', '@id:' + item.key);
      return { setting: item.key };
    }
    if (item.type === 'branch' || item.type === 'commit') {
      const report = await gitSummary(vscode, item);
      const uri = vscode.Uri.from({ scheme: 'rocketbrain-git-search', path: `/${randomUUID()}/Git revision.txt` });
      if (gitReports.size >= 8) gitReports.delete(gitReports.keys().next().value);
      gitReports.set(uri.toString(), report);
      await vscode.window.showTextDocument(uri, { preview: false });
      return { uri: uri.toString(), hash: item.hash };
    }
    if (item.type === 'database') return databaseSearch.open(item.report, item.index);
    await vscode.window.showTextDocument(item.uri, {
      preview: false,
      ...(item.range ? { selection: item.range } : {})
    });
    return { uri: item.uri.toString() };
  }

  function searchSession(lifetime) {
    let settings, actions, git, files;
    return async (input, token) => {
      const value = input.trim();
      const mode = ['#', '>', '@', '%', '$'].includes(value[0]) ? value[0] : '';
      const term = mode ? value.slice(1).trim() : value;
      if (term.length > 200 || token?.isCancellationRequested) return [];

      async function symbols() {
        if (term.length < 2) return [];
        const matches = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', term);
        return (matches ?? []).filter(symbol => symbol.location?.uri).slice(0, MAX_RESULTS).map(symbol => ({
          type: 'symbol', label: symbol.name,
          description: ['Symbol', symbol.containerName, vscode.workspace.asRelativePath(symbol.location.uri, true)].filter(Boolean).join(' · '),
          uri: symbol.location.uri, range: symbol.location.range
        }));
      }

      if (mode === '$') {
        if (term.length < 2 || term.length > 128 || !hasLiveDatabase() || !vscode.workspace.isTrusted) return [];
        const report = await databaseSearch.search({ term, roots: [], includeDdl: false }, token);
        return report.results.slice(0, MAX_RESULTS).map((item, index) => ({ type: 'database', label: item.object.name,
          description: [item.object.kind, item.object.schema, item.object.owner?.name].filter(Boolean).join(' · '), report: report.id, index }));
      }

      const sources = [];
      if (!mode) sources.push(files ??= vscode.workspace.findFiles('**/*', EXCLUDED_FILES, MAX_FILES, lifetime).then(uris => uris.map(fileItem)));
      if (mode === '>' || !mode && term.length >= 2) sources.push(actions ??= vscode.commands.getCommands(true)
        .then(commands => actionsIndex(vscode.extensions.all, commands).filter(item => item.command !== 'rocketbrain.searchEverywhere')));
      if (mode === '@' || !mode && term.length >= 2) sources.push(settings ??= settingsIndex(vscode.extensions.all));
      if (mode === '%' || !mode && term.length >= 2) sources.push(git ??= gitIndex(vscode));
      if (mode === '#' || !mode && term.length >= 2) sources.push(symbols());
      const resolved = await Promise.allSettled(sources);
      if (token?.isCancellationRequested) return [];
      const items = resolved.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      return (mode === '#' ? items : rankItems(items, term)).slice(0, MAX_RESULTS);
    };
  }

  function searchEverywhere() {
    if (disposed) return;
    const picker = vscode.window.createQuickPick();
    picker.title = 'Rocketbrain · Search Everywhere';
    picker.placeholder = searchHint;
    picker.matchOnDescription = true;
    picker.busy = true;
    const session = managePicker(picker, openItem);
    const lifetime = new vscode.CancellationTokenSource();
    const search = searchSession(lifetime.token);
    let cancellation;
    let revision = 0;
    let debounce;
    session.onClose(() => {
      revision += 1;
      clearTimeout(debounce);
      cancellation?.cancel();
      lifetime.cancel();
      lifetime.dispose();
    });

    async function refresh(value, requestedRevision) {
      picker.busy = true;
      picker.placeholder = searchHint;
      const request = new vscode.CancellationTokenSource();
      cancellation = request;
      try {
        const items = await search(value, request.token);
        if (session.closed || requestedRevision !== revision) return;
        picker.items = items.map(item => ({ ...item, alwaysShow: true }));
      } catch {
        if (session.closed || requestedRevision !== revision) return;
        picker.items = [];
        picker.placeholder = 'Search is unavailable. Check the active workspace or database.';
      } finally {
        request.dispose();
        if (cancellation === request) cancellation = undefined;
        if (!session.closed && requestedRevision === revision) picker.busy = false;
      }
    }

    session.add(picker.onDidChangeValue(value => {
      const requestedRevision = ++revision;
      clearTimeout(debounce);
      cancellation?.cancel();
      // Clear old selections immediately so Enter cannot open a result from an earlier query.
      picker.items = [];
      picker.busy = true;
      debounce = setTimeout(() => { void refresh(value, requestedRevision); }, value.trimStart().startsWith('$') ? 240 : 125);
    }));
    picker.show();
    void refresh('', revision);
    return session.finished;
  }

  function showRecentFiles() {
    if (disposed) return;
    const picker = vscode.window.createQuickPick();
    picker.title = 'Rocketbrain · Recent Files';
    picker.placeholder = 'Files opened in this workspace';
    picker.matchOnDescription = true;
    picker.busy = true;
    const session = managePicker(picker, openItem);
    picker.show();
    void enqueueHistory(pruneHistory).then(uris => {
      if (session.closed) return;
      picker.items = uris.map(uri => ({ ...fileItem(uri), alwaysShow: false }));
      if (uris.length === 0) picker.placeholder = 'Open a file in this workspace to add it here.';
      picker.busy = false;
    }).catch(() => {
      if (session.closed) return;
      picker.busy = false;
      picker.placeholder = 'Recent files are currently unavailable.';
    });
    return session.finished;
  }

  void enqueueHistory(pruneHistory).catch(() => {});
  rememberEditor(vscode.window.activeTextEditor);
  const registrations = [
    vscode.workspace.registerTextDocumentContentProvider('rocketbrain-git-search', {
      provideTextDocumentContent: uri => vscode.workspace.isTrusted ? gitReports.get(uri.toString()) ?? 'Search Git again to reopen this revision.'
        : 'Trust this workspace to show Git revision details.'
    }),
    vscode.window.onDidChangeActiveTextEditor(rememberEditor),
    vscode.commands.registerCommand('rocketbrain.searchEverywhere', searchEverywhere),
    vscode.commands.registerCommand('rocketbrain.recentFiles', showRecentFiles),
    vscode.commands.registerCommand('rocketbrain.goToClass', () => vscode.commands.executeCommand('workbench.action.quickOpen', '#'))
  ];

  const subscription = vscode.Disposable.from(...registrations, {
    dispose() {
      disposed = true;
      gitReports.clear();
      for (const session of [...openPickers]) session.close();
    }
  });
  return { search: (query, token) => searchSession(token)(query, token), open: openItem, dispose: () => subscription.dispose() };
}

function readHistory(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(entry => typeof entry === 'string'))].slice(0, MAX_RECENT_FILES);
}

module.exports = { registerNavigation };
