'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {editedText} = require('../../src/java/refactoring');
const {uri} = require('./java-signature-jdt-host');

function packageRenameHeadless(root,lsp,sourceFolder,targetFolder,prepareRefactoring) {
  const documents = new Map(), submitted = [];
  const vscode = {
    Uri: { file: uri, parse: value => uri(fileURLToPath(value)) },
    Range: class { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
    TextEdit: class { constructor(range, newText) { Object.assign(this, { range, newText }); } },
    WorkspaceEdit: class {
      entries = [];
      renames = [];
      set(target, edits) { this.entries.push({ target, edits }); }
      renameFile(from, to, options) { this.renames.push({ from, to, options }); }
    },
    workspace: {
      isTrusted: true,
      get textDocuments() { return [...documents.values()]; },
      getWorkspaceFolder(target) {
        const relative = path.relative(root, target.fsPath);
        if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return { uri: uri(root) };
      },
      async openTextDocument(target) {
        if (documents.has(target.fsPath)) return documents.get(target.fsPath);
        const text = await fs.readFile(target.fsPath, 'utf8');
        const languageId = target.fsPath.endsWith('.java') ? 'java' : 'plaintext';
        const document = { uri: target, version: 1, isClosed: false, isDirty: false, languageId, getText: () => text };
        documents.set(target.fsPath, document);
        if (languageId === 'java') lsp.notify('textDocument/didOpen', {
          textDocument: { uri: target.toString(), text, version: 1, languageId }
        });
        return document;
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      async applyEdit(edit) {
        assert.ok(edit instanceof vscode.WorkspaceEdit);
        assert.equal(edit.renames.length, 1);
        const [rename] = edit.renames;
        assert.equal(rename.from.fsPath, path.join(root, sourceFolder));
        assert.equal(rename.to.fsPath, path.join(root, targetFolder));
        assert.deepEqual(rename.options, { overwrite: false, ignoreIfExists: false });
        assert.equal(prepareRefactoring().isApplyingPackageRename([{ oldUri: rename.from, newUri: rename.to }]), true);
        for (const { target, edits } of edit.entries) {
          const text = await fs.readFile(target.fsPath, 'utf8');
          await fs.writeFile(target.fsPath, editedText(text, edits));
        }
        await fs.rename(rename.from.fsPath, rename.to.fsPath);
        submitted.push(edit);
        return true;
      }
    },
    commands: { registerCommand: () => ({ dispose() {} }) }
  };
  return { vscode, submitted };
}

module.exports = {packageRenameHeadless};
