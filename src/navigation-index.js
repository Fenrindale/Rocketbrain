'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { inspectRepository, gitRead } = require('./vcs/changelist-git');

const coreSettings = ['editor.formatOnSave', 'editor.fontSize', 'editor.tabSize', 'editor.wordWrap', 'files.autoSave',
  'files.exclude', 'search.exclude', 'terminal.integrated.defaultProfile.windows', 'workbench.colorTheme', 'workbench.editor.enablePreview'];
const coreActions = [['workbench.action.showCommands', 'Show All Commands'], ['workbench.action.openSettings', 'Open Settings'],
  ['workbench.action.quickOpen', 'Go to File'], ['workbench.action.showAllEditors', 'Show Open Editors']];
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const entriesPerRepository = 60;

function settingsIndex(extensions) {
  const found = new Map(coreSettings.map(setting => [setting, { type: 'setting', label: setting, key: setting, description: 'VS Code setting' }]));
  for (const extension of extensions) {
    const config = extension.packageJSON?.contributes?.configuration;
    if (!config || !extension.isActive && !extension.id.startsWith('vscode.')) continue;
    for (const section of [config].flat()) {
      for (const [key, property] of Object.entries(section?.properties ?? {})) {
        if (found.size >= 2500 || found.has(key) || !/^[\w.-]{1,200}$/.test(key) || property?.deprecationMessage) continue;
        const description = property?.description ?? property?.markdownDescription;
        found.set(key, { type: 'setting', label: key, key, description: 'Setting · ' + extension.id,
          searchText: typeof description === 'string' ? description.slice(0, 240) : '' });
      }
    }
  }
  return [...found.values()];
}

function actionsIndex(extensions, commands) {
  const registered = new Set(commands);
  const found = new Map();
  const labelOf = value => typeof value === 'string' ? value : value?.value;
  const add = (id, title, description) => {
    if (registered.has(id) && title && !found.has(id) && found.size < 1500) found.set(id, { type: 'action', label: title,
      command: id, description, searchText: id });
  };
  for (const [id, title] of coreActions) add(id, title, 'VS Code Command');
  for (const extension of extensions.filter(item => item.isActive)) {
    const actions = extension.packageJSON?.contributes?.commands;
    if (!Array.isArray(actions)) continue;
    for (const { command, title, category } of actions) {
      const label = labelOf(title);
      if (typeof label === 'string' && label[0] !== '%') add(command, label, labelOf(category) || extension.id);
    }
  }
  return [...found.values()];
}

function gitItems(raw, type, repo, folderName) {
  const found = [];
  const records = raw.toString('utf8').split(/\r?\n/).slice(0, entriesPerRepository);
  for (const record of records) {
    const separator = record.indexOf('\0');
    const hash = record.slice(0, separator);
    if (separator < 0 || !sha.test(hash)) continue;
    const text = record.slice(separator + 1).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
    const shortHash = hash.slice(0, 12);
    found.push({ type, hash, label: text || shortHash, repo, description: `${folderName} · ${shortHash}` });
  }
  return found;
}

async function gitIndex(vscode) {
  if (!vscode.workspace.isTrusted) return [];
  const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').slice(0, 4);
  const candidates = (await Promise.allSettled(roots.map(async folder => ({ folder,
    directories: await repositoryCandidates(folder.uri.fsPath) })))).flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const results = await Promise.allSettled(candidates.flatMap(({ folder, directories }) => directories.map(async directory => {
    const repo = await inspectRepository(directory, folder.uri.fsPath);
    return repo ? readRepositoryEntries(repo, folder) : [];
  })));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

async function repositoryCandidates(root) {
  const found = [root];
  const directory = await fs.opendir(root);
  let examined = 0;
  for await (const entry of directory) {
    if (++examined > 64 || found.length === 3) break;
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const candidate = path.join(root, entry.name);
    const marker = await fs.lstat(path.join(candidate, '.git')).catch(() => null);
    if (marker?.isDirectory() || marker?.isFile()) found.push(candidate);
  }
  return found;
}

async function readRepositoryEntries(repo, folder) {
  const scope = { ...repo, workspace: folder.uri.fsPath };
  const location = path.relative(folder.uri.fsPath, repo.root);
  const label = location ? folder.name + '/' + location.split(path.sep).join('/') : folder.name;
  const [branches, commits] = await Promise.allSettled([
    gitRead(repo.root, ['for-each-ref', `--count=${entriesPerRepository}`, '--sort=-committerdate',
      '--format=%(objectname)%00%(refname:short)', 'refs/heads']),
    gitRead(repo.root, ['log', `-${entriesPerRepository}`, '--no-decorate', '--no-notes', '--no-show-signature',
      '--format=%H%x00%s', 'HEAD', '--'])
  ]);
  return [
    ...(branches.status === 'fulfilled' ? gitItems(branches.value, 'branch', scope, label) : []),
    ...(commits.status === 'fulfilled' ? gitItems(commits.value, 'commit', scope, label) : [])
  ];
}

async function gitSummary(vscode, item) {
  if (!vscode.workspace.isTrusted || !sha.test(item.hash) || !item.repo?.root || !item.repo?.workspace) {
    throw Error('Open a trusted local Git workspace first.');
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(item.repo.root));
  if (!folder || path.relative(folder.uri.fsPath, item.repo.workspace)) throw Error('The selected worktree changed. Search again.');
  const repo = await inspectRepository(item.repo.root, folder.uri.fsPath);
  if (!repo || repo.key !== item.repo.key) throw Error('The selected worktree changed. Search again.');
  const report = await gitRead(repo.root, ['show', '--stat=120,90,30', '--no-decorate', '--no-notes', '--no-show-signature',
    '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--format=fuller', item.hash, '--']);
  return report.subarray(0, 256 * 1024).toString('utf8') + (report.length > 256 * 1024 ? '\n\n[Preview limited to 256 KiB]' : '');
}

function rankItems(items, query) {
  const term = query.trim().toLowerCase();
  const words = term.split(/\s+/).filter(Boolean);
  const ranked = [];
  for (const item of items) {
    const name = item.label.toLowerCase();
    const detail = [item.description, item.searchText, item.hash].filter(Boolean).join(' ').toLowerCase();
    let score;
    if (!term || name === term) score = 0;
    else if (name.startsWith(term)) score = 10 + name.length / 10000;
    else if (name.includes(term)) score = 20 + name.indexOf(term) / 100;
    else if (detail.includes(term)) score = 30 + detail.indexOf(term) / 1000;
    else if (words.length > 1 && words.every(word => name.includes(word) || detail.includes(word))) score = 40;
    else if (item.type === 'file') {
      let cursor = 0, gaps = 0;
      for (const character of term) {
        const position = detail.indexOf(character, cursor);
        if (position < 0) { cursor = -1; break; }
        gaps += position - cursor;
        cursor = position + 1;
      }
      if (cursor < 0) continue;
      score = 50 + gaps / 1000;
    } else continue;
    ranked.push({ item, score });
  }
  return ranked.sort((left, right) => left.score - right.score || left.item.label.localeCompare(right.item.label) ||
    left.item.description.localeCompare(right.item.description)).map(({ item }) => item);
}

module.exports = { settingsIndex, actionsIndex, gitIndex, gitSummary, rankItems };
