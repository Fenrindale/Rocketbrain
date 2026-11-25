'use strict';

const { randomUUID } = require('node:crypto');

const prefix = 'rocketbrain.sqlDraft.v1.';
const maxDrafts = 16;
const maxBytes = 128 * 1024;
const maxTotalBytes = 1024 * 1024;
const isId = value => typeof value === 'string' && /^[\da-f-]{36}$/.test(value);
const titleFor = value => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 96) || 'SQL Draft';
const validOffset = (value, text) => Number.isSafeInteger(value) && value >= 0 && value <= text.length;

function readRecord(value, id) {
  if (!value || value.id !== id || !isId(id) || value.title !== titleFor(value.title) ||
      typeof value.text !== 'string' || Buffer.byteLength(value.text) > maxBytes ||
      !isId(value.revision) || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0 ||
      !validOffset(value.anchor, value.text) || !validOffset(value.active, value.text)) return null;
  const { title, text, revision, savedAt, anchor, active } = value;
  return { id, title, text, revision, savedAt, anchor, active };
}

function createConsoleDraftStore(state, available) {
  let pending = Promise.resolve();
  const key = id => prefix + id;
  function requireWorkspace() {
    if (!available()) throw Error('Open a trusted workspace folder to use saved SQL drafts.');
  }
  function get(id) {
    requireWorkspace();
    if (!isId(id)) throw Error('Select a saved SQL draft.');
    const value = readRecord(state.get(key(id)), id);
    if (!value) throw Error('The saved SQL draft is unavailable.');
    return value;
  }
  function entries() {
    requireWorkspace();
    return state.keys().filter(name => name.startsWith(prefix)).map(name => readRecord(state.get(name), name.slice(prefix.length)))
      .filter(Boolean).sort((left, right) => right.savedAt - left.savedAt || left.id.localeCompare(right.id));
  }
  function serialize(task) {
    const next = pending.then(task);
    pending = next.catch(() => {});
    return next;
  }
  function write(input, priorId) {
    return serialize(async () => {
      requireWorkspace();
      const previous = priorId === undefined ? null : get(priorId);
      const id = previous?.id ?? randomUUID();
      const item = readRecord({ ...input, id, revision: randomUUID(), savedAt: Date.now(), title: previous?.title ?? titleFor(input.title) }, id);
      if (!item) throw Error('The SQL draft must be at most 128 KiB and have a valid editor selection.');
      const size = Buffer.byteLength(item.text);
      const remaining = entries().filter(value => value.id !== id);
      const used = remaining.reduce((total, value) => total + Buffer.byteLength(value.text), 0);
      if (remaining.length >= maxDrafts || used + size > maxTotalBytes) throw Error('Saved SQL drafts are full. Remove a draft before saving more.');
      if (previous && item.text === previous.text && item.anchor === previous.anchor && item.active === previous.active) return previous;
      await state.update(key(id), item);
      return item;
    });
  }
  function remove(id, revision) {
    return serialize(async () => {
      if (get(id).revision !== revision) throw Error('The SQL draft changed. Review it before removing it.');
      await state.update(key(id), undefined);
    });
  }
  const describe = ({ text, anchor, active, ...value }) => ({ ...value, bytes: Buffer.byteLength(text) });
  return { get, write, remove, list: () => entries().map(describe), describe };
}

