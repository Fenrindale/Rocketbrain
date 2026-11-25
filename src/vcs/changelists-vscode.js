'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectRepository, observeChanges, supportedPath, inside, maxChanges } = require('./changelist-git');
const { createChangelistState, validLabel, maxEditors } = require('./changelist-state');

const maxFileBytes = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const point = ({ line, character }) => ({ line, character });
const launchKey = launch => JSON.stringify([launch.name, launch.type, launch.request]);

function registerChangelists(context, vscode) {
  const store = createChangelistState(context.workspaceState);
  let generation = 0, disposed = false;

  function guard(ticket = generation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted local workspace to manage Git changelists.');
    if (ticket !== generation) throw Error('The workspace folders changed. Open Git changelists again.');
  }

  async function repository(repositoryUri, ticket = generation) {
    guard(ticket);
    const uri = typeof repositoryUri === 'string' ? vscode.Uri.parse(repositoryUri, true) : repositoryUri;
    const folder = uri?.scheme === 'file' && !uri.authority && vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file') throw Error('Choose a Git repository in an open local workspace folder.');
    const observed = await inspectRepository(uri.fsPath, folder.uri.fsPath);
    guard(ticket);
    if (!observed) return null;
    return { ...observed, uri: vscode.Uri.file(observed.root).toString(), folder, ticket };
  }

  async function required(uri, ticket) {
    const repo = await repository(uri, ticket);
    if (!repo) throw Error('No working tree is visible inside that workspace folder.');
    return repo;
  }

  async function observe(repo) {
    const result = await observeChanges(repo);
    const latest = await required(repo.uri, repo.ticket);
    if (repo.key !== latest.key) throw Error('The Git working tree changed. Open its changelists again.');
    return result;
  }

  async function snapshot(repo) {
    const { changes, omitted } = await observe(repo);
    const records = await store.lists(repo.key);
    guard(repo.ticket);
    const changed = new Map(changes.map(change => [change.path, change]));
    const members = new Set(records.flatMap(list => list.paths));
    return { repositoryUri: repo.uri, omitted, lists: records.map(list => ({ id: list.id, name: list.name,
      context: list.context, members: list.paths.map(name => changed.has(name) ? { ...changed.get(name), state: 'changed' } :
        { path: name, statuses: [], state: 'unavailable' }) })), unassigned: changes.filter(change => !members.has(change.path)) };
  }

  function launchChoices(repo) {
    const configurations = vscode.workspace.getConfiguration('launch', repo.folder.uri).get('configurations', []);
    if (!Array.isArray(configurations)) return [];
    const byId = new Map();
    for (const { name, type, request } of configurations.slice(0, 100).filter(item => item && typeof item === 'object')) {
      if (!validLabel(name, 200) || !validLabel(type, 100) || !['launch', 'attach'].includes(request)) continue;
      const ref = { name, type, request }, id = launchKey(ref);
      byId.set(id, byId.has(id) ? null : ref);
    }
    return [...byId.values()].filter(Boolean);
  }

  function relativeFile(repo, uri) {
    if (uri?.scheme !== 'file' || uri.authority || !inside(repo.root, uri.fsPath)) return null;
    const relative = path.relative(repo.root, uri.fsPath).split(path.sep).join('/');
    return supportedPath(relative) ? relative : null;
  }

  async function fileOf(repo, relative) {
    if (!supportedPath(relative)) return { state: 'outside-repository' };
    const file = path.resolve(repo.root, ...relative.split('/'));
    if (!inside(repo.root, file)) return { state: 'outside-repository' };
    try {
      const actual = await fs.realpath(file);
      if (path.normalize(file) !== path.normalize(actual)) return { state: 'path-changed' };
      const stat = await fs.stat(actual);
      if (!stat.isFile()) return { state: 'not-a-file' };
      if (stat.size > maxFileBytes) return { state: 'too-large' };
      return { uri: vscode.Uri.file(file) };
    } catch (error) {
      return { state: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable' };
    }
  }

  function documentHash(document) {
    if (document.offsetAt(document.lineAt(document.lineCount - 1).range.end) > maxFileBytes) return null;
    const text = document.getText();
    return Buffer.byteLength(text) <= maxFileBytes ? hash(text) : null;
  }

  async function capture(repo, listId, launch = null) {
    const selected = launch === null ? null : launchChoices(repo).find(item => launchKey(item) === launchKey(launch));
    if (launch && !selected) throw Error('Choose a launch configuration that is still present in this workspace folder.');
    const activeEditor = vscode.window.activeTextEditor, tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const visible = new Map(vscode.window.visibleTextEditors.map(editor => [editor.document.uri.toString(), editor]));
    if (activeEditor) visible.set(activeEditor.document.uri.toString(), activeEditor);
    const recorded = new Map();
    for (const tab of tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const uri = tab.input.uri, relative = relativeFile(repo, uri);
      if (relative && !recorded.has(relative)) recorded.set(relative, uri);
    }
    const activePath = relativeFile(repo, activeEditor?.document.uri);
    if (activePath && !recorded.has(activePath)) recorded.set(activePath, activeEditor.document.uri);
    if (recorded.size > maxEditors) throw Error('Close some repository tabs before capturing more than 32 editors.');
    const editors = [];
    for (const [relative, uri] of recorded) {
      const file = await fileOf(repo, relative);
      guard(repo.ticket);
      if (!file.uri) continue;
      const editor = visible.get(uri.toString()), selection = editor?.selection;
      const fingerprint = selection && documentHash(editor.document);
      const saved = fingerprint ? { anchor: point(selection.anchor), active: point(selection.active), hash: fingerprint } : null;
      editors.push({ path: relative, selection: saved });
    }
    const current = editors.some(editor => editor.path === activePath) ? activePath : null;
    return store.capture(repo.key, listId, { editors, activePath: current, launch: selected });
  }

  function selectionOf(document, snapshot) {
    if (!snapshot || documentHash(document) !== snapshot.hash) return null;
    const valid = ({ line, character }) => line < document.lineCount && character <= document.lineAt(line).text.length;
    if (!valid(snapshot.anchor) || !valid(snapshot.active)) return null;
    const position = ({ line, character }) => new vscode.Position(line, character);
    return new vscode.Selection(position(snapshot.anchor), position(snapshot.active));
  }

  async function restore(repo, listId) {
    const { context: saved } = await store.list(repo.key, listId);
    if (!saved) throw Error('Save this changelist’s editor context before restoring it.');
    const results = [];
    const editors = [...saved.editors.filter(editor => editor.path !== saved.activePath),
      ...saved.editors.filter(editor => editor.path === saved.activePath)];
    for (const entry of editors) {
      guard(repo.ticket);
      const file = await fileOf(repo, entry.path);
      if (!file.uri) { results.push({ path: entry.path, state: file.state }); continue; }
      let document;
      try { document = await vscode.workspace.openTextDocument(file.uri); }
      catch { results.push({ path: entry.path, state: 'unreadable' }); continue; }
      const verified = await fileOf(repo, entry.path);
      guard(repo.ticket);
      if (!verified.uri) { results.push({ path: entry.path, state: verified.state }); continue; }
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: entry.path !== saved.activePath });
      guard(repo.ticket);
      const selection = selectionOf(document, entry.selection);
      if (selection) {
        editor.selection = selection;
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      results.push({ path: entry.path, state: 'opened', selection: selection ? 'restored' : entry.selection ? 'stale' : 'not-recorded' });
    }
    const launch = saved.launch && { ...saved.launch,
      state: launchChoices(repo).some(item => launchKey(item) === launchKey(saved.launch)) ? 'available' : 'unavailable' };
    return { editors: results, launch, launched: false };
  }

  const api = {
    snapshot: async ({ repositoryUri } = {}) => snapshot(await required(repositoryUri)),
    create: async ({ repositoryUri, name } = {}) => { const repo = await required(repositoryUri); return store.create(repo.key, name); },
    assign: async ({ repositoryUri, listId, paths } = {}) => {
      if (!Array.isArray(paths) || paths.length > maxChanges) throw Error('Select existing changed paths to move into the changelist.');
      const selected = [...paths], repo = await required(repositoryUri);
      const { changes } = await observe(repo);
      return store.assign(repo.key, listId, selected, new Set(changes.map(change => change.path)), () => guard(repo.ticket));
    },
    unassign: async ({ repositoryUri, listId, paths } = {}) => {
      if (!Array.isArray(paths) || paths.length > maxChanges) throw Error('Select paths in the changelist to unassign.');
      const selected = [...paths], repo = await required(repositoryUri);
      return store.unassign(repo.key, listId, selected);
    },
    capture: async ({ repositoryUri, listId, launch = null } = {}) => capture(await required(repositoryUri), listId, launch),
    restore: async ({ repositoryUri, listId } = {}) => restore(await required(repositoryUri), listId),
    launchChoices: async ({ repositoryUri } = {}) => launchChoices(await required(repositoryUri))
  };

  async function chooseRepository() {
    const ticket = generation, known = new Map(), active = vscode.window.activeTextEditor?.document.uri;
    const candidates = [...(active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active) ? [vscode.Uri.file(path.dirname(active.fsPath))] : []),
      ...(vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri)];
    for (const candidate of candidates) {
      const repo = await repository(candidate, ticket);
      if (repo) known.set(repo.uri, repo);
    }
    const choice = await vscode.window.showQuickPick([
      ...[...known.values()].map(repo => ({ label: path.basename(repo.root), description: repo.root, repo })),
      { label: 'Browse for a Git Repository…', browse: true }
    ], { title: 'Select a Git Working Tree' });
    guard(ticket);
    if (!choice?.browse) return choice?.repo;
    const [folder] = await vscode.window.showOpenDialog({ title: 'Choose a Local Git Repository Folder', canSelectFolders: true,
      canSelectFiles: false, canSelectMany: false }) || [];
    return folder && required(folder, ticket);
  }

  const describe = entry => entry.state === 'unavailable' ? 'Unavailable in current Git status' : entry.statuses.map(code => code.trim()).join(' · ');
  const fileChoice = entry => ({ label: entry.path, description: describe(entry), detail: entry.previousPath && 'From ' + entry.previousPath, entry });

  async function showList(repo, initial) {
    for (;;) {
      const current = await snapshot(repo), list = current.lists.find(item => item.id === initial.id);
      if (!list) throw Error('The changelist no longer exists.');
      const selected = await vscode.window.showQuickPick([
        { label: 'Add or Move Changed Files', action: 'assign' },
        { label: 'Remove File Assignments', action: 'unassign' },
        { label: 'Save Editor Context', action: 'capture' },
        ...(list.context ? [{ label: 'Restore Editor Context', description: list.context.editors.length + ' files', action: 'restore' }] : []),
        { label: 'Rename Changelist', action: 'rename' },
        { label: 'Delete Changelist', action: 'remove' },
        ...list.members.map(fileChoice)
      ], { title: list.name + ' · ' + path.basename(repo.root), matchOnDescription: true });
      guard(repo.ticket);
      if (!selected) return;
      if (selected.entry) {
        if (selected.entry.state === 'unavailable') throw Error('This path is no longer in the current Git changes.');
        const file = await fileOf(repo, selected.entry.path);
        guard(repo.ticket);
        if (!file.uri) throw Error('This exact worktree path is unavailable.');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file.uri), { preview: false });
        return;
      }
      const input = { repositoryUri: repo.uri, listId: list.id };
      if (selected.action === 'assign') {
        const eligible = [...current.unassigned, ...current.lists.filter(item => item.id !== list.id).flatMap(item =>
          item.members.filter(member => member.state === 'changed'))];
        const files = await vscode.window.showQuickPick(eligible.map(fileChoice), { title: 'Select Changed Files to Assign', canPickMany: true });
        guard(repo.ticket);
        if (files?.length) await api.assign({ ...input, paths: files.map(file => file.entry.path) });
      } else if (selected.action === 'unassign') {
        const files = await vscode.window.showQuickPick(list.members.map(fileChoice), { title: 'Select Assignments to Remove', canPickMany: true });
        guard(repo.ticket);
        if (files?.length) await api.unassign({ ...input, paths: files.map(file => file.entry.path) });
      } else if (selected.action === 'capture') {
        const configurations = launchChoices(repo);
        const launch = configurations.length ? await vscode.window.showQuickPick([{ label: 'Editor Context Only', launch: null },
          ...configurations.map(launch => ({ label: launch.name, description: launch.type, launch }))], { title: 'Associate a Launch Configuration' }) :
          { launch: null };
        guard(repo.ticket);
        if (launch) await capture(repo, list.id, launch.launch);
      } else if (selected.action === 'restore') {
        const outcome = await restore(repo, list.id);
        const opened = outcome.editors.filter(item => item.state === 'opened').length;
        const stale = outcome.editors.filter(item => item.selection === 'stale').length;
        await vscode.window.showInformationMessage(`${opened} editors opened, ${outcome.editors.length - opened} unavailable, ${stale} selections changed.` +
          (outcome.launch ? ` Launch configuration ${outcome.launch.name} is ${outcome.launch.state}.` : ''));
        return outcome;
      } else if (selected.action === 'rename') {
        const name = await vscode.window.showInputBox({ title: 'Rename Changelist', value: list.name });
        guard(repo.ticket);
        if (name !== undefined) await store.rename(repo.key, list.id, name);
      } else if (selected.action === 'remove') {
        if (await vscode.window.showWarningMessage('Remove this saved changelist and its editor context?', { modal: true }, 'Remove Changelist') === 'Remove Changelist') {
          guard(repo.ticket);
          return store.remove(repo.key, list.id);
        }
      }
    }
  }

  async function manage(option) {
    const repo = option?.repositoryUri ? await required(option.repositoryUri) : await chooseRepository();
    if (!repo) return;
    for (;;) {
      const current = await snapshot(repo);
      const selected = await vscode.window.showQuickPick([
        { label: 'Create Changelist', create: true },
        ...current.lists.map(item => ({ label: item.name, list: item, description: item.members.length + ' paths' }))
      ], { title: 'Git Changelists · ' + path.basename(repo.root),
        placeHolder: current.unassigned.length + ' unassigned paths' + (current.omitted ? ' · ' + current.omitted + ' unsupported paths' : '') });
      guard(repo.ticket);
      if (!selected) return;
      if (selected.create) {
        const name = await vscode.window.showInputBox({ title: 'New Git Changelist', prompt: 'Name this group of working-tree changes' });
        guard(repo.ticket);
        if (name !== undefined) await showList(repo, await store.create(repo.key, name));
      } else await showList(repo, selected.list);
    }
  }

  const subscriptions = [vscode.workspace.onDidChangeWorkspaceFolders(() => generation++),
    vscode.commands.registerCommand('rocketbrain.vcs.changelists', async option => {
      try { guard(); return await manage(option); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Git Changelists: ' + error.message); }
    })];
  return { ...api, dispose() { disposed = true; generation++; for (const item of subscriptions) item.dispose(); } };
}

module.exports = { registerChangelists };
