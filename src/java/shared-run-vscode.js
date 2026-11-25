'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const M = require('./workbench-model');
const shared = require('./shared-run');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestName = file => {
  if (!file.toLowerCase().endsWith(shared.extension)) throw M.fail('Choose a .rocketbrain-run.json file.');
  return file;
};

function registerSharedRuns(vscode, { trusted, generation, roots, getConfiguration, findProject, checkTarget, save }) {
  const reviews = new Map(), lifetimeMs = 120000;
  function rootFor(value) {
    const available = roots();
    const root = M.workspacePath(value, available);
    if (!available.some(entry => path.relative(entry, root) === '')) throw M.fail('Select an open workspace folder.');
    return root;
  }

  async function exportSharedRun({ rootUri, fileUri, configurationId }) {
    trusted();
    const ticket = generation(), root = rootFor(rootUri);
    const saved = getConfiguration(configurationId);
    if (!saved) throw M.fail('Choose a saved Java run configuration.');
    const project = await findProject(saved.projectUri);
    const source = M.workspacePath(project.root, [root]);
    const requested = manifestName(M.local(fileUri));
    const parent = M.workspacePath(path.dirname(requested), [root]);
    const file = path.join(parent, path.basename(requested));
    const data = Buffer.from(JSON.stringify(shared.shareRunConfiguration(saved, root, source), null, 2) + '\n');
    shared.parseSharedRun(data);
    trusted();
    if (ticket !== generation() || rootFor(rootUri) !== root || JSON.stringify(getConfiguration(configurationId)) !== JSON.stringify(saved)) {
      throw M.fail('The workspace or saved run changed before exporting.');
    }
    await fs.writeFile(file, data, { flag: 'wx' });
    return { fileUri: pathToFileURL(file).href, sha256: hash(data), privateValuesIncluded: false };
  }

  async function readManifest(file) {
    const handle = await fs.open(file, 'r');
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.size > shared.maximumBytes) throw M.fail('Choose a regular shared Java run file of at most 32 KiB.');
      const buffer = Buffer.alloc(shared.maximumBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      return { value: shared.parseSharedRun(bytes), sha256: hash(bytes) };
    } finally { await handle.close(); }
  }

  async function reviewSharedRun({ rootUri, fileUri }) {
    trusted();
    const ticket = generation(), root = rootFor(rootUri);
    const file = manifestName(M.workspacePath(fileUri, [root], { directory: false }));
    const seen = await readManifest(file);
    const project = await findProject(M.workspacePath(path.join(root, seen.value.project), [root]));
    const target = await checkTarget(project, seen.value);
    trusted();
    if (ticket !== generation()) throw M.fail('The workspace changed during the shared run review.');
    const id = randomUUID(), expiresAt = Date.now() + lifetimeMs;
    while (reviews.size >= 8) reviews.delete(reviews.keys().next().value);
    reviews.set(id, { ticket, root, file, project, target, ...seen, expiresAt });
    return { reviewId: id, expiresAt, sha256: seen.sha256, sharedRun: structuredClone(seen.value), executesProjectCode: false };
  }

  async function applySharedRun({ reviewId, approved, bindings }) {
    trusted();
    if (approved !== true) throw M.fail('Approve the reviewed Java run before importing.');
    const review = reviews.get(reviewId);
    if (!review || Date.now() > review.expiresAt || review.ticket !== generation()) {
      throw M.fail('The shared Java run review expired. Review it again.');
    }
    const values = shared.bindSharedRun(review.value, bindings);
    async function verify() {
      trusted();
      if (review.ticket !== generation() || Date.now() > review.expiresAt ||
          rootFor(review.root) !== review.root ||
          M.workspacePath(review.file, [review.root], { directory: false }) !== review.file ||
          (await readManifest(review.file)).sha256 !== review.sha256) {
        throw M.fail('The shared Java run changed. Review it again.');
      }
    }
    reviews.delete(reviewId);
    await verify();
    const { name, mainClass } = review.value;
    return save({ name, mainClass, projectUri: review.project.uri, ...review.target, ...values }, verify);
  }

  async function chooseFolder() {
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (folders.length === 1) return folders[0].uri;
    const picked = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, uri: folder.uri })),
      { title: 'Select workspace for shared Java run' });
    return picked?.uri;
  }

  async function exportCommand(configurationId) {
    if (!configurationId) return;
    const root = await chooseFolder();
    if (!root) return;
    const file = await vscode.window.showSaveDialog({ title: 'Export shared Java run',
      defaultUri: vscode.Uri.joinPath(root, 'settings'+shared.extension), filters: { 'Shared Java run': ['json'] } });
    return file && exportSharedRun({ rootUri: root.toString(), fileUri: file.toString(), configurationId });
  }

  async function importCommand() {
    const root = await chooseFolder();
    if (!root) return;
    const picked = await vscode.window.showOpenDialog({ title: 'Open shared Java run', defaultUri: root,
      canSelectMany: false, filters: { 'Shared Java run': ['json'] } });
    if (!picked?.length) return;
    const review = await reviewSharedRun({ rootUri: root.toString(), fileUri: picked[0].toString() });
    const value = review.sharedRun;
    const detail = [value.name, value.project + ' · ' + value.mainClass,
      ...(value.prelaunch ? [value.prelaunch.tool + ' · ' + value.prelaunch.name] : []),
      'Workspace file SHA-256 ' + review.sha256].join('\n');
    const response = await vscode.window.showInformationMessage('Review shared Java run before importing', { modal: true, detail }, 'Import');
    if (response !== 'Import') { reviews.delete(review.reviewId); return; }
    const bindings = { args: [], vmArgs: [], env: Object.create(null), springValues: [] };
    for (const [target, count, label] of [[bindings.args, value.arguments, 'Program argument'], [bindings.vmArgs, value.jvmOptions, 'JVM option']]) {
      for (let index = 0; index < count; index++) {
        const input = await vscode.window.showInputBox({ title: label + ' ' + (index + 1), password: true });
        if (input === undefined) return;
        target.push(input);
      }
    }
    for (const key of value.environment) {
      const input = await vscode.window.showInputBox({ title: 'Environment variable ' + key, password: true });
      if (input === undefined) return;
      bindings.env[key] = input;
    }
    for (const property of value.spring?.properties || []) {
      const input = await vscode.window.showInputBox({ title: 'Spring property ' + property.key, password: true });
      if (input === undefined) return;
      bindings.springValues.push(input);
    }
    return applySharedRun({ reviewId: review.reviewId, approved: true, bindings });
  }
  return { exportSharedRun, reviewSharedRun, applySharedRun, exportCommand, importCommand, clear: () => reviews.clear() };
}

module.exports = { registerSharedRuns };
