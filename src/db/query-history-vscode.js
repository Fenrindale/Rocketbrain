'use strict';

const { createQueryHistory } = require('./query-history');
const { assertQueryTarget } = require('./saved-queries');

function registerQueryHistory(context, vscode, { database, checkAccess }) {
  const history = createQueryHistory(context.workspaceState, checkAccess);
  let lastFailure = 0;
  const subscription = database.onDidCompleteUserSql?.(receipt => {
    void history.record(receipt).catch(() => {
      try { checkAccess(); } catch { return; }
      const now = Date.now();
      if (now - lastFailure > 60000) {
        lastFailure = now;
        vscode.window.setStatusBarMessage?.('Rocketbrain could not save the query history entry.', 4500);
      }
    });
  });
  const timer = setInterval(() => { void history.prune().catch(() => {}); }, 60000);
  timer.unref?.();
  void history.prune().catch(() => {});

  async function openHistory(id, revision, destination) {
    const entry = history.resolve(id, revision);
    if (!destination) return database.openSavedQuery(entry.sql);
    const beforeRun = () => {
      const current = history.resolve(id, revision);
      const active = database.savedQueryTarget();
      assertQueryTarget(destination, active);
      if (current.target !== active.key) throw new Error('Reconnect to the database where this query was recorded before rerunning it.');
    };
    beforeRun();
    return database.openSavedQuery(entry.sql, destination, { beforeRun });
  }

  async function pickEntries(options) {
    const destination = database.savedQueryTarget();
    const entries = history.list(options);
    if (!entries.length) {
      await vscode.window.showInformationMessage('No query history entries match this view.');
      return;
    }
    const selection = await vscode.window.showQuickPick(entries.map(entry => ({
      label: entry.preview, description: new Date(entry.recordedAt).toLocaleString(),
      detail: entry.target === destination.key ? 'Current database' : 'Different database', entry
    })), { title: 'SQL Query History', matchOnDescription: true });
    if (!selection) return;
    checkAccess();
    const { id, revision, target } = selection.entry;
    const actions = [
      { label: 'Open SQL in Editor', value: 'open' },
      ...(target === destination.key ? [{ label: 'Run in New Read-Only Console', description: destination.label, value: 'run' }] : []),
      { label: 'Delete History Entry', value: 'delete' }
    ];
    const action = await vscode.window.showQuickPick(actions, { title: 'History Entry Actions' });
    if (action?.value === 'open') return openHistory(id, revision);
    if (action?.value === 'run') return openHistory(id, revision, destination);
    if (action?.value === 'delete') {
      const confirmation = await vscode.window.showWarningMessage('Delete this query history entry?', { modal: true }, 'Delete Entry');
      if (confirmation === 'Delete Entry') return history.remove(id, revision);
    }
  }

  async function command() {
    checkAccess();
    await history.prune();
    const enabled = history.enabled();
    const selection = await vscode.window.showQuickPick([
      { label: 'Recent Queries', value: 'recent' },
      { label: 'Queries for the Current Database', value: 'current' },
      { label: 'Queries from the Last 24 Hours', value: 'day' },
      { label: 'Search SQL Text', value: 'search' },
      { label: enabled ? 'Turn Off Query History' : 'Turn On Query History', value: 'toggle' },
      { label: 'Clear Query History', value: 'clear' }
    ], { title: 'SQL Query History Settings and Views' });
    if (!selection) return;
    checkAccess();
    if (selection.value === 'recent') return pickEntries({});
    if (selection.value === 'current') {
      const target = database.savedQueryTarget().key;
      if (!target) throw new Error('Reconnect before filtering history by the current database.');
      return pickEntries({ target });
    }
    if (selection.value === 'day') return pickEntries({ since: Date.now() - 24 * 60 * 60 * 1000 });
    if (selection.value === 'search') {
      const search = await vscode.window.showInputBox({ title: 'Search Query History', prompt: 'Enter SQL text to search.' });
      if (search !== undefined) return pickEntries({ search });
    }
    if (selection.value === 'toggle') {
      if (enabled) return history.setEnabled(false);
      const confirmed = await vscode.window.showWarningMessage(
        'Keep successful read-only editor queries in this workspace for up to 30 days? Source SQL includes literals you typed.',
        { modal: true }, 'Turn On Query History'
      );
      if (confirmed === 'Turn On Query History') return history.setEnabled(true);
    }
    if (selection.value === 'clear') {
      const accepted = await vscode.window.showWarningMessage('Clear all stored queries from this workspace history?', { modal: true }, 'Clear History');
      if (accepted === 'Clear History') return history.clear();
    }
  }

  return { command, enabled: history.enabled, setEnabled: history.setEnabled, list: history.list, open: openHistory,
    remove: history.remove, clear: history.clear, drain: history.drain,
    async dispose() {
      clearInterval(timer);
      subscription?.dispose();
      await history.drain();
    } };
}

module.exports = { registerQueryHistory };
