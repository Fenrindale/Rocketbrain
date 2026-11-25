'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeTerm, limits, matches, textHash, pushLimited, qualified } = require('./unified-search');

const excluded = '**/{node_modules,.git,.vscode-test,test-output,build,target,bin,out,.gradle,dist}/**';
const excludedNames = new Set(['node_modules', '.git', '.vscode-test', 'test-output', 'build', 'target', 'bin', 'out', '.gradle', 'dist']);
const excludedSchemaNames = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const groups = {
  'file-name': 'SQL Files',
  'file-content': 'SQL File Content',
  'database-name': 'Database Object Names',
  'database-ddl': 'Live DDL Content'
};
const normalizeText = text => text.replace(/\r\n?/g, '\n');

function scopedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && !relative.split(path.sep).some(part => part === '..' || excludedNames.has(part));
}

async function localFile(file, boundaries) {
  const root = boundaries.find(item => scopedPath(item.input, file));
  if (!root || !/\.sql$/i.test(file)) throw Error('The SQL file is outside the selected workspace roots.');
  const real = await fs.realpath(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !scopedPath(root.real, real)) {
    throw Error('The SQL file or one of its parent paths leaves the selected workspace.');
  }
  return { real, stat };
}

function decode(bytes) {
  const marker = bytes.subarray(0, 2).toString('hex');
  const encoding = marker === 'fffe' ? 'utf-16le' : marker === 'feff' ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw Error('The SQL file is not supported text.');
  return normalizeText(text);
}

async function readSource(vscode, uri, item) {
  if (item.stat.size > limits.fileBytes) throw Error('The SQL file exceeds 256 KiB.');
  const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
  if (open) {
    const text = open.getText();
    const bytes = Buffer.byteLength(text);
    if (bytes > limits.fileBytes || text.includes('\0')) throw Error('The SQL editor buffer exceeds the search limits.');
    return { text: normalizeText(text), bytes };
  }
  const handle = await fs.open(item.real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== item.stat.ino || stat.dev !== item.stat.dev || stat.size > limits.fileBytes) {
      throw Error('The SQL file changed before it could be searched.');
    }
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw Error('The SQL file changed while it was being searched.');
    return { text: decode(buffer.subarray(0, bytesRead)), bytes: bytesRead };
  } finally { await handle.close(); }
}

async function searchWorkspaceFiles(vscode, roots, term, guard, token) {
  const inventory = new Map();
  const coverage = { roots: roots.map(root => root.input), filesSearched: 0, totalBytes: 0,
    fileCountLimited: false, bytesLimited: false, extraMatches: false, extraResults: 0, unreadFiles: 0, inventoryFailures: 0 };
  for (const root of roots) {
    guard();
    if (inventory.size > limits.files) { coverage.fileCountLimited = true; break; }
    try {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(root.input), '**/*.{sql,SQL}');
      const files = await vscode.workspace.findFiles(pattern, excluded, limits.files + 1, token);
      for (const uri of files) if (uri.scheme === 'file' && scopedPath(root.input, uri.fsPath)) inventory.set(uri.toString(), uri);
      if (files.length > limits.files || inventory.size > limits.files) coverage.fileCountLimited = true;
    } catch { guard(); coverage.inventoryFailures++; }
  }
  const names = [], content = [], extra = { count: 0 };
  const files = [...inventory.values()].sort((left, right) => left.toString().localeCompare(right.toString()));
  for (const uri of files.slice(0, limits.files)) {
    guard();
    try {
      const file = await localFile(uri.fsPath, roots);
      const relative = vscode.workspace.asRelativePath(uri, true);
      const identity = { uri: uri.toString(), label: path.basename(uri.fsPath), relative, real: file.real };
      if (matches(relative, term, 1).found.length) pushLimited(names, extra, { type: 'file-name', ...identity });
      if (coverage.totalBytes >= limits.totalFileBytes) { coverage.bytesLimited = true; continue; }
      const { text, bytes } = await readSource(vscode, uri, file);
      if (coverage.totalBytes + bytes > limits.totalFileBytes) { coverage.bytesLimited = true; continue; }
      coverage.totalBytes += bytes;
      coverage.filesSearched++;
      const { found, extra: more } = matches(text, term);
      if (more) coverage.extraMatches = true;
      if (found.length) {
        const hash = textHash(text);
        for (const span of found) pushLimited(content, extra, { type: 'file-content', ...identity, ...span, hash });
      }
    } catch { guard(); coverage.unreadFiles++; }
  }
  coverage.extraResults = extra.count;
  return { names, content, coverage };
}

function rangeFor(vscode, text, start, end) {
  function position(offset) {
    const before = text.slice(0, offset);
    const lines = before.split('\n');
    return new vscode.Position(lines.length - 1, lines.at(-1).length);
  }
  return new vscode.Range(position(start), position(end));
}

