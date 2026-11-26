'use strict';

const path = require('node:path');
const { createComposeEdit, normalizeText } = require('./compose-edit');

function registerComposeEditor(vscode, register) {
  const local = uri => uri?.scheme === 'file' && !uri.authority;
  const service = createComposeEdit({ trusted: () => vscode.workspace.isTrusted,
    workspaceRoots: () => (vscode.workspace.workspaceFolders || []).filter(folder => local(folder.uri)).map(folder => folder.uri.fsPath) });
  const scheme = 'rocketbrain-compose-model';
  const editors = new Map(), models = new Map();
  const subscriptions = [
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent(uri) { return models.get(uri.toString()) || 'This Compose review expired.'; }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString(), draft = editors.get(key);
      if (draft) {
        service.discard(draft.id);
        editors.delete(key);
      }
    })
  ];

  function assertSaved(files) {
    if (!vscode.workspace.isTrusted || vscode.workspace.textDocuments.some(document => local(document.uri) &&
        document.isDirty && files.some(file => !path.relative(file, document.uri.fsPath)))) {
      throw Error('Save the selected Compose stack files before reviewing or applying the override.');
    }
  }

  async function selectFile(title) {
    const [uri] = await vscode.window.showOpenDialog({ title, openLabel: 'Select Compose File',
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { YAML: ['yaml', 'yml'] } }) || [];
    if (!uri) return;
    if (!local(uri)) throw Error('Choose Compose YAML files in a local workspace.');
    return uri.fsPath;
  }

  register('rocketbrain.docker.composeOverrideDraft', 'Open Compose Override Draft', async (_, signal) => {
    const base = await selectFile('Select Base Compose File');
    if (!base) return;
    const files = [base];
    while (files.length < 8) {
      const override = await selectFile('Select Override ' + files.length + ' in Apply Order');
      if (!override) return;
      files.push(override);
      if (files.length === 8) break;
      const next = await vscode.window.showQuickPick(['Add Another Override', 'Choose Override to Edit'], {
        title: 'Compose File Order', placeHolder: files.map(file => path.basename(file)).join(' → ')
      });
      if (!next) return;
      if (next === 'Choose Override to Edit') break;
    }
    const target = await vscode.window.showQuickPick(files.slice(1).map((file, index) => ({
      label: path.basename(file), description: path.dirname(file), detail: 'Override ' + (index + 1), index: index + 1
    })), { title: 'Choose One Saved Override to Edit' });
    if (!target) return;
    assertSaved(files);
    const draft = await service.prepare(files, target.index, { signal });
    const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: draft.text });
    editors.clear();
    editors.set(document.uri.toString(), draft);
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage('Edit the draft, then run Review Compose Override Draft from the Command Palette.');
  });

  register('rocketbrain.docker.composeOverrideReview', 'Review Compose Override Draft', async (_, signal) => {
    const document = vscode.window.activeTextEditor?.document;
    const draft = document && editors.get(document.uri.toString());
    if (!draft) throw Error('Open an active Compose Override Draft first.');
    assertSaved(draft.files);
    const version = document.version;
    const review = await service.review(draft.id, document.getText(), { signal });
    const before = vscode.Uri.from({ scheme, path: '/' + review.token + '/current.json' });
    const after = vscode.Uri.from({ scheme, path: '/' + review.token + '/proposed.json' });
    models.clear();
    const model = value => JSON.stringify({ fileOrder: review.files, changedPaths: review.changes, model: value }, null, 2) + '\n';
    models.set(before.toString(), model(review.before));
    models.set(after.toString(), model(review.after));
    await vscode.commands.executeCommand('vscode.diff', before, after, 'Compose model · ' + path.basename(review.selected));
    const summary = review.changes.length ? review.changes.length + ' Compose model paths differ.'
      : 'The source changes produce the same Compose model.';
    const confirmed = await vscode.window.showInformationMessage(summary + ' Review the diff for ' + path.basename(review.selected) + '.',
      'Apply to Override Editor');
    if (confirmed !== 'Apply to Override Editor') return;
    const applied = await service.apply(review.token, { approved: true, signal, async edit({ file, beforeText, text }) {
      if (document.isClosed || document.version !== version) throw Error('The draft changed. Review its latest version.');
      const existing = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const stamp = existing.version;
      const editor = await vscode.window.showTextDocument(existing, { preview: false });
      assertSaved(draft.files);
      if (signal?.aborted || existing.version !== stamp || !local(existing.uri) || path.relative(file, existing.uri.fsPath) ||
          normalizeText(existing.getText()) !== normalizeText(beforeText) || document.isClosed || document.version !== version) return false;
      const entire = new vscode.Range(existing.positionAt(0), existing.positionAt(existing.getText().length));
      return editor.edit(builder => builder.replace(entire, text));
    } });
    void vscode.window.showInformationMessage('Compose override updated in its editor. Save it when ready.');
    return applied;
  });

  return { service, dispose() {
    for (const subscription of subscriptions) subscription.dispose();
    service.dispose();
    editors.clear();
    models.clear();
  } };
}

module.exports = { registerComposeEditor };
