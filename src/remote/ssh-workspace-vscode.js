'use strict';

const { open } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { connectWorkspace, maxFileBytes, uriScheme, digest } = require('./ssh-workspace');
const { registerSshProcesses } = require('./ssh-processes-vscode');
const { registerSshJavaDebug } = require('./ssh-java-debug-vscode');
const { registerSshJavaCompile } = require('./ssh-java-compile-vscode');

async function localText(uri) {
  if (uri?.scheme !== 'file') throw Error('Choose a local UTF-8 file.');
  const file = await open(uri.fsPath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) throw Error('Choose a local file up to 2 MiB.');
    const bytes = Buffer.alloc(maxFileBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxFileBytes) throw Error('The local file exceeded 2 MiB.');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

function registerSshWorkspace(context, vscode, { getLocalJava = () => undefined } = {}) {
  const tree = new vscode.EventEmitter();
  const files = new vscode.EventEmitter();
  const pending = new Map();
  let connection, processes, javaDebug, javaCompile;
  let epoch = 0;

  function retire() {
    epoch++;
    pending.clear();
    processes?.retire();
    void javaDebug?.retire();
    javaCompile?.retire();
    connection?.close();
    connection = undefined;
    tree.fire();
  }
  function requireConnection(uri) {
    if (!vscode.workspace.isTrusted || !connection || uri?.scheme !== uriScheme ||
        uri.authority !== connection.authority || uri.query || uri.fragment) {
      throw vscode.FileSystemError.Unavailable('Open the SSH workspace connection again.');
    }
    return connection;
  }
  function uriFor(authority, remotePath) {
    return vscode.Uri.from({ scheme: uriScheme, authority, path: remotePath });
  }
  async function attach(profile) {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before opening an SSH workspace.');
    const generation = ++epoch;
    const remote = await connectWorkspace(profile);
    if (generation !== epoch) {
      remote.close();
      throw Error('The SSH workspace connection request changed.');
    }
    retire();
    const authority = remote.id + '-' + randomUUID().slice(0, 8);
    connection = { ...remote, authority, uri: uriFor(authority, '/') };
    tree.fire();
    return connection.uri;
  }
  function type(kind) {
    return kind === 'directory' ? vscode.FileType.Directory : vscode.FileType.File;
  }
  async function operation(work) {
    try { return await work(); }
    catch (error) {
      if (error.remoteCode === 'missing') throw vscode.FileSystemError.FileNotFound();
      if (error.remoteCode === 'permission') throw vscode.FileSystemError.NoPermissions(error.message);
      throw error;
    }
  }
  const readOnly = () => { throw vscode.FileSystemError.NoPermissions('Use the reviewed SSH upload command.'); };
  const provider = {
    onDidChangeFile: files.event,
    watch: () => ({ dispose() {} }),
    stat(uri) {
      return operation(async () => {
        const { kind, size, modified } = await requireConnection(uri).stat(uri.path);
        return { type: type(kind), size, mtime: modified, ctime: modified, permissions: vscode.FilePermission.Readonly };
      });
    },
    readDirectory(uri) {
      return operation(async () => (await requireConnection(uri).list(uri.path))
        .map(([name, kind]) => [name, type(kind)]));
    },
    readFile(uri) {
      return operation(async () => (await requireConnection(uri).read(uri.path)).data);
    },
    writeFile: readOnly, createDirectory: readOnly, delete: readOnly, rename: readOnly
  };

  function item(uri, label, directory) {
    const entry = new vscode.TreeItem(label, directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    entry.resourceUri = uri;
    entry.contextValue = directory ? 'rocketbrain.sshFolder' : 'rocketbrain.sshFile';
    if (!directory) entry.command = { command: 'vscode.open', title: 'Open SSH File', arguments: [uri] };
    return entry;
  }
  const treeProvider = {
    onDidChangeTreeData: tree.event,
    getTreeItem: entry => entry,
    async getChildren(parent) {
      if (!connection) return [];
      if (!parent) {
        const root = item(connection.uri, connection.id, true);
        root.description = connection.host;
        root.tooltip = connection.root;
        return [root];
      }
      const entries = await provider.readDirectory(parent.resourceUri);
      return entries.sort(([one, oneType], [two, twoType]) => twoType - oneType || one.localeCompare(two))
        .map(([name, entryType]) => item(vscode.Uri.joinPath(parent.resourceUri, name), name, entryType === vscode.FileType.Directory));
    }
  };
  async function reviewUpload(remote, local) {
    const client = requireConnection(remote);
    const [current, updated] = await Promise.all([client.read(remote.path), localText(local)]);
    requireConnection(remote);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const bytes of [current.data, updated]) {
      if (bytes.includes(0)) throw Error('Choose a UTF-8 text file for the reviewed upload.');
      decoder.decode(bytes);
    }
    if (current.sha256 === digest(updated)) throw Error('The files already contain identical bytes.');
    const id = randomUUID();
    pending.clear();
    pending.set(id, { client, remote, local, expected: current.sha256, sha256: digest(updated) });
    return { id, remote, local };
  }
  async function applyUpload(id) {
    const review = pending.get(id);
    pending.delete(id);
    if (!review || review.client !== requireConnection(review.remote)) throw Error('Review a current SSH upload first.');
    const data = await localText(review.local);
    if (digest(data) !== review.sha256 || vscode.workspace.textDocuments.some(document =>
      document.isDirty && document.uri.toString() === review.local.toString())) {
      throw Error('The local file changed after review. Save it and review again.');
    }
    requireConnection(review.remote);
    const result = await review.client.replace(review.remote.path, data, review.expected);
    files.fire([{ type: vscode.FileChangeType.Changed, uri: review.remote }]);
    tree.fire();
    return result;
  }

  function command(id, action) {
    return vscode.commands.registerCommand('rocketbrain.sshWorkspace.' + id, async (...args) => {
      try { return await action(...args); }
      catch (error) { vscode.window.showErrorMessage('Rocketbrain SSH: ' + error.message); }
    });
  }
  processes = registerSshProcesses(vscode, command, () => connection, uriFor);
  javaDebug = registerSshJavaDebug(vscode, command, () => connection, getLocalJava);
  javaCompile = registerSshJavaCompile(vscode, command, requireConnection, uriFor);
  context.subscriptions.push(tree, files, { dispose: retire }, processes, javaDebug, javaCompile,
    vscode.workspace.registerFileSystemProvider(uriScheme, provider, { isReadonly: true }),
    vscode.window.registerTreeDataProvider('rocketbrain.sshWorkspace', treeProvider),
    command('attach', async () => {
      const profiles = vscode.workspace.getConfiguration('rocketbrain.sshWorkspace').get('profiles', []);
      const choices = profiles.slice(0, 20).map(profile => ({ label: String(profile.id), description: String(profile.host), profile }));
      const selected = await vscode.window.showQuickPick(choices, { title: 'Open Configured SSH Workspace' });
      if (selected) return attach(selected.profile);
    }),
    command('close', retire),
    command('refresh', () => tree.fire()),
    command('upload', async entry => {
      const remote = entry?.resourceUri || vscode.window.activeTextEditor?.document.uri;
      const client = requireConnection(remote);
      const [local] = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Review Local File' }) || [];
      if (!local) return;
      const review = await reviewUpload(remote, local);
      try {
        await vscode.commands.executeCommand('vscode.diff', remote, local, 'SSH upload · ' + remote.path);
        const confirm = await vscode.window.showInformationMessage('Replace the remote file with the reviewed local file?',
          { modal: true, detail: client.host + '\n' + client.root + remote.path }, 'Upload Reviewed File');
        if (confirm === 'Upload Reviewed File') return await applyUpload(review.id);
      } finally { pending.delete(review.id); }
    })
  );
  return { attach, close: retire, reviewUpload, applyUpload, processes, javaDebug, javaCompile };
}

module.exports = { registerSshWorkspace };