function coverageNarrative(report) {
  const { files, database } = report.coverage;
  const lines = ['Unified Search · Coverage', '',
    `Local SQL files searched · ${files.filesSearched} · ${files.totalBytes} bytes`,
    `Skipped or unavailable local files · ${files.unreadFiles}`,
    ...files.roots.map(root => 'Workspace root · ' + root)];
  if (files.inventoryFailures) lines.push('Unable to list files for ' + files.inventoryFailures + ' roots.');
  if (files.fileCountLimited || files.bytesLimited || files.extraMatches || files.extraResults) lines.push('The local file or result budget was reached.');
  if (database) {
    lines.push('', `Database · ${database.dialect} · ${database.scopes.join(', ') || 'no visible selected schemas'}`,
      'The search can see only objects visible to the connected account.',
      `Readable DDL definitions searched · ${database.inspectedDefinitions} · ${database.totalDefinitionBytes} bytes`);
    if (database.unavailableSchemas.length) lines.push('Unavailable schemas · ' + database.unavailableSchemas.join(', '));
    if (database.sourceSkipped) lines.push('DDL content was disabled for this search.');
    if (database.inventoryLimited || database.namesLimited || database.timeLimited || database.sizeLimited || database.sourceLimited ||
        database.extraResults || database.unsupportedNames) lines.push('A database inventory, DDL or result limit affected coverage.');
    for (const item of database.unreadDefinitions) lines.push('Unread definition · ' + qualified(item.object) +
      ' · ' + item.object.kind + ' · ' + item.reason);
  } else lines.push('', report.coverage.databaseNote);
  lines.push('', 'Limits · 250 local SQL files, 256 KiB per file, 8 MiB total file content · 8 schemas, up to 120 DDL definitions, 4 MiB total DDL · 3 matches per source and 150 per result group.');
  return lines.join('\n');
}

