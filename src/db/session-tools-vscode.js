'use strict';

const { createSavedQueries, queryName, queryText } = require('./saved-queries');
const { levels } = require('./transaction-isolation');

function registerDbSessionTools(context, vscode, { database }) {
  let closed = false;
  const subscriptions = [];

  function trusted() {
    if (closed || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to use these database tools.');
  }

  const store = createSavedQueries(context.workspaceState, () => {
    trusted();
    if (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length) {
      throw new Error('Open a workspace or folder to store queries.');
    }
  });

  function editorSource(editor) {
    trusted();
    const sql = queryText(database.selectedSql(editor));
    return { document: editor.document, version: editor.document.version, sql };
  }

  function checkSource(source) {
    trusted();
    if (source.document.isClosed || source.document.version !== source.version) {
      throw new Error('The SQL editor changed. Choose the selection or statement again.');
    }
  }

  function validateName(value) {
    try { queryName(value); }
    catch (error) { return error.message; }
  }

  async function saveCommand() {
    const source = editorSource(vscode.window.activeTextEditor);
    const name = await vscode.window.showInputBox({
      title: 'Save SQL Query', prompt: 'Saves the SQL text you selected in this workspace. Check the text for private literals.',
      validateInput: validateName, ignoreFocusOut: true
    });
    if (name === undefined) return;
    checkSource(source);
    return store.save(name, source.sql);
  }

  function openSavedQuery(id, revision, destination) {
    const sql = store.source(id, revision);
    if (destination && !Number.isInteger(destination.connectionEpoch)) throw new Error('Choose the active database for this saved query.');
    return database.openSavedQuery(sql, destination);
  }

  async function savedQueryCommand() {
    const items = store.list().map(query => ({
      label: query.name, description: query.favorite ? '$(star-full) Favorite' : undefined, query
    }));
    if (!items.length) {
      await vscode.window.showInformationMessage('No saved SQL queries in this workspace. Run Save SQL Query from a SQL editor.');
      return;
    }
    const selection = await vscode.window.showQuickPick(items, { title: 'Saved SQL Queries', ignoreFocusOut: true });
    if (!selection) return;
    trusted();
    const { id, revision, name, favorite } = selection.query;
    const destination = database.savedQueryTarget();
    const actions = [
      { label: 'Open SQL in Editor', value: 'open' },
      { label: 'Run in New Read-Only Console', description: destination.label, value: 'run' },
      { label: favorite ? 'Remove from Favorites' : 'Mark as Favorite', value: 'favorite' },
      { label: 'Rename', value: 'rename' },
      { label: 'Replace with SQL from Current Editor', value: 'replace' },
      { label: 'Delete Saved Query', value: 'delete' }
    ];
    const action = await vscode.window.showQuickPick(actions, { title: name, ignoreFocusOut: true });
    if (!action) return;
    if (action.value === 'open') return openSavedQuery(id, revision);
    if (action.value === 'run') return openSavedQuery(id, revision, destination);
    if (action.value === 'favorite') return store.update(id, revision, { favorite: !favorite });
    if (action.value === 'rename') {
      const newName = await vscode.window.showInputBox({ title: 'Rename Saved Query', value: name, validateInput: validateName, ignoreFocusOut: true });
      if (newName !== undefined) return store.update(id, revision, { name: newName });
    }
    if (action.value === 'replace') {
      const source = editorSource(vscode.window.activeTextEditor);
      const accepted = await vscode.window.showWarningMessage('Replace the SQL text of “' + name + '” with the selected SQL or current statement?', { modal: true }, 'Replace SQL');
      if (accepted !== 'Replace SQL') return;
      checkSource(source);
      return store.update(id, revision, { sql: source.sql });
    }
    if (action.value === 'delete') {
      const accepted = await vscode.window.showWarningMessage('Delete the saved query “' + name + '” from this workspace?', { modal: true }, 'Delete Saved Query');
      if (accepted === 'Delete Saved Query') return store.remove(id, revision);
    }
  }

  async function isolationCommand() {
    trusted();
    const document = vscode.window.activeTextEditor?.document;
    const observed = await database.inspectConsoleIsolation(document);
    trusted();
    if (observed.inTransaction || observed.outcomeUnknown) throw new Error('Resolve any active or uncertain transaction before changing isolation.');
    const options = levels.map(level => ({ label: level, description: level === observed.transactionIsolation ? 'Current' : '', level }));
    const selection = await vscode.window.showQuickPick(options, {
      title: 'Set Transaction Isolation', placeHolder: 'Applies to future transactions in this console until it reconnects', ignoreFocusOut: true
    });
    if (!selection) return;
    trusted();
    const state = await database.setConsoleIsolation(document, selection.level, observed);
    if (!closed) await vscode.window.showInformationMessage('Console isolation is ' + state.transactionIsolation + '.');
    return state;
  }

  const command = (id, action) => vscode.commands.registerCommand(id, async () => {
    try { return await action(); }
    catch (error) { if (!closed) await vscode.window.showErrorMessage('Rocketbrain Database: ' + error.message); }
  });
  subscriptions.push(
    command('rocketbrain.setTransactionIsolation', isolationCommand),
    command('rocketbrain.sql.saveQuery', saveCommand),
    command('rocketbrain.sql.savedQueries', savedQueryCommand)
  );

  return {
    listSavedQueries: store.list,
    async saveQuery(name, editor = vscode.window.activeTextEditor) {
      const source = editorSource(editor);
      checkSource(source);
      return store.save(name, source.sql);
    },
    updateSavedQuery: store.update,
    deleteSavedQuery: store.remove,
    openSavedQuery,
    inspectConsoleIsolation(document) {
      trusted();
      return database.inspectConsoleIsolation(document);
    },
    setConsoleIsolation(document, level, observed) {
      trusted();
      return database.setConsoleIsolation(document, level, observed);
    },
    async dispose() {
      if (closed) return;
      closed = true;
      for (const subscription of subscriptions) subscription.dispose();
      await store.drain();
    }
  };
}

module.exports = { registerDbSessionTools };
