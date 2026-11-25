'use strict';

const { workspaceDependencyGraph, localUri, check } = require('./dependency-workspace');
const { createSymbolNavigation } = require('./navigation-symbols');
const { createUsageSearch } = require('./usage-vscode');

const COMMANDS = Object.freeze({
  graph: 'rocketbrain.java.dependencyGraph',
  call: 'rocketbrain.java.callHierarchy',
  type: 'rocketbrain.java.typeHierarchy',
  symbols: 'rocketbrain.java.navigateSymbol',
  super: 'rocketbrain.java.goToSuperMethod',
  usages: 'rocketbrain.java.findUsages'
});
const HIERARCHY = {
  call: {
    prepare: 'vscode.prepareCallHierarchy', tree: 'editor.showCallHierarchy', caption: 'Java Call Hierarchy',
    directions: [
      { key: 'incoming', command: 'vscode.provideIncomingCalls', label: 'Callers' },
      { key: 'outgoing', command: 'vscode.provideOutgoingCalls', label: 'Callees' }
    ]
  },
  type: {
    prepare: 'vscode.prepareTypeHierarchy', tree: 'editor.showTypeHierarchy', caption: 'Java Type Hierarchy',
    directions: [
      { key: 'supertypes', command: 'vscode.provideSupertypes', label: 'Supertypes' },
      { key: 'subtypes', command: 'vscode.provideSubtypes', label: 'Subtypes' }
    ]
  }
};
const MAX_HIERARCHY_ROOTS = 8;
const MAX_RELATED = 250;

function position(value) {
  if (!Number.isSafeInteger(value?.line) || value.line < 0 ||
      !Number.isSafeInteger(value?.character) || value.character < 0) throw Error('The Java hierarchy provider returned an invalid location.');
  return { line: value.line, character: value.character };
}

function range(value) {
  return { start: position(value?.start), end: position(value?.end) };
}

function anchor(item) {
  if (typeof item?.name !== 'string' || !item.uri?.scheme || item.name.length > 400) {
    throw Error('The Java hierarchy provider returned an invalid item.');
  }
  return {
    name: item.name, detail: typeof item.detail === 'string' ? item.detail : '', kind: item.kind,
    uri: item.uri.toString(), range: range(item.range), selectionRange: range(item.selectionRange)
  };
}

function boundedRequest(vscode, command, args, cancellation) {
  return new Promise((resolve, reject) => {
    let settled, timer, sub;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub?.dispose();
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => finish(Error('The Java hierarchy provider took too long to respond.')), 20000);
    sub = cancellation?.onCancellationRequested?.(() => finish(Error('Java hierarchy analysis cancelled.')));
    if (cancellation?.isCancellationRequested) finish(Error('Java hierarchy analysis cancelled.'));
    else Promise.resolve().then(() => vscode.commands.executeCommand(command, ...args))
      .then(result => finish(null, result), finish);
  });
}

async function relatedItems(vscode, kind, item, direction, cancellation) {
  const values = (await boundedRequest(vscode, direction.command, [item], cancellation)) ?? [];
  if (!Array.isArray(values)) throw Error('The Java hierarchy provider returned an invalid relation set.');
  const related = values.slice(0, MAX_RELATED).map(value => {
    if (kind === 'type') return { symbol: anchor(value) };
    const symbol = anchor(direction.key === 'incoming' ? value.from : value.to);
    const sourceUri = direction.key === 'incoming' ? symbol.uri : item.uri.toString();
    const sites = Array.isArray(value.fromRanges) ? value.fromRanges : [];
    return { symbol, callSites: sites.slice(0, MAX_RELATED).map(site => ({ uri: sourceUri, range: range(site) })),
      callSiteCount: sites.length };
  });
  return { kind: direction.key, label: direction.label, total: values.length, related };
}

async function inspectHierarchy(vscode, java, { kind, uri, position: cursor, cancellation }) {
  check(vscode, cancellation);
  const node = HIERARCHY[kind];
  if (!node || !localUri(uri) || !vscode.workspace.getWorkspaceFolder(uri)) {
    throw Error('Open a Java source file in a local workspace to inspect its hierarchy.');
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.languageId !== 'java' || !cursor) throw Error('Place the cursor on a Java method or type.');
  const point = document.validatePosition(cursor);
  if (point.line !== cursor.line || point.character !== cursor.character) throw Error('The Java cursor is outside its document.');
  const originalVersion = document.version;
  const runtime = await java.start();
  if (runtime.state !== 'running') throw Error(runtime.message || 'Start the independent Java language server first.');
  check(vscode, cancellation);
  const items = (await boundedRequest(vscode, node.prepare, [uri, point], cancellation)) ?? [];
  if (!Array.isArray(items)) throw Error('The Java hierarchy provider returned invalid roots.');
  const roots = [];
  for (const item of items.slice(0, MAX_HIERARCHY_ROOTS)) {
    check(vscode, cancellation);
    const symbol = anchor(item);
    // Native hierarchy items carry a provider-owned session identity. Pass
    // the returned objects back through VS Code instead of recreating them.
    const directions = await Promise.all(node.directions.map(direction =>
      relatedItems(vscode, kind, item, direction, cancellation)));
    roots.push({ symbol, directions });
  }
  check(vscode, cancellation);
  if (document.isClosed || document.version !== originalVersion) throw Error('Java source changed during hierarchy inspection. Run it again.');
  return { kind, roots, total: items.length };
}

