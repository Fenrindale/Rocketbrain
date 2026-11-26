'use strict';

const path = require('node:path');
const { actionsIndex } = require('./navigation-index');

const COMMAND = 'rocketbrain.contextActions';
const RESULTS_COMMAND = 'rocketbrain.contextActions.results';
const sourceLanguages = new Map([['java', 'Java'], ['kotlin', 'Kotlin']]);
const springFiles = /(?:^|\/)(?:application(?:-[\w-]+)?\.(?:properties|ya?ml)|[^/]+\.xml)$/iu;

function item(command, group, detail, options = {}) {
  return { command, group, detail, ...options };
}

function recipes(frame) {
  const { kind, sql, result, trusted, hasFolders, source, debuggerStop } = frame;
  const actions = [];
  if (trusted && source) {
    if (sourceLanguages.has(source.language)) {
      actions.push(item('rocketbrain.java.fileStructure', 'Source', 'Browse declarations in this file.'));
    }
    actions.push(item('rocketbrain.java.findUsages', 'Source', 'Search for references to the symbol or key at the cursor.'));
    if (source.language === 'java' && !source.dirty) {
      actions.push(item('rocketbrain.java.workbench.sourceTarget', 'Source', 'Inspect the imported build component owning this file.'));
    }
    actions.push(item('rocketbrain.spring.beans', 'Source', 'Choose a Spring bean and jump to its declaration.'));
  }
  if (kind === 'sql') {
    if (sql?.run && (trusted || sql.offlineDemo)) {
      actions.push(item('rocketbrain.runQuery', 'SQL Editor', 'Run the selection or current statement on this console.'));
    }
    if (sql?.edit) actions.push(item('rocketbrain.sql.format', 'SQL Editor', 'Format SQL in the current editor.'));
    if (sql?.live && trusted) {
      actions.push(item('rocketbrain.sql.explainVisual', 'SQL Editor', 'Inspect the current statement’s execution plan.'));
    }
    actions.push(item('rocketbrain.focusQueryResults', 'SQL Editor', 'Move keyboard focus to the results view.'));
  }
  if (kind === 'results' && trusted && result) {
    if (result.source) actions.push(item('rocketbrain.results.returnToQuery', 'Query Results', 'Return to this result’s open SQL editor.',
      { passResult: true, label: 'Focus Query Editor' }));
    if (result.copy) actions.push(item('rocketbrain.results.copyTsv', 'Query Results', 'Copy this captured result as tab-separated values.',
      { passResult: true, label: 'Copy Result as TSV' }));
  }
  if (trusted && debuggerStop) {
    actions.push(item('rocketbrain.java.smartStepInto', 'Paused Java Debugger', 'Choose a call in the paused Java thread.'),
      item('rocketbrain.java.showAsyncTaskStack', 'Paused Java Debugger', 'Inspect recorded submission frames for this paused task.'));
  }
  if (trusted && hasFolders && (kind === 'workspace' || source)) {
    actions.push(item('rocketbrain.java.workbench.tasks', 'Workspace', 'Choose a build task for an imported Java project.'),
      item('rocketbrain.java.testing.discover', 'Workspace', 'Discover tests in an imported Java project.'));
  }
  actions.push(item('rocketbrain.openConsole', 'Database', 'Open a SQL console.'));
  if (trusted) actions.push(item('rocketbrain.connectMysql', 'Database', 'Choose a MySQL or MariaDB connection.'));
  actions.push(item('rocketbrain.searchEverywhere', 'Navigation', 'Search workspace files, symbols, settings and actions.'));
  if (hasFolders) actions.push(item('rocketbrain.recentFiles', 'Navigation', 'Open a recent workspace file.'));
  actions.push(item('rocketbrain.keyboardProfile', 'Preferences', 'Preview or export workspace, Java, SQL and debugger shortcuts.'),
    item('workbench.action.openGlobalKeybindings', 'Preferences', 'Change the keyboard shortcut for Context Actions.',
    { label: 'Open Keyboard Shortcuts' }), item('workbench.action.selectTheme', 'Preferences', 'Choose a VS Code color theme.',
    { label: 'Choose Color Theme' }));
  return actions;
}

function selectionKey(editor) {
  const selections = editor.selections || [editor.selection];
  if (!selections.length || selections.length > 32 || selections.some(selection => !selection?.anchor || !selection.active)) return undefined;
  return selections.map(selection => [selection.anchor.line, selection.anchor.character, selection.active.line, selection.active.character]);
}

function readEditor(vscode) {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!document || document.isClosed || !(tab?.input instanceof vscode.TabInputText) ||
      tab.input.uri.toString() !== document.uri.toString()) return undefined;
  const selection = selectionKey(editor);
  if (!selection) return undefined;
  return { document, context: {
    uri: document.uri.toString(), language: document.languageId, scheme: document.uri.scheme,
    version: document.version, dirty: document.isDirty, column: editor.viewColumn, selection
  } };
}