function registerConsoleDrafts(context, vscode, { profileFiles, canTrack, output }) {
  const selected = () => vscode.window.activeTextEditor;
  const store = createConsoleDraftStore(context.workspaceState, () => vscode.workspace.isTrusted && Boolean(vscode.workspace.workspaceFolders?.length));
  const tracked = new Map();
  const reopening = new Map();
  const starting = new Map();

  function currentSnapshot(record) {
    const { document } = record;
    const activeEditor = selected();
    const editor = activeEditor?.document === document ? activeEditor : vscode.window.visibleTextEditors.find(value => value.document === document);
    if (editor) {
      record.anchor = document.offsetAt(editor.selection.anchor);
      record.active = document.offsetAt(editor.selection.active);
    }
    const text = document.getText();
    return { text, anchor: Math.min(record.anchor, text.length), active: Math.min(record.active, text.length) };
  }
  function save(record) {
    clearTimeout(record.timer);
    return store.write(currentSnapshot(record), record.id);
  }
  function schedule(record) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      save(record).catch(error => output.appendLine('SQL draft: ' + error.message));
    }, 350);
  }
  async function track(editor, title) {
    if (!editor || !canTrack(editor.document)) throw Error('Open a Rocketbrain SQL console before tracking a draft.');
    const document = editor.document, key = document.uri.toString();
    const existing = tracked.get(key);
    if (existing) return store.describe(await save(existing));
    if (starting.has(key)) return starting.get(key);
    const task = (async () => {
      const view = { document, anchor: 0, active: 0 };
      const record = await store.write({ ...currentSnapshot(view), title });
      if (!document.isClosed) {
        tracked.set(key, { ...view, id: record.id });
        schedule(tracked.get(key));
      }
      return store.describe(record);
    })();
    starting.set(key, task);
    try { return await task; }
    finally { starting.delete(key); }
  }
  async function open(id) {
    const draft = store.get(id);
    const existing = [...tracked.values()].find(entry => entry.id === id && !entry.document.isClosed);
    if (existing) {
      await vscode.window.showTextDocument(existing.document, { preview: false });
      return existing.document.uri.toString();
    }
    if (reopening.has(id)) return reopening.get(id);
    const task = (async () => {
      const uri = profileFiles.create('Draft ' + draft.title, draft.text);
      const key = uri.toString();
      try {
        let document = await vscode.workspace.openTextDocument(uri);
        if (document.languageId !== 'sql') document = await vscode.languages.setTextDocumentLanguage(document, 'sql');
        const latest = store.get(id);
        if (latest.revision !== draft.revision || document.getText() !== draft.text) throw Error('The saved SQL draft changed. Open it again.');
        const anchor = document.positionAt(draft.anchor), active = document.positionAt(draft.active);
        tracked.set(key, { id, document, anchor: draft.anchor, active: draft.active, recovered: true });
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        editor.selection = new vscode.Selection(anchor, active);
        editor.revealRange(new vscode.Range(editor.selection.start, editor.selection.end));
        return key;
      } catch (error) {
        const entry = tracked.get(key);
        if (entry) clearTimeout(entry.timer);
        tracked.delete(key);
        profileFiles.remove(uri);
        throw error;
      }
    })();
    reopening.set(id, task);
    try { return await task; }
    finally { reopening.delete(id); }
  }
  function checkpoint() {
    const entry = tracked.get(selected()?.document.uri.toString());
    if (!entry) throw Error('Track this SQL console as a draft first.');
    return save(entry).then(store.describe);
  }
  async function remove(id, revision) {
    if ([...tracked.values()].some(entry => entry.id === id) || reopening.has(id)) throw Error('Close the open SQL draft before removing it.');
    await store.remove(id, revision);
  }
  async function choose(title) {
    const choices = store.list().map(value => ({ label: value.title,
      description: new Date(value.savedAt).toLocaleString(), detail: value.bytes + ' bytes · local SQL draft', value }));
    if (!choices.length) throw Error('There are no saved SQL drafts in this workspace.');
    return (await vscode.window.showQuickPick(choices, { title }))?.value;
  }
  function command(action, handler) {
    return vscode.commands.registerCommand('rocketbrain.sqlDraft.' + action, async () => {
      try { return await handler(); }
      catch (error) { await vscode.window.showErrorMessage('Rocketbrain: ' + error.message); }
    });
  }
  const subscriptions = [
    command('track', async () => {
      const editor = selected();
      if (!editor || !canTrack(editor.document)) throw Error('Open a Rocketbrain SQL console before tracking a draft.');
      if (tracked.has(editor.document.uri.toString())) return checkpoint();
      const title = await vscode.window.showInputBox({ title: 'Track SQL Console as Draft', prompt: 'SQL text is saved locally in this workspace as you edit. Remove any secrets before tracking.', value: 'SQL Draft' });
      if (title !== undefined) return track(editor, title);
    }),
    command('open', async () => { const item = await choose('Restore SQL Draft'); if (item) return open(item.id); }),
    command('checkpoint', checkpoint),
    command('remove', async () => {
      const item = await choose('Remove SQL Draft');
      if (item && await vscode.window.showWarningMessage('Remove the saved SQL draft ' + item.title + '?', { modal: true }, 'Remove Draft') === 'Remove Draft') {
      await remove(item.id, item.revision);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      const record = tracked.get(document.uri.toString());
      if (record && contentChanges.length) schedule(record);
    }),
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
      const record = tracked.get(textEditor.document.uri.toString());
      if (record) schedule(record);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString(), record = tracked.get(key);
      if (!record) return;
      tracked.delete(key);
      save(record).catch(error => output.appendLine('SQL draft: ' + error.message));
    })
  ];
  return { track, open, checkpoint, remove, list: store.list,
    isRecovered: document => tracked.get(document?.uri.toString())?.recovered === true,
    async dispose() {
      for (const subscription of subscriptions) subscription.dispose();
      await Promise.allSettled([...starting.values(), ...reopening.values()]);
      const flushed = await Promise.allSettled([...tracked.values()].map(save));
      tracked.clear();
      for (const item of flushed) if (item.status === 'rejected') output.appendLine('SQL draft: ' + item.reason.message);
    }
  };
}

module.exports = { createConsoleDraftStore, registerConsoleDrafts };