function registerJavaNavigation(_context, vscode, { java }) {
  let disposed = false;
  const inspect = options => inspectHierarchy(vscode, java, options);
  const analyzeDependencies = options => workspaceDependencyGraph(vscode, java, options);

  async function openSource(reference, { allowClassFile = false } = {}) {
    check(vscode);
    const uri = vscode.Uri.parse(reference.uri);
    if (!(localUri(uri) && vscode.workspace.getWorkspaceFolder(uri)) && !(allowClassFile && uri.scheme === 'jdt')) {
      throw Error('Source navigation requires an open local project or an observed JDT class file.');
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const selected = reference.range;
    const selection = selected ? doc.validateRange(new vscode.Range(
      selected.start.line, selected.start.character, selected.end.line, selected.end.character)) : undefined;
    await vscode.window.showTextDocument(doc, { selection, preview: true, preserveFocus: false });
  }

  function progress(title, work) {
    return vscode.window.withProgress({ title, cancellable: true, location: vscode.ProgressLocation.Notification },
      (_value, cancellation) => work(cancellation));
  }

  async function showHierarchyTree(kind, symbol) {
    const command = HIERARCHY[kind]?.tree;
    if (!command || !(await vscode.commands.getCommands(true)).includes(command)) {
      throw Error('The expandable hierarchy view is unavailable in this VS Code host.');
    }
    const start = symbol.selectionRange.start;
    await openSource({ uri: symbol.uri, range: { start, end: start } }, { allowClassFile: true });
    await vscode.commands.executeCommand(command);
  }

  async function chooseHierarchy(kind) {
    const editor = vscode.window.activeTextEditor;
    const caption = HIERARCHY[kind].caption;
    const report = await progress(caption, cancellation =>
      inspect({ kind, uri: editor?.document.uri, position: editor?.selection.active, cancellation }));
    if (!report.roots.length) {
      await vscode.window.showInformationMessage('Java language server did not find a hierarchy at the cursor.');
      return report;
    }
    const rootChoice = report.roots.length === 1 ? { root: report.roots[0] } :
      await vscode.window.showQuickPick(report.roots.map(root => ({ label: root.symbol.name, detail: root.symbol.detail, root })),
        { title: caption + ' · Symbol' });
    if (!rootChoice) return report;
    const { root } = rootChoice;
    const hasTree = (await vscode.commands.getCommands(true)).includes(HIERARCHY[kind].tree);
    const direction = await vscode.window.showQuickPick([
      ...(hasTree ? [{ label: 'Open Expandable Hierarchy', tree: true }] : []),
      ...root.directions.map(item => ({ label: item.label, description: String(item.total), direction: item }))
    ], { title: caption + ' · ' + root.symbol.name });
    if (!direction) return report;
    if (direction.tree) {
      await showHierarchyTree(kind, root.symbol);
      return report;
    }
    if (!direction.direction.related.length) {
      await vscode.window.showInformationMessage('Java language server found no ' + direction.label.toLowerCase() + '.');
      return report;
    }
    const relation = await vscode.window.showQuickPick(direction.direction.related.map(item => ({
      label: item.symbol.name, description: item.symbol.detail,
      detail: item.callSiteCount ? item.callSiteCount + ' source call sites' : undefined, item
    })), { title: root.symbol.name + ' · ' + direction.label });
    if (!relation) return report;
    const { symbol, callSites = [] } = relation.item;
    const definition = { uri: symbol.uri, range: symbol.selectionRange };
    let target = definition;
    if (callSites.length) {
      const chosen = await vscode.window.showQuickPick([
        { label: 'Open ' + symbol.name, reference: definition },
        ...callSites.map(site => ({ label: 'Call site · line ' + (site.range.start.line + 1), reference: site }))
      ], { title: caption + ' · Source' });
      target = chosen?.reference;
    }
    if (target) await openSource(target, { allowClassFile: true });
    return report;
  }

  function graphChoices(report) {
    return [
      ...report.layers.filter(layer => layer.nodes.length).map(layer => ({
        label: layer.name,
        description: layer.edges.length + ' dependencies · ' + layer.cycles.length + ' cycle groups',
        layer
      })),
      { label: 'Inspection details', description: report.issues.length + ' notes', notes: true }
    ];
  }

  async function snapshotNotes(report) {
    const choices = [
      { label: report.sourceFiles + ' saved Java source files', description: report.observedProjects + ' imported projects' },
      { label: report.ambiguousImports + ' imports without a unique local target' },
      ...report.issues.map(issue => ({ label: issue.message, reference: issue.directory ? undefined : issue }))
    ];
    if (report.includeCompiled) {
      choices.push({ label: report.compiledOutputs.length + ' compiled output directories',
        description: 'Compiled references describe class files on disk.' });
    }
    const item = await vscode.window.showQuickPick(choices, { title: 'Java Dependencies · Inspection Details' });
    if (item?.reference) await openSource(item.reference);
  }

  async function browseLayer(layer) {
    const nodes = new Map(layer.nodes.map(node => [node.id, node]));
    const cycleChoices = layer.cycles.map(cycle => ({
      label: cycle.members.map(id => nodes.get(id).label).join(' ↔ '), description: 'Cycle group', cycle
    }));
    const counts = new Map();
    for (const edge of layer.edges) {
      counts.set(edge.from, (counts.get(edge.from) || 0) + 1);
      counts.set(edge.to, (counts.get(edge.to) || 0) + 1);
    }
    const chosen = await vscode.window.showQuickPick([
      ...cycleChoices, ...layer.nodes.map(node => ({
        label: node.label, description: [node.project, node.sourceSet, (counts.get(node.id) || 0) + ' links'].filter(Boolean).join(' · '),
        node
      }))
    ], { title: layer.name });
    if (!chosen) return;
    const labelEdge = edge => nodes.get(edge.from).label + ' → ' + nodes.get(edge.to).label;
    if (chosen.cycle) {
      const pick = await vscode.window.showQuickPick(chosen.cycle.witness.map(edge => ({
        label: labelEdge(edge), description: edge.evidence.kind, reference: edge.evidence
      })), { title: 'Cycle · Source Links' });
      if (pick) await openSource(pick.reference);
      return;
    }
    const matches = layer.edges.filter(edge => edge.from === chosen.node.id || edge.to === chosen.node.id);
    const pick = await vscode.window.showQuickPick([
      ...(chosen.node.uri && !chosen.node.external ? [{ label: 'Open Node Source', reference: chosen.node }] : []),
      ...matches.map(edge => ({ label: labelEdge(edge), description: edge.references + ' references', edge }))
    ], { title: layer.name + ' · ' + chosen.node.label });
    if (!pick) return;
    if (pick.reference) await openSource(pick.reference);
    else {
      const link = await vscode.window.showQuickPick(pick.edge.evidence.map(reference => ({
        label: reference.symbol, description: reference.kind,
        detail: reference.uri && vscode.Uri.parse(reference.uri).fsPath, reference
      })), { title: labelEdge(pick.edge) });
      if (link) await openSource(link.reference);
    }
  }

  async function showDependencies() {
    const selected = await vscode.window.showQuickPick([
      { label: 'Saved source and build declarations', includeCompiled: false },
      { label: 'Include compiled package references', description: 'Inspect built class files with the configured JDK', includeCompiled: true }
    ], { title: 'Java Dependencies' });
    if (!selected) return;
    const report = await progress('Java Dependencies', cancellation =>
      analyzeDependencies({ includeCompiled: selected.includeCompiled, cancellation }));
    const choice = await vscode.window.showQuickPick(graphChoices(report), { title: 'Java Dependencies' });
    if (choice?.notes) await snapshotNotes(report);
    if (choice?.layer) await browseLayer(choice.layer);
    return report;
  }

  function register(name, operation) {
    return vscode.commands.registerCommand(name, async () => {
      try {
        if (disposed) return;
        check(vscode);
        return await operation();
      } catch (error) {
        void vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message);
        return null;
      }
    });
  }
  const symbols = createSymbolNavigation(vscode,java,progress);
  const usages = createUsageSearch(vscode,java,progress);
  const subscriptions = [
    register(COMMANDS.graph, showDependencies),
    register(COMMANDS.call, () => chooseHierarchy('call')),
    register(COMMANDS.type, () => chooseHierarchy('type')),
    register(COMMANDS.symbols, () => symbols.choose()),
    register(COMMANDS.super, () => symbols.choose('super')),
    register(COMMANDS.usages, () => usages.choose())
  ];
  return {
    analyzeDependencies, inspectHierarchy: inspect, openSource, showHierarchyTree,
    inspectSymbol: symbols.inspect, revealSymbol: symbols.reveal,findUsages:usages.inspect,revealUsage:usages.reveal,
    dispose() {
      if (disposed) return;
      disposed = true;
      symbols.dispose();
      usages.dispose();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

module.exports = { registerJavaNavigation, inspectHierarchy, COMMANDS };
