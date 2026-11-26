'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { editedText } = require('../../src/java/refactoring');

const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function headlessHost(root, lsp) {
  const documents = new Map(), submitted = [];
  class Range {
    constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  }
  class TextEdit { constructor(range, newText) { Object.assign(this, { range, newText }); } }
  class WorkspaceEdit {
    constructor() { this.entries = []; }
    set(value, edits) { this.entries.push([value, edits]); }
  }
  const workspace = {
    isTrusted: true,
    get textDocuments() { return [...documents.values()]; },
    getWorkspaceFolder(address) {
      const relative = path.relative(root, address.fsPath);
      if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return { uri: uri(root) };
    },
    async openTextDocument(address) {
      const id = key(address.fsPath);
      if (documents.has(id)) return documents.get(id);
      const document = { uri: address, languageId: 'java', version: 1, isClosed: false, isDirty: false,
        text: await fs.readFile(address.fsPath, 'utf8'), getText() { return this.text; } };
      documents.set(id, document);
      lsp.notify('textDocument/didOpen', { textDocument: { uri: address.toString(), languageId: 'java', version: 1,
        text: document.text } });
      return document;
    },
    async applyEdit(edit) {
      assert.ok(edit instanceof WorkspaceEdit);
      for (const [address, changes] of edit.entries) {
        const document = await this.openTextDocument(address);
        document.text = editedText(document.text, changes);
        document.version++;
        document.isDirty = true;
        lsp.notify('textDocument/didChange', { textDocument: { uri: address.toString(), version: document.version },
          contentChanges: [{ text: document.text }] });
      }
      submitted.push(edit);
      return true;
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} })
  };
  async function save() {
    for (const doc of documents.values()) {
      if (!doc.isDirty) continue;
      await fs.writeFile(doc.uri.fsPath, doc.text);
      doc.isDirty = false;
      lsp.notify('textDocument/didSave', { textDocument: { uri: doc.uri.toString() } });
    }
  }
  return { workspace, save, submitted, vscode: { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) },
    workspace, Range, TextEdit, WorkspaceEdit, commands: { registerCommand: () => ({ dispose() {} }) } } };
}

module.exports = { uri, headlessHost };