function registerContextActions(vscode, context, { database, java }) {
  const plans = new WeakMap();
  let disposed = false, pickerToken, pickerRevision = 0;

  function snapshot(surface) {
    const trusted = vscode.workspace.isTrusted;
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    const hasFolders = folders.length > 0;
    const editor = surface === 'workspace' || surface === 'results' ? undefined : readEditor(vscode);
    const document = editor?.document;
    const uri = document?.uri;
    const local = uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment;
    const folder = local && vscode.workspace.getWorkspaceFolder(uri);
    const language = editor?.context.language;
    const springResource = folder && springFiles.test(uri.path) && ['xml', 'properties', 'yaml'].includes(language);
    const jvmSource = folder && sourceLanguages.has(language);
    const sqlSource = language === 'sql' && (local || ['untitled', 'rocketbrain-profile-sql'].includes(uri.scheme));
    const kind = surface === 'results' ? 'results' : sqlSource ? 'sql' : jvmSource ? 'jvm' : springResource ? 'spring' : 'workspace';
    const result = kind === 'results' ? database.resultActionContext() : undefined;
    if (kind === 'results' && !result) throw Error('Open the Query Results view before choosing its actions.');
    const sql = kind === 'sql' ? database.sqlActionContext(document) : undefined;
    const source = jvmSource || springResource ? editor.context : undefined;
    const session = vscode.debug.activeDebugSession;
    const debug = trusted && session?.type === 'rocketbrain-java' ? java.debug.getState(session.id) : undefined;
    const debuggerStop = debug?.state === 'stopped' && debug.resuming === undefined ?
      { session: session.id, stop: debug.stopVersion, thread: debug.threadId } : undefined;
    const label = kind === 'results' ? 'Query Results' : kind === 'workspace' ? 'Workspace' :
      sourceLanguages.get(language) || (kind === 'sql' ? 'SQL Editor' : 'Spring Configuration');
    const runtime = source && java.getState().runtimeIdentity;
    return { label, kind, trusted, hasFolders, sql, result, source, debuggerStop, document,
      key: JSON.stringify({ kind, trusted, folders: folders.map(folder => folder.uri.toString()), editor: editor?.context,
        runtime, sql, result, debuggerStop }) };
  }

  function current(saved, surface) {
    if (disposed) throw Error('Context Actions is closed.');
    const live = snapshot(surface);
    if (live.key !== saved.key || live.document !== saved.document) {
      throw Error('The editor, connection or result changed. Open Context Actions again.');
    }
  }

  async function prepare(surface = 'active') {
    if (disposed || !['active', 'editor', 'workspace', 'results'].includes(surface)) throw Error('Choose a supported Context Actions surface.');
    const saved = snapshot(surface);
    const available = await vscode.commands.getCommands(true);
    current(saved, surface);
    const commands = new Set(available);
    const labels = new Map(actionsIndex([context.extension], available).map(action => [action.command, action.label]));
    const allowed = new Map();
    const actions = recipes(saved).flatMap(action => {
      const label = commands.has(action.command) && (action.label || labels.get(action.command));
      if (!label) return [];
      allowed.set(action.command, action);
      return [Object.freeze({ command: action.command, label, group: action.group, detail: action.detail })];
    });
    const plan = Object.freeze({ surface: saved.kind, title: 'Context Actions · ' + saved.label, actions: Object.freeze(actions) });
    plans.set(plan, { surface, saved, allowed });
    return plan;
  }

  async function dispatch(plan, command) {
    const selected = plans.get(plan);
    if (!selected || !selected.allowed.has(command)) throw Error('Choose an action offered by the current Context Actions list.');
    plans.delete(plan);
    current(selected.saved, selected.surface);
    const available = await vscode.commands.getCommands(true);
    current(selected.saved, selected.surface);
    if (!available.includes(command)) throw Error('The action is no longer available.');
    const action = selected.allowed.get(command);
    const args = action.passResult ? [selected.saved.result] : [];
    const result = await vscode.commands.executeCommand(command, ...args);
    return { command, result };
  }

  async function choose(surface) {
    const revision = ++pickerRevision;
    pickerToken?.cancel();
    const plan = await prepare(surface);
    if (disposed || revision !== pickerRevision) return undefined;
    const items = [];
    let group;
    for (const choice of plan.actions) {
      if (group !== choice.group) {
        group = choice.group;
        items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      }
      items.push({ label: choice.label, detail: choice.detail, action: choice.command });
    }
    const token = new vscode.CancellationTokenSource();
    pickerToken = token;
    try {
      const choice = await vscode.window.showQuickPick(items, {
        title: plan.title, placeHolder: 'Type to filter actions', matchOnDetail: true
      }, token.token);
      return !token.token.isCancellationRequested && choice?.action ? dispatch(plan, choice.action) : undefined;
    } finally {
      if (pickerToken === token) pickerToken = undefined;
      token.dispose();
    }
  }

  const open = async surface => {
    try { return await choose(surface); }
    catch (error) { void vscode.window.showErrorMessage('Rocketbrain: ' + error.message); }
  };
  const subscriptions = [
    vscode.commands.registerCommand(COMMAND, input => open(['editor', 'workspace'].includes(input?.surface) ? input.surface : 'active')),
    vscode.commands.registerCommand(RESULTS_COMMAND, () => open('results'))
  ];
  return { prepare, dispatch, dispose() {
    disposed = true;
    pickerToken?.cancel();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { registerContextActions };
