'use strict';

const HISTORY_KEY = 'rocketbrain.recentFiles';
const MAX_RECENT_FILES = 30;
const MAX_FILES = 1500;
const MAX_RESULTS = 120;
const EXCLUDED_FILES = '**/{node_modules,.git}/**';

function registerNavigation(vscode, context) {
  let disposed = false;
  let recentFiles = readHistory(context.workspaceState.get(HISTORY_KEY, []));
  let historyTask = Promise.resolve();
  const openPickers = new Set();

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
    return { label: name, description: relativePath, uri, alwaysShow: true };
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
    await vscode.window.showTextDocument(item.uri, {
      preview: false,
      ...(item.range ? { selection: item.range } : {})
    });
  }

  function searchEverywhere() {
    if (disposed) return;
    const picker = vscode.window.createQuickPick();
    picker.title = 'Rocketbrain · Search Everywhere';
    const placeholder = 'Search files · # workspace symbols · > commands';
    picker.placeholder = placeholder;
    picker.matchOnDescription = true;
    picker.busy = true;
    const session = managePicker(picker, openItem);
    const cancellation = new vscode.CancellationTokenSource();
    let revision = 0;
    let debounce;
    let fileError = false;
    const files = vscode.workspace.findFiles('**/*', EXCLUDED_FILES, MAX_FILES, cancellation.token)
      .then(uris => uris.map(fileItem))
      .catch(() => { fileError = true; return []; });

    session.onClose(() => {
      revision += 1;
      clearTimeout(debounce);
      cancellation.cancel();
      cancellation.dispose();
    });

    async function refresh(value, requestedRevision) {
      picker.busy = true;
      picker.placeholder = placeholder;
      try {
        let items;
        if (value.startsWith('#')) {
          const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', value.slice(1).trim());
          items = (symbols || [])
            .filter(symbol => symbol.location && symbol.location.uri)
            .slice(0, MAX_RESULTS)
            .map(symbol => ({
              label: symbol.name,
              description: [symbol.containerName, vscode.workspace.asRelativePath(symbol.location.uri, true)].filter(Boolean).join(' · '),
              uri: symbol.location.uri,
              range: symbol.location.range,
              alwaysShow: true
            }));
        } else {
          const allFiles = await files;
          items = rankFiles(allFiles, value.trim()).slice(0, MAX_RESULTS);
        }
        if (session.closed || requestedRevision !== revision) return;
        picker.items = items;
        if (fileError && !value.startsWith('#')) {
          picker.placeholder = 'Unable to list workspace files · # workspace symbols · > commands';
        }
      } catch {
        if (session.closed || requestedRevision !== revision) return;
        picker.items = [];
        picker.placeholder = 'Workspace symbols are unavailable. Check that a language extension is ready.';
      } finally {
        if (!session.closed && requestedRevision === revision) picker.busy = false;
      }
    }

    session.add(picker.onDidChangeValue(value => {
      const requestedRevision = ++revision;
      clearTimeout(debounce);
      if (value.trimStart().startsWith('>')) {
        picker.hide();
        void vscode.commands.executeCommand('workbench.action.showCommands').then(undefined, () => {
          void vscode.window.showErrorMessage('Rocketbrain could not open the command palette.');
        });
        return;
      }
      // Clear old selections immediately so Enter cannot open a result from an earlier query.
      picker.items = [];
      picker.busy = true;
      debounce = setTimeout(() => { void refresh(value, requestedRevision); }, value.startsWith('#') ? 140 : 30);
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
    vscode.window.onDidChangeActiveTextEditor(rememberEditor),
    vscode.commands.registerCommand('rocketbrain.searchEverywhere', searchEverywhere),
    vscode.commands.registerCommand('rocketbrain.recentFiles', showRecentFiles),
    vscode.commands.registerCommand('rocketbrain.goToClass', () => vscode.commands.executeCommand('workbench.action.quickOpen', '#'))
  ];

  return vscode.Disposable.from(...registrations, {
    dispose() {
      disposed = true;
      for (const session of [...openPickers]) session.close();
    }
  });
}

function readHistory(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(entry => typeof entry === 'string'))].slice(0, MAX_RECENT_FILES);
}

function rankFiles(items, query) {
  if (!query) return items.slice().sort((left, right) => left.description.localeCompare(right.description));
  const needle = query.toLowerCase();
  return items.map(item => ({ item, score: fileScore(item, needle) }))
    .filter(result => result.score < Infinity)
    .sort((left, right) => left.score - right.score || left.item.description.localeCompare(right.item.description))
    .map(result => result.item);
}

function fileScore(item, needle) {
  const name = item.label.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 10 + name.length / 10000;
  if (name.includes(needle)) return 20 + name.indexOf(needle) / 100;
  const path = item.description.toLowerCase();
  if (path.includes(needle)) return 30 + path.indexOf(needle) / 100;
  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const next = path.indexOf(character, cursor);
    if (next < 0) return Infinity;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 40 + gaps / 1000;
}

module.exports = { registerNavigation };
