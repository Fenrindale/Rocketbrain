'use strict';

const { randomUUID } = require('node:crypto');

const scheme = 'rocketbrain-profile-sql';
const isProfileConsole = document => document?.uri?.scheme === scheme;

function registerProfileConsoleFiles(vscode, context) {
  const files = new Map();
  const changes = new vscode.EventEmitter();
  const parent = vscode.Uri.from({ scheme, path: '/' });
  const maxBytes = 256 * 1024;
  const item = uri => {
    const record = files.get(uri.toString());
    if (!record) throw vscode.FileSystemError.FileNotFound(uri);
    return record;
  };
  const forbidden = uri => { throw vscode.FileSystemError.NoPermissions(uri); };
  const provider = {
    onDidChangeFile: changes.event,
    watch: () => ({ dispose() {} }),
    stat(uri) {
      if (uri.toString() === parent.toString()) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      const { ctime, mtime, contents } = item(uri);
      return { type: vscode.FileType.File, ctime, mtime, size: contents.byteLength };
    },
    readDirectory(uri) {
      if (uri.toString() !== parent.toString()) throw vscode.FileSystemError.FileNotADirectory(uri);
      return [...files.values()].map(({ uri: file }) => [file.path.slice(1), vscode.FileType.File]);
    },
    readFile: uri => Uint8Array.from(item(uri).contents),
    writeFile(uri, contents, options) {
      const record = item(uri);
      if (!options.overwrite || contents.byteLength > maxBytes) throw vscode.FileSystemError.NoPermissions(uri);
      record.contents = Uint8Array.from(contents);
      record.mtime = Math.max(Date.now(), record.mtime + 1);
      changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    },
    createDirectory: forbidden, delete: forbidden, rename: forbidden
  };
  context.subscriptions.push(changes, vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true }));
  return {
    create(label, text) {
      if (files.size >= 48) throw Error('Close old profile console editors before opening more.');
      const name = label.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 48) || 'SQL Console';
      const uri = vscode.Uri.from({ scheme, path: `/${name} ${randomUUID().slice(0, 12)}.sql` });
      const time = Date.now();
      files.set(uri.toString(), { uri, contents: Buffer.from(text), ctime: time, mtime: time });
      changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
      return uri;
    },
    remove(uri) {
      if (files.delete(uri.toString())) changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }
  };
}

module.exports = { isProfileConsole, registerProfileConsoleFiles };