function registerUnifiedSearch(context, vscode, { database, objectSources, schemaCatalog }) {
  const reports = new Map();
  let generation = 0, disposed = false, searching = false;

  function guard(token, frame) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust this workspace before searching SQL sources.');
    if (token?.isCancellationRequested) throw Error('Unified search was cancelled.');
    if (frame !== undefined && generation !== frame) throw Error('The active database changed. Search again.');
  }

  async function rootsFor(values) {
    const workspace = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    const folders = await Promise.all(workspace.map(async item => ({ input: item.uri.fsPath, real: await fs.realpath(item.uri.fsPath).catch(() => null) })));
    const requested = values ?? folders.map(item => item.input);
    if (!Array.isArray(requested) || requested.length > 20) throw Error('Choose at most 20 local SQL search roots.');
    const roots = [];
    for (const candidate of new Set(requested)) {
      const boundary = typeof candidate === 'string' && path.isAbsolute(candidate) &&
        folders.find(item => item.real && scopedPath(item.input, candidate));
      const real = boundary && await fs.realpath(candidate).catch(() => null);
      if (!real || !scopedPath(boundary.real, real) || !(await fs.stat(real).catch(() => null))?.isDirectory()) {
        if (values) throw Error('The SQL search roots must stay inside the open local workspace.');
        continue;
      }
      roots.push({ input: candidate, real });
    }
    return roots;
  }

  async function search(request = {}, token) {
    const term = normalizeTerm(request.term);
    const live = request.database !== false && database.liveCatalogSnapshot();
    const frame = live ? generation : undefined;
    guard(token, frame);
    const roots = await rootsFor(request.roots);
    const assertCurrent = () => guard(token, frame);
    const pendingDb = live ? Promise.resolve().then(() => objectSources.search({ term, schemas: request.schemas,
      includeDdl: request.includeDdl }, assertCurrent)) : Promise.resolve(null);
    const [files, dbResult] = await Promise.all([searchWorkspaceFiles(vscode, roots, term, assertCurrent, token),
      pendingDb.then(value => ({ value }), () => ({ error: 'Live database search did not finish. The local results remain available.' }))]);
    assertCurrent();
    const db = dbResult.value;
    const id = randomUUID();
    const report = { id, term, results: [...files.names, ...files.content, ...(db?.names ?? []), ...(db?.ddl ?? [])],
      coverage: { files: files.coverage, database: db?.coverage ?? null,
        databaseNote: dbResult.error ?? (request.database === false ? 'Workspace-only search selected.' : 'No live MySQL or MariaDB catalog is available.') } };
    while (reports.size >= 4) reports.delete(reports.keys().next().value);
    reports.set(id, { report, frame, roots });
    return structuredClone(report);
  }

  async function open(id, index) {
    const observed = reports.get(id);
    const result = observed?.report.results[index];
    if (!result) throw Error('Choose a result from the current search.');
    if (result.type === 'database-name' || result.type === 'database-ddl') {
      guard(undefined, observed.frame);
      return objectSources.openSearchResult(result);
    }
    guard();
    const uri = vscode.Uri.parse(result.uri, true);
    const file = await localFile(uri.fsPath, await rootsFor(observed.roots.map(root => root.input)));
    if (file.real !== result.real) throw Error('The SQL file path changed. Search again.');
    const document = await vscode.workspace.openTextDocument(uri);
    const text = normalizeText(document.getText());
    const selection = result.type === 'file-content' && rangeFor(vscode, text, result.start, result.end);
    if (selection && textHash(text) !== result.hash) throw Error('The SQL file changed. Search again.');
    guard();
    await vscode.window.showTextDocument(document, { preview: false, ...(selection && { selection }) });
    return { uri: uri.toString(), selection };
  }

  async function pickSchemas(frame) {
    const schemas = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      guard(undefined, frame);
      const visible = await objectSources.listSchemas({ after });
      schemas.push(...visible.items.filter(item => !excludedSchemaNames.has(item.name.toLowerCase())).map(item => item.name));
      if (!visible.next) break;
      after = visible.next;
    }
    guard(undefined, frame);
    const catalogSchemas = new Set(schemaCatalog?.selection()?.schemas.slice(0, limits.schemas) ?? []);
    const choices = schemas.map(label => ({ label, picked: catalogSchemas.has(label) }));
    const selection = await vscode.window.showQuickPick(choices, {
      title: 'Choose Up to Eight Account-Visible Schemas', placeHolder: 'Narrow the search to selected schemas', canPickMany: true });
    guard(undefined, frame);
    if (selection?.length > limits.schemas) throw Error('Choose up to eight visible schemas.');
    return selection?.map(item => item.label);
  }

  async function interactive() {
    if (searching) return;
    searching = true;
    try {
      guard();
      const term = await vscode.window.showInputBox({ title: 'Search SQL Files, Database Objects and DDL',
        prompt: 'Enter a literal name or text fragment', validateInput: value => {
          try { normalizeTerm(value); } catch (error) { return error.message; }
        } });
      if (term === undefined) return;
      guard();
      const frame = generation;
      const live = database.liveCatalogSnapshot();
      const active = { label: 'Workspace SQL and ' + live?.database, mode: 'active' };
      const choices = live ? [active, { label: 'Workspace SQL and selected schemas…', mode: 'schemas' },
        { label: 'Workspace SQL and database names only', mode: 'names' }, { label: 'Workspace SQL only', mode: 'files' }] : null;
      const scope = choices && await vscode.window.showQuickPick(choices, { title: 'Search Scope' });
      if (choices && !scope) return;
      guard(undefined, live ? frame : undefined);
      const schemas = scope?.mode === 'schemas' ? await pickSchemas(frame) : undefined;
      if (scope?.mode === 'schemas' && !schemas?.length) return;
      const report = await vscode.window.withProgress({ title: 'Searching SQL sources', location: vscode.ProgressLocation.Notification,
        cancellable: true }, (_progress, token) => search({ term, schemas, database: scope?.mode === 'files' ? false : undefined,
        includeDdl: scope?.mode !== 'names' }, token));
      for (;;) {
        const items = [];
        for (const [type, label] of Object.entries(groups)) {
          const found = report.results.map((result, index) => ({ result, index })).filter(item => item.result.type === type);
          if (!found.length) continue;
          items.push({ label, kind: vscode.QuickPickItemKind.Separator });
          for (const { result, index } of found) items.push({ label: result.label, description: result.object?.kind ?? result.relative,
            detail: result.snippet, index });
        }
        items.push({ label: 'Show Search Coverage', detail: report.results.length + ' matches displayed', coverage: true });
        const choice = await vscode.window.showQuickPick(items, { title: 'Unified SQL Search · ' + report.term, matchOnDescription: true });
        if (!choice) return report;
        if (!choice.coverage) { await open(report.id, choice.index); return report; }
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: coverageNarrative(report) });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    } finally { searching = false; }
  }

  context.subscriptions.push(database.onDidChangeDatabase(() => { generation++; }),
    vscode.commands.registerCommand('rocketbrain.db.searchSources', async () => {
      try { return await interactive(); }
      catch (error) { if (!disposed && !/was cancelled\./.test(error.message)) void vscode.window.showErrorMessage('Rocketbrain Search: ' + error.message); }
    }), { dispose() { disposed = true; reports.clear(); } });
  return { search, open };
}

module.exports = { registerUnifiedSearch, searchWorkspaceFiles, coverageNarrative };
