'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { sameWslPath, wslUnc } = require('./wsl-paths');
const { createWslSourceReader, selectedSource } = require('./wsl-source-runtime');

const scheme = 'rocketbrain-wsl-source';
const commands = {
  start: 'rocketbrain.wsl.watchSource', compare: 'rocketbrain.wsl.compareSource',
  reload: 'rocketbrain.wsl.reloadSource', stop: 'rocketbrain.wsl.stopSourceWatch'
};
const sameText = (first, second) => first.replaceAll('\r\n', '\n') === second.replaceAll('\r\n', '\n');

function registerWslSourceWatch(vscode, { mapping, reader = createWslSourceReader(), interval = 3500, now = Date.now }) {
  let active, review, starting, timer, disposed = false;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  const subscriptions = [status];

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted || vscode.env.remoteName) {
      throw Error('Use a trusted local Windows window to observe WSL sources.');
    }
  }

  function documentScope(document) {
    const uri = document?.uri;
    const file = uri?.scheme === 'file' && !uri.query && !uri.fragment && wslUnc(uri.fsPath);
    const folder = file && (vscode.workspace.workspaceFolders || []).filter(item => {
      const root = item.uri.scheme === 'file' && wslUnc(item.uri.fsPath);
      return root && root.distribution === file.distribution && file.linux.startsWith(root.linux + '/');
    }).sort((first, second) => second.uri.fsPath.length - first.uri.fsPath.length)[0];
    if (!folder || document.isClosed || !vscode.workspace.textDocuments.includes(document)) {
      throw Error('Open a source document inside its exact WSL project folder.');
    }
    selectedSource({ storage: 'wsl', ...wslUnc(folder.uri.fsPath) }, uri.fsPath);
    return { root: folder.uri.fsPath, distribution: file.distribution, file: uri.fsPath };
  }

  function verify(record) {
    trusted();
    if (!record || active !== record || record.controller.signal.aborted ||
        documentScope(record.document).root !== record.root) {
      throw Error('The observed WSL document or workspace changed.');
    }
  }

  function updateStatus(record) {
    status.text = record.failure ? '$(warning) WSL source' :
      record.changed ? '$(diff) WSL source changed' : '$(eye) WSL source';
    status.tooltip = record.failure || (record.changed ?
      'Compare the selected open file with its Linux disk version.' : 'Rocketbrain is observing this WSL source.');
    status.command = commands.compare;
    status.show();
  }

  function stop() {
    clearTimeout(timer);
    starting?.abort();
    active?.controller.abort();
    starting = active = review = undefined;
    status.hide();
  }

  function state(record = active) {
    if (!record) return { state: 'stopped' };
    return { state: record.failure ? 'unavailable' : record.changed ? 'changed' : 'watching',
      sourceUri: record.document.uri.toString(), distribution: record.scope.distribution,
      sha256: record.snapshot.sha256 };
  }

  async function observe(record, verifyWindows) {
    const reading = (record.reading || Promise.resolve()).catch(() => {}).then(async () => {
      verify(record);
      const snapshot = await reader.read(record.scope, record.file, { signal: record.controller.signal, verifyWindows });
      verify(record);
      record.failure = undefined;
      if (sameText(snapshot.text, record.document.getText())) record.changed = false;
      else if (record.snapshot.fingerprint !== snapshot.fingerprint) record.changed = true;
      record.snapshot = snapshot;
      updateStatus(record);
      return snapshot;
    });
    record.reading = reading;
    try { return await reading; }
    finally { if (record.reading === reading) record.reading = undefined; }
  }

  function schedule(record) {
    timer = setTimeout(async () => {
      if (active !== record) return;
      try {
        if (!record.reloading) await observe(record, false);
      } catch (error) {
        if (active !== record || record.reloading) return;
        record.failure = error.message;
        updateStatus(record);
      } finally {
        if (active === record) schedule(record);
      }
    }, interval);
    timer.unref();
  }

  async function start(document = vscode.window.activeTextEditor?.document) {
    trusted();
    const source = documentScope(document);
    stop();
    const controller = starting = new AbortController();
    try {
      const scope = await mapping(source.distribution, source.root);
      const snapshot = await reader.read(scope, source.file, { signal: controller.signal, verifyWindows: true });
      trusted();
      if (starting !== controller || controller.signal.aborted || documentScope(document).root !== source.root) {
        throw Error('The WSL source closed or observation was stopped.');
      }
      const record = active = { ...source, scope, document, controller, snapshot,
        changed: !document.isDirty && !sameText(snapshot.text, document.getText()) };
      updateStatus(record);
      schedule(record);
      return state(record);
    } finally { if (starting === controller) starting = undefined; }
  }

  function reviewPair(plan) {
    const label = plan.record.file.split('\\').at(-1);
    return ['editor', 'linux'].map(side => vscode.Uri.from({ scheme, path: '/' + plan.token + '/' + side + '/' + label }));
  }

  const provider = { provideTextDocumentContent(uri) {
    const [, token, side] = uri.path.split('/');
    if (!review || token !== review.token || now() >= review.expires) return 'This WSL source comparison expired.';
    return side === 'editor' ? review.text : side === 'linux' ? review.snapshot.text : '';
  } };
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, provider));

  async function compare() {
    const record = active;
    verify(record);
    if (record.reloading) throw Error('Wait for the current WSL reload.');
    const snapshot = await observe(record, true);
    if (!record.changed || sameText(snapshot.text, record.document.getText())) {
      throw Error('The observed WSL source has no external text difference to review.');
    }
    const { document } = record;
    const plan = review = { record, document, token: randomUUID(), version: document.version,
      text: document.getText(), snapshot, expires: now() + 120000 };
    const [editorUri, linuxUri] = reviewPair(plan);
    return { token: plan.token, sourceUri: document.uri.toString(), version: plan.version, sha256: snapshot.sha256,
      editorUri, linuxUri, reloadAvailable: !document.isDirty, expires: plan.expires };
  }

  async function showComparison() {
    const plan = await compare();
    await vscode.commands.executeCommand('vscode.diff', plan.editorUri, plan.linuxUri,
      'WSL Source · Editor ↔ Linux Disk', { preserveFocus: true, viewColumn: vscode.ViewColumn.Beside, preview: true });
    return plan;
  }

  function cleanReview(plan) {
    const { record, document } = plan;
    verify(record);
    if (review !== plan || now() >= plan.expires || record.document !== document || document.isDirty ||
        document.version !== plan.version || document.getText() !== plan.text) {
      throw Error('The editor is dirty or changed after review. Preserve your edits and compare the source again.');
    }
  }

  function tabTarget(document) {
    const address = document.uri.toString(), file = wslUnc(document.uri.fsPath);
    const related = [];
    const matches = uri => uri?.scheme === 'file' && sameWslPath(wslUnc(uri.fsPath), file);
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
      if ([tab.input?.uri, tab.input?.original, tab.input?.modified].some(matches)) related.push({ group, tab });
    }
    const target = related[0];
    if (related.length !== 1 || !(target.tab.input instanceof vscode.TabInputText) ||
        target.tab.input.uri.toString() !== address || target.tab.isDirty) {
      throw Error('Reload requires one ordinary clean editor tab for the exact WSL source.');
    }
    if (target.group.isActive && target.group.activeTab !== target.tab) {
      throw Error('Return to the watched source or its side-by-side comparison before reloading.');
    }
    return target;
  }

  async function reload(token, { approved } = {}) {
    trusted();
    const plan = review;
    if (approved !== true || !plan || plan.token !== token) throw Error('Compare the WSL source and explicitly approve its reviewed disk version.');
    cleanReview(plan);
    const record = plan.record;
    if (record.reloading) throw Error('A WSL source reload is already in progress.');
    record.reloading = true;
    try {
      const latest = await observe(record, true);
      cleanReview(plan);
      if (latest.fingerprint !== plan.snapshot.fingerprint) throw Error('The Linux source changed after review. Compare it again.');
      const { group, tab } = tabTarget(plan.document);
      const column = group.viewColumn, address = plan.document.uri;
      review = undefined;
      // The tab API targets the selected file. VS Code retains its own dirty-close protection.
      if (!await vscode.window.tabGroups.close(tab, true)) throw Error('The WSL source tab was not closed.');
      const beforeReopen = await reader.read(record.scope, record.file, {
        signal: record.controller.signal, verifyWindows: true
      });
      trusted();
      if (active !== record || record.controller.signal.aborted || plan.document.version !== plan.version || plan.document.isDirty) {
        throw Error('The editor changed during reload. Its new content was left to VS Code.');
      }
      if (beforeReopen.fingerprint !== latest.fingerprint) {
        throw Error('The Linux source changed during reload. Open the source and compare it again.');
      }
      const editor = await vscode.window.showTextDocument(address, { preserveFocus: true, preview: false, viewColumn: column });
      const opened = editor.document;
      if (opened.uri.toString() !== address.toString() || opened.isDirty) throw Error('The re-opened WSL source is no longer clean.');
      record.document = opened;
      const deadline = Date.now() + 5000;
      while (!opened.isClosed && !opened.isDirty && !sameText(opened.getText(), latest.text) && Date.now() < deadline) {
        await delay(80);
      }
      if (opened.isClosed || opened.isDirty || !sameText(opened.getText(), latest.text) ||
          (await observe(record, true)).fingerprint !== latest.fingerprint || opened.isDirty ||
          !sameText(opened.getText(), latest.text)) {
        throw Error('VS Code could not confirm the reviewed WSL version. Compare the current disk and editor again.');
      }
      return { state: 'reloaded', sourceUri: address.toString(), sha256: latest.sha256 };
    } finally {
      record.reloading = false;
      if (active === record && record.document.isClosed) stop();
    }
  }

  async function approveReload() {
    const plan = review;
    if (!plan) throw Error('Compare the WSL source before reloading it.');
    cleanReview(plan);
    const selected = await vscode.window.showWarningMessage('Reload this WSL source from the reviewed Linux version?', {
      modal: true, detail: plan.record.file + '\nSHA-256 ' + plan.snapshot.sha256
    }, 'Reload Reviewed Source');
    if (selected === 'Reload Reviewed Source') return reload(plan.token, { approved: true });
  }

  for (const [name, action] of Object.entries({ start: () => start(), compare: showComparison, reload: approveReload, stop })) {
    subscriptions.push(vscode.commands.registerCommand(commands[name],
      () => Promise.resolve().then(action).catch(error => void vscode.window.showErrorMessage(error.message))));
  }
  subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    if (active?.document === document && !active.reloading) stop();
  }), vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!active) return;
    try { verify(active); } catch { stop(); }
  }));
  return { start, state, compare, showComparison, reload, stop,
    dispose() { disposed = true; stop(); for (const subscription of subscriptions) subscription.dispose(); } };
}

module.exports = { registerWslSourceWatch };
