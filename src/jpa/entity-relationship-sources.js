'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { contained } = require('../java/file-templates');
const { targetDeclarations } = require('./entity-relationships');

function observedFiles(project) {
  return new Set(project.sourceRoots.filter(root => !root.unavailable && contained(project.root, root.path))
    .flatMap(root => root.packages.flatMap(pkg => pkg.files.map(file => file.path))));
}

function readSource(vscode, file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 512 * 1024 || path.relative(file, fs.realpathSync(file))) {
    throw Error('Use a bounded physical Java source file for the relationship target.');
  }
  if (vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' &&
      !path.relative(file, doc.uri.fsPath) && doc.isDirty)) {
    throw Error('Save edits to the relationship target Java source before reviewing it.');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > 512 * 1024) throw Error('Relationship target Java sources must be smaller than 512 KiB.');
  return { text: bytes.toString('utf8'), digest: createHash('sha256').update(bytes).digest('hex') };
}

function captureRelationshipSources(vscode, project, requests) {
  const uris = new Set(requests.map(request => request.targetUri).filter(Boolean));
  if (!uris.size) return { sources: [], verify() {} };
  const files = observedFiles(project);
  const retained = [...uris].map(value => {
    const uri = vscode.Uri.parse(value);
    if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri) ||
        ![...files].some(file => !path.relative(file, uri.fsPath))) {
      throw Error('Choose a local Java relationship target observed in the selected project.');
    }
    return { uri: value, file: uri.fsPath, ...readSource(vscode, uri.fsPath) };
  });
  return {
    sources: retained.map(({ uri, text }) => ({ uri, text })),
    verify() {
      for (const saved of retained) {
        let current;
        try { current = readSource(vscode, saved.file); } catch {}
        if (saved.digest !== current?.digest || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(saved.file))) {
          throw Error('A relationship target Java source changed after review. Generate a new preview.');
        }
      }
    }
  };
}

function chooseableDeclarations(vscode, project, tables) {
  const candidates = [];
  for (const file of observedFiles(project)) {
    let text;
    try { ({ text } = readSource(vscode, file)); } catch { continue; }
    if (!text.includes('@') || !text.includes('Entity') || !text.includes('Table')) continue;
    const possible = targetDeclarations({ uri: vscode.Uri.file(file).toString(), text });
    candidates.push(...possible.filter(item => tables.has(item.table)));
  }
  return candidates.sort((a, b) => a.targetType.localeCompare(b.targetType));
}

module.exports = { captureRelationshipSources, chooseableDeclarations };
