'use strict';

const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { inspectMavenResolution, printCoordinate } = require('./maven-resolution');
const { snapshotNode } = require('./maven-snapshot-cache');
const { cancelled, fail, inside } = require('./workbench-model');

const scheme = 'rocketbrain-maven-resolution';

function render(report) {
  const lines = ['Maven dependency resolution', printCoordinate(report.root),
    'Maven ' + report.mavenVersion + ' · Maven Dependency Plugin ' + report.dependencyPlugin, ''];
  if (report.snapshotCache) lines.push('Offline SNAPSHOT cache observation · ' + report.snapshotCache.observedAt,
    'Checked ' + report.snapshotCache.examined + ' of ' + report.snapshotCache.selected + ' selected snapshots.', '');
  const offsets = new Map();
  for (const node of report.nodes) {
    offsets.set(node.id, lines.length);
    const label = node.state === 'selected' ? 'selected' : 'omitted · ' + node.reason;
    const winner = node.winnerId && report.nodes[node.winnerId - 1];
    lines.push('  '.repeat(node.depth) + printCoordinate(node) + ' [' + label + ']' + (node.note ? ' · ' + node.note : '') +
      (winner ? ' · selected ' + printCoordinate(winner) : ''));
    const cache = node.snapshotCache;
    if (!cache) continue;
    const indent = '  '.repeat(node.depth + 1);
    if (cache.state === 'unavailable') lines.push(indent + cache.reason);
    else {
      lines.push(indent + cache.fileName + ' · SHA-256 ' + cache.sha256);
      if (cache.origin === 'timestamped-cache-match') {
        lines.push(indent + 'Cache metadata matches ' + cache.resolvedVersion + ' · repository ID ' + cache.repositoryId);
      } else {
        const note = { 'local-marker': 'Maven recorded a local-install marker.',
          ambiguous: 'Multiple cache metadata records match these bytes.',
          unavailable: 'No timestamped cache metadata matched these bytes.' };
        lines.push(indent + note[cache.origin]);
      }
    }
  }
  return { text: lines.join('\n') + '\n', offsets };
}

function pomAnchor(report, node, kind) {
  const expected = kind || (node.managedFrom ? 'managed' : 'direct');
  const local = node.pomAnchors?.find(anchor => anchor.kind === expected);
  if (local) return local;
  if (expected !== 'direct') return undefined;
  let parent = node;
  while (parent.parentId) parent = report.nodes[parent.parentId - 1];
  const ancestor = parent.pomAnchors?.find(anchor => anchor.kind === 'direct');
  return ancestor && { ...ancestor, kind: parent === node ? 'direct' : 'path-origin' };
}

