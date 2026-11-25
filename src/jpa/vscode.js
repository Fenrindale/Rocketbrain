'use strict';

const path = require('node:path');
const { analyzeJPA, completionsAt, definitionsAt, compareCatalog } = require('./model');

function registerJPAFeatures(context, vscode, { catalog, output } = {}) {
  const channel = output || vscode.window.createOutputChannel('Rocketbrain JPA');
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-jpa');
  const catalogDiagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-jpa-catalog');
  const events = new vscode.EventEmitter();
  const subscriptions = [diagnostics, catalogDiagnostics, events];
  if (!output) subscriptions.push(channel);
  let model, pending, comparison, dirty = true, revision = 0, catalogEpoch = 0, catalogRequest = 0, disposed = false, timer;
  const config = () => vscode.workspace.getConfiguration('rocketbrain.jpa');
  const observer = require('./observer-vscode').registerObserver(context,vscode,channel,{source:()=>snapshot()});
  let providerSnapshotKey='';
  subscriptions.push(observer,observer.onDidChange(value=>{const key=value.state+':'+value.fetchedAt;if(key!==providerSnapshotKey){providerSnapshotKey=key;invalidate();}else events.fire();}));
  const relationshipDiagram=require('./relationship-diagram-vscode').registerRelationshipDiagram(vscode,context,{
    source:()=>snapshot(),revision:()=>revision,getObserver:observer.snapshot,refreshObserver:observer.refresh,onChange:events.event
  });
  subscriptions.push(relationshipDiagram);
  const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
  function publish(items, collection, source) {
    collection.clear();
    if (!config().get('diagnostics.enabled', true)) return;
    const groups = new Map();
    for (const issue of items || []) {
      if (!issue.uri || !issue.range) continue;
      const severity = issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : issue.severity === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
      const item = new vscode.Diagnostic(range(issue.range), issue.message || issue.reason || issue.code || 'JPA analysis finding', severity);
      item.source = source; item.code = issue.code;
      if (!groups.has(issue.uri)) groups.set(issue.uri, []);
      groups.get(issue.uri).push(item);
    }
    for (const [uri, values] of groups) collection.set(vscode.Uri.parse(uri), values);
  }
  function invalidateCatalog() { catalogEpoch++; comparison = undefined; catalogDiagnostics.clear(); if (!disposed) events.fire(); }
  async function readSources() {
    const exclude='**/{node_modules,.git,.idea,target,build,bin,out,.gradle,.vscode-test,test-output}/**';
    const uris = await vscode.workspace.findFiles('**/*.java', exclude, 2001);
    const files = [], mappingFiles = [], issues = []; let mappingFilesComplete=true;
    if (uris.length > 2000) issues.push({ message: 'JPA source index capped at 2000 Java files.' });
    let bytes = 0;
    for (const uri of uris.slice(0, 2000)) {
      try {
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        const size = open ? Buffer.byteLength(open.getText(), 'utf8') : (await vscode.workspace.fs.stat(uri)).size;
        if (size > 1024 * 1024 || bytes + size > 20 * 1024 * 1024) { issues.push({ uri: uri.toString(), message: 'A source file exceeded JPA index size limits and was omitted.' }); continue; }
        const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        bytes += size; files.push({ uri: uri.toString(), text });
      } catch { issues.push({ uri: uri.toString(), message: 'A JPA source file could not be read.' }); }
    }
    let mappingUris=[];
    const configured=config().get('mappingFiles',[]);
    if(Array.isArray(configured)&&configured.length){
      for(const value of configured.slice(0,40)){
        if(typeof value!=='string'||!value.trim()||value.includes('\0')||/^\\\\/.test(value)) {issues.push({message:'An ORM mapping file setting is not a local workspace path.'});mappingFilesComplete=false;continue;}
        const candidates=path.isAbsolute(value)?[vscode.Uri.file(value)]:(vscode.workspace.workspaceFolders||[]).map(folder=>vscode.Uri.file(path.resolve(folder.uri.fsPath,value)));
        for(const uri of candidates)if(uri.scheme==='file'&&vscode.workspace.getWorkspaceFolder(uri))mappingUris.push(uri);else {issues.push({message:'ORM mapping paths must stay inside a workspace folder.'});mappingFilesComplete=false;}
      }
      if(configured.length>40){issues.push({message:'ORM mapping file settings capped at 40 documents.'});mappingFilesComplete=false;}
    }else mappingUris=await vscode.workspace.findFiles('**/META-INF/orm.xml',exclude,41);
    mappingUris=[...new Map(mappingUris.map(uri=>[uri.toString(),uri])).values()];
    if(mappingUris.length>40){issues.push({message:'ORM mapping file index capped at 40 documents.'});mappingFilesComplete=false;}
    for(const uri of mappingUris.slice(0,40)){
      try{
        const open=vscode.workspace.textDocuments.find(document=>document.uri.toString()===uri.toString());
        const stat=await vscode.workspace.fs.stat(uri),size=open?Buffer.byteLength(open.getText(),'utf8'):stat.size;
        if(size>1024*1024||bytes+size>20*1024*1024||vscode.FileType?.SymbolicLink&&(stat.type&vscode.FileType.SymbolicLink))throw new Error('ORM XML size or local file limit exceeded.');
        const text=open?open.getText():Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');bytes+=size;mappingFiles.push({uri:uri.toString(),text});
      }catch{issues.push({uri:uri.toString(),message:'An ORM XML file could not be indexed; annotation defaults may be overridden.'});mappingFilesComplete=false;}
    }
    return { files, mappingFiles, mappingFilesComplete, issues };
  }
  async function snapshot() {
    if (disposed) return model || analyzeJPA([]);
    if (pending) { await pending; return dirty ? snapshot() : model; }
    if (model && !dirty) return model;
    const before = revision; dirty = false;
    pending = (async () => {
      if (!config().get('enabled', true)) { model = analyzeJPA([]); diagnostics.clear(); invalidateCatalog(); return model; }
      const source = await readSources();
      const packages = config().get('basePackages', []);
      const namingStrategy=config().get('namingStrategy',{});
      const providerProfile=require('./provider').providerProfileFromSnapshot(observer.snapshot());
      const next = analyzeJPA(source.files, { physicalNaming: config().get('physicalNaming', 'unknown'), basePackages: Array.isArray(packages) ? packages.filter(value => typeof value === 'string' && value.trim()) : [],mappingFiles:source.mappingFiles,mappingFilesComplete:source.mappingFilesComplete,namingStrategy:namingStrategy&&typeof namingStrategy==='object'&&!Array.isArray(namingStrategy)?namingStrategy:{},providerProfile });
      next.issues.push(...source.issues); next.revision = before; next.indexedAt = new Date().toISOString();
      next.sourceCoverage = { files: source.files.length, mappingFiles:source.mappingFiles.length,complete: source.issues.length === 0 };
      if (source.issues.length) next.diagnostics = next.diagnostics.map(issue => ({ ...issue, severity: 'information', message: issue.message + ' (Partial source index; verify the project scope.)' }));
      if (!disposed) {
        model = next; invalidateCatalog(); publish(model.diagnostics, diagnostics, 'Rocketbrain JPA (source model)'); events.fire();
      }
      return next;
    })();
    try { await pending; } finally { pending = undefined; if (before !== revision) dirty = true; }
    return dirty && !disposed ? snapshot() : model;
  }
  function invalidate() {
    if (disposed) return;
    revision++; dirty = true; invalidateCatalog(); clearTimeout(timer);
    timer = setTimeout(() => { void snapshot().catch(() => channel.appendLine('JPA source refresh failed.')); }, 250);
  }
  async function refresh() { revision++; dirty = true; return snapshot(); }
  async function compareConnectedCatalog() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before comparing JPA with database metadata.');
    if (typeof catalog !== 'function') throw new Error('Connect to MySQL or MariaDB before comparing JPA mappings.');
    const source = await snapshot(), epoch = catalogEpoch, requestId = ++catalogRequest;
    const observed = await catalog();
    if (!vscode.workspace.isTrusted || disposed) throw new Error('The analysis context closed or is no longer trusted.');
    if (source !== model || dirty || epoch !== catalogEpoch || requestId !== catalogRequest) throw new Error('The source, connection or comparison changed during metadata inspection. Compare again.');
    comparison = { ...compareCatalog(source, observed), observedAt: new Date().toISOString(), database: observed.database, sourceRevision: source.revision, mode: 'explicit-read-only-catalog-comparison' };
    publish(comparison.mismatches, catalogDiagnostics, 'Rocketbrain JPA (catalog comparison)'); events.fire();
    return comparison;
  }
  const selector = [{ scheme: 'file', language: 'java' },{scheme:'file',language:'xml'}];
  subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    async provideCompletionItems(document, position, token) {
      if (!config().get('enabled', true)) return [];
      const current = await snapshot(); if (token.isCancellationRequested) return [];
      return completionsAt(current, document.uri.toString(), position).map(value => {
        const item = new vscode.CompletionItem(value.label, value.kind === 'entity' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Field);
        item.detail = value.detail; item.insertText = value.insertText || value.label;
        if (value.range) item.range = range(value.range);
        return item;
      });
    }
  }, '.'));
  subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position, token) {
      if (!config().get('enabled', true)) return [];
      const current = await snapshot(); if (token.isCancellationRequested) return [];
      return definitionsAt(current, document.uri.toString(), position).filter(item => item.uri && item.range).map(item => new vscode.Location(vscode.Uri.parse(item.uri), range(item.range)));
    }
  }));
  if(vscode.languages.registerHoverProvider)subscriptions.push(vscode.languages.registerHoverProvider(selector,{
    async provideHover(document,position,token){
      if(!config().get('enabled',true))return;
      const current=await snapshot();if(token?.isCancellationRequested)return;
      const offset=document.offsetAt(position),uri=document.uri.toString();
      const query=current.queries.find(q=>q.uri===uri&&q.range&&offset>=document.offsetAt(new vscode.Position(q.range.start.line,q.range.start.character))&&offset<=document.offsetAt(new vscode.Position(q.range.end.line,q.range.end.character)));
      if(!query?.typeAnalysis)return;
      const types=query.typeAnalysis,lines=['JPQL source types: '+types.state];
      if(query.dynamicResolution?.state==='finite')lines.push('Possible query branches: '+query.dynamicResolution.alternatives+'; no runtime branch was selected.');
      const selections=types.selectionTypes||[];if(selections.length)lines.push('Results: '+selections.map(value=>value.javaType||value.kind||'unknown').join(', '));
      for(const parameter of types.parameters||[]){const symbolic=query.symbolicParameters?.find(item=>item.name===parameter.name);lines.push((symbolic?'SpEL '+(symbolic.expression||'argument'):'Parameter '+(parameter.name||'?'+parameter.position))+': '+(parameter.expectedTypes||[]).map(type=>typeof type==='string'?type:type.javaType||type.kind||'unknown').join(' / '));}
      const unknown=types.coverage?.unknown||[];if(unknown.length)lines.push('Unresolved: '+unknown.map(value=>typeof value==='string'?value:value.reason||value.message||'unsupported component').slice(0,5).join('; '));
      lines.push('Source analysis; complete provider/runtime query validity is a separate observation.');
      const markdown=new vscode.MarkdownString();markdown.appendText(lines.join('\n'));return new vscode.Hover(markdown);
    }
  }));
  const command = (name, action) => subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { return await action(); } catch (error) { channel.appendLine(error.message); await vscode.window.showErrorMessage(`Rocketbrain JPA: ${error.message}`); }
  }));
  command('rocketbrain.jpa.refresh', refresh);
  command('rocketbrain.jpa.analyze', async () => {
    const current = await snapshot(); channel.appendLine(`JPA source model: ${current.entities.length} entities, ${current.queries.length} queries, ${current.diagnostics.length} diagnostics. Unknown mappings are not catalog absence proofs.`); channel.show(true); return current;
  });
  command('rocketbrain.jpa.queryTypes',async()=>{
    const current=await snapshot(),queries=current.queries.filter(query=>query.typeAnalysis);
    const summary={totalQueries:current.queries.length,checked:queries.length,unchecked:current.queries.length-queries.length,known:queries.filter(q=>q.typeAnalysis.state==='known').length,invalid:queries.filter(q=>q.typeAnalysis.state==='invalid').length,unknown:queries.filter(q=>q.typeAnalysis.state==='unknown').length};
    channel.appendLine('JPQL source type analysis: '+JSON.stringify(summary)+'. Runtime/provider validity remains a separate observation.');channel.show(true);return {summary,queries};
  });
  command('rocketbrain.jpa.compareCatalog', async () => {
    const report = await compareConnectedCatalog(); channel.appendLine(`JPA catalog comparison: ${JSON.stringify(report.summary)}. Read-only observation at ${report.observedAt}.`); channel.show(true); return report;
  });
  command('rocketbrain.jpa.entities', async () => {
    const current = await snapshot();
    const selected = await vscode.window.showQuickPick(current.entities.map(entity => ({ label: entity.name, description: entity.fqn, detail: entity.table.physicalName || 'Physical table name unresolved', entity })), { title: 'JPA entities · source mappings', matchOnDescription: true, matchOnDetail: true });
    if (selected) await vscode.window.showTextDocument(vscode.Uri.parse(selected.entity.uri), { selection: range(selected.entity.range) });
  });
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => { if (event.document.languageId === 'java'||event.document.languageId==='xml') invalidate(); }),
    vscode.workspace.onDidCreateFiles(invalidate), vscode.workspace.onDidDeleteFiles(invalidate), vscode.workspace.onDidRenameFiles(invalidate), vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('rocketbrain.jpa')) invalidate(); }));
  void snapshot().catch(() => channel.appendLine('JPA source index could not initialize.'));
  return { snapshot, refresh, observer, relationshipDiagram, compareCatalog: compareConnectedCatalog, catalogComparison: () => comparison, invalidateCatalog, onDidChange: events.event, dispose() { disposed = true; clearTimeout(timer); for (const item of subscriptions) item.dispose(); } };
}

module.exports = { registerJPAFeatures };
