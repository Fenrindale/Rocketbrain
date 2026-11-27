'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeSpring, definitionsAt } = require('./model');
const { registerBeanGraph } = require('./bean-graph-vscode');
const { registerAutowiringFix } = require('./autowiring-fix-vscode');
const { isPlainQualifiedCall } = require('../java/definition-position');

function registerSemanticSpring(vscode, context, output) {
  const subscriptions = [], diagnosticCollection = vscode.languages.createDiagnosticCollection('rocketbrain-spring');
  subscriptions.push(diagnosticCollection);
  let model = null, dirty = true, pending = null, revision = 0, timer, disposed = false;
  const graphSourceHashes = new WeakMap(), analysisInputs = new WeakMap();
  const digest = value => createHash('sha256').update(value).digest('hex');
  const configuration = () => vscode.workspace.getConfiguration('rocketbrain.spring');
  const enabled = () => configuration().get('enabled', true);
  const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
  async function readFiles(pattern, maximum, roots = []) {
    const uris = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,.idea,target,build,.gradle,.vscode-test,test-output}/**', maximum + 1), result = [], issues = [];
    let bytes = 0;
    if (uris.length > maximum) issues.push(`Spring index capped at ${maximum} matching files.`);
    for (const uri of uris.slice(0, maximum)) {
      try {
        if (roots.length) {
          const normalize = value => process.platform === 'win32' ? decodeURIComponent(value).toLowerCase() : decodeURIComponent(value);
          const allowed = roots.flatMap(root => path.isAbsolute(root) ? [vscode.Uri.file(root)] : (vscode.workspace.workspaceFolders || []).map(folder => vscode.Uri.joinPath(folder.uri, root)));
          if (!allowed.some(root => normalize(uri.toString()).startsWith(normalize(root.toString()).replace(/\/$/, '') + '/'))) continue;
        }
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        const stat = open ? { size: Buffer.byteLength(open.getText()) } : await vscode.workspace.fs.stat(uri);
        if (stat.size > 1024 * 1024 || bytes + stat.size > 20 * 1024 * 1024) { issues.push('Spring index omitted files above its size/total limits.'); continue; }
        bytes += stat.size;
        result.push({ uri: uri.toString(), text: open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') });
      } catch (error) { issues.push(`Could not read ${vscode.workspace.asRelativePath(uri)}: ${error.message}`); }
    }
    return { files: result, issues };
  }
  function publish(current) {
    diagnosticCollection.clear();
    if (!configuration().get('diagnostics.enabled', true)) return;
    const groups = new Map();
    for (const item of current.diagnostics) {
      const diagnostic = new vscode.Diagnostic(range(item.range), item.message, item.severity === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
      diagnostic.source = 'Rocketbrain Spring (local model)'; diagnostic.code = item.code;
      if (!groups.has(item.uri)) groups.set(item.uri, []); groups.get(item.uri).push(diagnostic);
    }
    for (const [uri, items] of groups) diagnosticCollection.set(vscode.Uri.parse(uri), items);
  }
  async function analyze() {
    if (disposed) return model;
    if (pending) { await pending; return dirty ? analyze() : model; }
    if (!dirty && model) return model;
    const before = revision; dirty = false;
    pending = (async () => {
      if (!enabled()) { model = analyzeSpring([], [], {}); diagnosticCollection.clear(); return model; }
      const roots = configuration().get('configurationRoots', []).filter(value => typeof value === 'string' && value.trim());
      const [java, properties] = await Promise.all([readFiles('**/*.java', 2000), readFiles('**/application*.{properties,yml,yaml}', 300, roots)]);
      const config = configuration(), truncated = java.issues.length || properties.issues.length;
      const options={ activeProfiles: config.get('activeProfiles', []), properties: config.get('properties', {}), basePackages: config.get('basePackages', []), closedWorld: !truncated && config.get('closedWorld', false), parameterNames: config.get('parameterNames', false) };
      const result = analyzeSpring(java.files, properties.files,options);
      analysisInputs.set(result,{java:java.files,properties:properties.files,options});
      result.issues.push(...[...java.issues, ...properties.issues].map(message => ({ message })));
      result.truncated = Boolean(truncated); result.revision = before;
      const graphSources = new Set([...result.beans,...result.injections].map(item => item.uri));
      graphSourceHashes.set(result,new Map(java.files.filter(file => graphSources.has(file.uri)).map(file => [file.uri,digest(file.text)])));
      if (!disposed) { model = result; publish(model); }
      if (revision !== before) dirty = true;
      return model;
    })();
    try { return await pending; } finally { pending = null; }
  }
  function invalidate() {
    dirty = true; revision++; clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => { void analyze().catch(error => output.appendLine(`Spring analysis: ${error.message}`)); }, 400);
  }
  async function definitions(uri, position) { return definitionsAt(await analyze(), typeof uri === 'string' ? uri : uri.toString(), position); }
  subscriptions.push(vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'java' }, {
    async provideDefinition(document, position, token) {
      if (token.isCancellationRequested || isPlainQualifiedCall(document, position)) return [];
      const locations = await definitions(document.uri, position);
      return token.isCancellationRequested ? [] : locations.map(item => new vscode.Location(vscode.Uri.parse(item.uri), range(item.range)));
    }
  }));
  subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file', language: 'java' }, {
    async provideHover(document, position, token) {
      const current = await analyze(); if (token.isCancellationRequested) return null;
      const contains = item => range(item).contains(position);
      const injection = current.injections.find(item => item.uri === document.uri.toString() && [item.range, item.valueRange, item.qualifierRange].filter(Boolean).some(contains));
      if (!injection) return null;
      const resolution = injection.resolution;
      const contents = new vscode.MarkdownString(); contents.isTrusted = false;
      contents.appendText(`Spring local model · ${resolution.state}\n`);
      if (resolution.kind === 'property' && resolution.state === 'resolved') contents.appendText(`Value: ${resolution.value}\n`);
      contents.appendText(resolution.reason || 'Resolved within the configured local model.');
      if (resolution.selected?.length) contents.appendText('\nBeans: ' + resolution.selected.map(id => current.beans.find(bean => bean.id === id)?.name).join(', '));
      return new vscode.Hover(contents, range(injection.valueRange || injection.qualifierRange || injection.range));
    }
  }));
  subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query, token) { const current = await analyze(); if (token.isCancellationRequested) return []; const needle = query.replace(/^@?bean:?\s*/i, '').toLowerCase(); return current.beans.filter(bean => `${bean.name} ${bean.type}`.toLowerCase().includes(needle)).map(bean => new vscode.SymbolInformation(`Bean ${bean.name} · ${bean.state}`, vscode.SymbolKind.Object, bean.type, new vscode.Location(vscode.Uri.parse(bean.uri), range(bean.range)))); }
  }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.spring.analyze', async () => { const current = await analyze(); vscode.window.showInformationMessage(`Spring local model: ${current.beans.filter(bean => bean.state === 'active').length} active Beans, ${current.beans.filter(bean => bean.state === 'unknown').length} conditional unknown, ${current.diagnostics.length} findings.`); return current; }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.spring.refresh', async () => { invalidate(); return analyze(); }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.spring.beans', async () => {
    const current = await analyze();
    const selected = await vscode.window.showQuickPick(current.beans.map(bean => ({ label: bean.name, description: `${bean.state}${bean.primary ? ' · Primary' : ''}`, detail: `${bean.type} · ${vscode.workspace.asRelativePath(vscode.Uri.parse(bean.uri))}`, bean })), { title: 'Spring Beans · local source model', matchOnDescription: true, matchOnDetail: true });
    if (selected) await vscode.window.showTextDocument(vscode.Uri.parse(selected.bean.uri), { selection: range(selected.bean.range) });
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => { if (event.document.languageId === 'java' || /application.*\.(?:properties|ya?ml)$/.test(event.document.uri.path)) invalidate(); }), vscode.workspace.onDidCreateFiles(invalidate), vscode.workspace.onDidDeleteFiles(invalidate), vscode.workspace.onDidRenameFiles(invalidate), vscode.workspace.onDidChangeWorkspaceFolders(invalidate), vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('rocketbrain.spring')) invalidate(); }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{java,properties,yml,yaml}');
  subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
  const refresh = async () => { invalidate(); return analyze(); };
  async function qualifierInputs(projectUri) {
    const folder=vscode.Uri.parse(projectUri), current=await analyze();
    const inputs=analysisInputs.get(current);
    if (!inputs||current.truncated||!enabled()||dirty||current.revision!==revision||
        folder.scheme!=='file'||!vscode.workspace.getWorkspaceFolder(folder)) return null;
    const scopedProperties=inputs.properties.filter(file=>{
      const absolute=vscode.Uri.parse(file.uri);
      const relative=path.relative(folder.fsPath,absolute.fsPath);
      return absolute.scheme==='file'&&relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&
        !path.isAbsolute(relative)&&!/(?:^|[\\/])src[\\/](?:test|testFixtures|integrationTest)[\\/]/iu.test(relative);
    });
    // VS Code returns configuration proxies. Materialize the JSON settings before attribution.
    return {scopedProperties,options:JSON.parse(JSON.stringify(inputs.options)),
      valid:()=>!disposed&&enabled()&&!dirty&&model===current&&revision===current.revision};
  }
  const beanGraph = registerBeanGraph(vscode,{analyze,refresh,enabled,revision:() => revision,
    matchesSource:(model,uri,text) => graphSourceHashes.get(model)?.get(uri) === digest(text)});
  const autowiring=registerAutowiringFix(vscode,{analyze,refresh,enabled,inputsFor:model=>analysisInputs.get(model),output});
  subscriptions.push(beanGraph,autowiring);
  invalidate();
  return { analyze, snapshot: () => model, definitions, refresh, beanGraph,autowiring,qualifierInputs,
    dispose() { disposed = true; clearTimeout(timer); for (const item of subscriptions) item.dispose(); } };
}

module.exports = { registerSemanticSpring };