function registerMavenResolution(vscode, { trusted, ensureProject, getTools, generation, chooseProject }) {
  const records = new Map();
  let ongoing, disposed = false;
  const provider = vscode.workspace.registerTextDocumentContentProvider?.(scheme, {
    provideTextDocumentContent(uri) {
      return records.get(uri.path.split('/')[1])?.rendered.text || 'This Maven resolution report expired.';
    }
  });

  function check() {
    trusted();
    if (disposed) throw fail('Maven dependency resolution is closed.');
  }

  async function inspect(options = {}) {
    check();
    if (options.allowProjectExecution !== true) throw fail('Choose Inspect Maven Dependency Resolution before executing project code.');
    if (ongoing) throw fail('Finish the current Maven dependency inspection first.');
    if (cancelled(options.cancellation)) throw fail('Maven dependency inspection was cancelled.');
    const abort = new AbortController(), ticket = generation();
    let subscription;
    const stop = () => abort.abort();
    if (options.cancellation?.onCancellationRequested) subscription = options.cancellation.onCancellationRequested(stop);
    else if (options.cancellation?.addEventListener) {
      options.cancellation.addEventListener('abort', stop, { once: true });
      subscription = { dispose: () => options.cancellation.removeEventListener('abort', stop) };
    }
    if (cancelled(options.cancellation)) abort.abort();
    const operation = (async () => {
      const project = await ensureProject(options.projectUri || options.projectId);
      const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(project.uri));
      if (!scope || project.tool !== 'maven') throw fail('Choose an imported Maven project in the workspace.');
      const tools = getTools(project);
      const guard = () => {
        check();
        if (ticket !== generation() || JSON.stringify(tools) !== JSON.stringify(getTools(project))) {
          throw fail('The Maven project or configured runtime changed. Inspect resolution again.');
        }
      };
      const dirty = file => vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' &&
        !document.isClosed && document.isDirty && !path.relative(file, document.uri.fsPath));
      const observed = await inspectMavenResolution({ project, tools, workspaceRoot: scope.uri.fsPath, trusted: guard,
        dirty, allowProjectExecution: true, cancellation: abort.signal, snapshotRepository: options.snapshotRepository });
      guard();
      const { validate, validateSnapshot, ...found } = observed, id = randomUUID();
      const report = { ...found, id, projectUri: project.uri };
      while (records.size >= 6) records.delete(records.keys().next().value);
      records.set(id, { report, validate, validateSnapshot, rendered: render(report) });
      return structuredClone(report);
    })();
    ongoing = { abort, operation };
    try { return await operation; }
    finally { subscription?.dispose(); if (ongoing?.operation === operation) ongoing = undefined; }
  }

  function record(id) {
    check();
    const result = records.get(id);
    if (!result) throw fail('Inspect the Maven dependencies again to refresh this report.');
    return result;
  }

  async function showReport(id, nodeId) {
    const entry = record(id);
    const uri = vscode.Uri.parse(scheme + ':/' + id + '/dependencies.txt');
    const line = entry.rendered.offsets.get(nodeId);
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: true, ...(line !== undefined && { selection: new vscode.Range(line, 0, line, 0) })
    });
  }

  async function openPom(id, nodeId, kind) {
    const entry = record(id), node = entry.report.nodes[nodeId - 1];
    if (!node) throw fail('Choose a current Maven dependency path.');
    const link = pomAnchor(entry.report, node, kind);
    if (!link) throw fail('This path has no exact declaration in an observed local POM.');
    await entry.validate();
    const uri = vscode.Uri.parse(link.uri), document = await vscode.workspace.openTextDocument(uri);
    await entry.validate();
    const { start, end } = link.range;
    await vscode.window.showTextDocument(document, {
      preview: true, selection: new vscode.Range(start.line, start.character, end.line, end.character)
    });
    return structuredClone(link);
  }

  async function verifySnapshot(id, nodeId) {
    const entry = record(id);
    if (!entry.validateSnapshot) throw fail('Inspect the selected Maven snapshot cache before verifying its evidence.');
    await entry.validate();
    return entry.validateSnapshot(nodeId);
  }

  async function command(arg) {
    const project = await chooseProject(arg);
    if (!project) return;
    const getReport = (snapshotRepository) => vscode.window.withProgress({ title: 'Inspect Maven Dependency Resolution',
      location: vscode.ProgressLocation.Notification, cancellable: true }, (_progress, cancellation) =>
      inspect({ projectUri: project.uri, allowProjectExecution: true, cancellation, snapshotRepository }));
    const report = await getReport();
    const noteworthy = report.nodes.filter(node => node.state !== 'selected' || node.managedFrom);
    const picked = await vscode.window.showQuickPick([
      { label: 'Open Dependency Tree', description: report.nodes.length + ' paths', action: 'tree' },
      ...(report.nodes.some(snapshotNode) ? [{ label: 'Inspect Cached SNAPSHOT Artifacts',
        description: 'Select the local repository used by Maven', action: 'snapshot' }] : []),
      ...noteworthy.map(node => ({ label: node.group + ':' + node.artifact + ':' + node.version,
        description: node.reason ? 'omitted · ' + node.reason : 'managed from ' + node.managedFrom,
        detail: node.parentId ? 'via ' + printCoordinate(report.nodes[node.parentId - 1]) : 'direct dependency', node }))
    ], { title: 'Maven Dependency Resolution', matchOnDetail: true, matchOnDescription: true });
    if (!picked) return report;
    if (picked.action === 'snapshot') {
      const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
        canSelectMany: false, defaultUri: vscode.Uri.file(path.join(os.homedir(), '.m2', 'repository')),
        title: 'Select the Maven Local Repository', openLabel: 'Inspect Offline' });
      if (folders?.length) return showReport((await getReport(folders[0].fsPath)).id);
      return report;
    }
    if (picked.action) return showReport(report.id);
    const node = picked.node, winner = node.winnerId && report.nodes[node.winnerId - 1];
    const actions = [{ label: 'Reveal Dependency Path', run: () => showReport(report.id, node.id) }];
    if (winner) actions.push({ label: 'Reveal Selected Path', run: () => showReport(report.id, winner.id) });
    if (pomAnchor(report, node)) actions.push({ label: 'Open POM Declaration', run: () => openPom(report.id, node.id) });
    if (winner && pomAnchor(report, winner)) actions.push({ label: 'Open Selected POM Declaration',
      run: () => openPom(report.id, winner.id) });
    const action = await vscode.window.showQuickPick(actions, { title: printCoordinate(node) });
    return action && action.run();
  }

  return { inspect, command, showReport, openPom, verifySnapshot, cancel() { ongoing?.abort.abort(); },
    async dispose() { disposed = true; ongoing?.abort.abort(); await ongoing?.operation.catch(() => {});
      records.clear(); provider?.dispose(); } };
}

module.exports = { registerMavenResolution, pomAnchor, render };
