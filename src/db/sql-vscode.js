'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fileURLToPath}=require('node:url');
const { inspectDmlScope } = require('./sql-dml-scope');
const { isProfileConsole: isVirtualProfileConsole } = require('./profile-console-files');
const { createOverlayStore, overlayScope, buildOverlay } = require('./virtual-schema-overlays');
const { callCompletions, callSignature } = require('./sql-call-completion');
const { sqlEditorForAction } = require('./sql-editor-target');
const overlaySourceScheme='rocketbrain-virtual-schema-source';

function registerSQLAnalysis(context,vscode,{catalog,catalogSnapshot,onDidChangeDatabase,output,joinCatalog,joinLogicalRelationships,objectDefinition,objectColumnOrigin,liveCatalogIdentity,
  isProfileConsole=isVirtualProfileConsole,onDidChangeSqlFileProfile}={}) {
  const collection=vscode.languages.createDiagnosticCollection('rocketbrain-sql');
  const events=new vscode.EventEmitter(),subscriptions=[collection,events];
  let metadata=catalogSnapshot?.()||null,epoch=0,request=0,disposed=false;
  const cache=new Map(),preparedRenames=new Map(),projectPlans=new Map(),ddlPreviews=new Map();let projectGeneration=0,lastProjectReport=null;
  const overlays=context.workspaceState&&createOverlayStore(context.workspaceState,()=>!disposed&&vscode.workspace.isTrusted);
  const resolutionScopes=require('./sql-resolution-scopes');
  const scopeCache=new Map();
  const navigationCache=new Map();
  const columnOrigins=new Map();
  const engine=()=>require('./sql-analysis');
  const config=()=>vscode.workspace.getConfiguration('rocketbrain.sql.analysis');
  function invalidate(){epoch++;request++;metadata=null;lastProjectReport=null;cache.clear();navigationCache.clear();columnOrigins.clear();collection.clear();if(!disposed)events.fire();}
  function options(){return {dialect:metadata?.dialect||'mysql',database:metadata?.database,serverVersion:metadata?.serverVersion,catalogComplete:Boolean(metadata?.coverage?.tables==='loaded'&&metadata?.coverage?.columns==='loaded'),tableNameCaseSensitive:metadata?.tableNameCaseSensitive,sqlMode:metadata?.sqlMode};}
  function configuredScope(document){
    if(!vscode.workspace.isTrusted||document.uri.scheme!=='file')return null;
    const folder=vscode.workspace.getWorkspaceFolder?.(document.uri);
    if(folder?.uri.scheme!=='file')return null;
    const rules=vscode.workspace.getConfiguration('rocketbrain.sql.analysis',document.uri).get('resolutionScopes',[]);
    const rule=resolutionScopes.selectScope(folder.uri.fsPath,document.uri.fsPath,rules);
    return rule&&{folder:folder.uri.fsPath,rule};
  }
  const analysisOnly=document=>Boolean(document&&(document.uri.scheme===overlaySourceScheme||
    ddlPreviews.get(document.uri.toString())?.type==='overlay'));
  const virtualActive=document=>analysisOnly(document)||ddlPreviews.has(document.uri.toString())||
    vscode.workspace.isTrusted&&Boolean(configuredScope(document));
  function dmlDiagnostics(document, text, parts, sqlMode) {
    return parts.slice(0, 100).flatMap(part => {
      let scope;
      try { scope = inspectDmlScope(text.slice(part.start, part.end), part.sqlMode??sqlMode); }
      catch { return []; }
      if (!scope || scope.hasWhere) return [];
      const range = new vscode.Range(document.positionAt(part.start + scope.start), document.positionAt(part.start + scope.end));
      const item = new vscode.Diagnostic(range, scope.command + ' has no outer WHERE clause.' +
        (scope.hasLimit ? ' LIMIT constrains rows but does not select them by predicate.' : ' It may affect every target row.'),
      vscode.DiagnosticSeverity.Warning);
      item.source = 'Rocketbrain SQL';
      item.code = 'sql.dml.noWhere';
      return [item];
    });
  }
  function analyzeDocument(document){
    if(disposed||!config().get('enabled',true)||document.languageId!=='sql')return {state:'disabled',statements:[]};
    if(isProfileConsole(document)||require('./federated-select').isFederatedDocument(document)){collection.delete(document.uri);return {state:'disabled',statements:[]};}
    const key=document.uri.toString(),previous=cache.get(key),trusted=vscode.workspace.isTrusted;
    if(document.uri.scheme===overlaySourceScheme){
      collection.delete(document.uri);
      return {state:'unknown',reason:'virtual-schema-source',virtualPreview:true,statements:[],executedSql:false};
    }
    let preview=vscode.workspace.isTrusted?ddlPreviews.get(key):null;
    if(ddlPreviews.get(key)?.type==='overlay'&&(!preview||!overlayCurrent(preview))){
      const diagnostic=new vscode.Diagnostic(new vscode.Range(0,0,0,0),
        'Reapply this saved virtual schema to the editor or exit the preview. The catalog or saved definition changed.',
        vscode.DiagnosticSeverity.Information);
      diagnostic.code='sql.virtual.overlay.stale';diagnostic.source='Rocketbrain SQL (saved virtual schema)';
      collection.set(document.uri,[diagnostic]);
      return {state:'unknown',reason:'virtual-schema-stale',virtualPreview:true,statements:[],executedSql:false};
    }
    const configured=preview?null:configuredScope(document);
    if(configured){
      try{preview=resolutionScopes.loadScope(configured.folder,configured.rule,scopeCache);}
      catch(error){
        const diagnostic=new vscode.Diagnostic(new vscode.Range(0,0,0,0),
          error.code==='ENOENT'?'The configured DDL catalog could not be opened.':error.message,
          vscode.DiagnosticSeverity.Information);
        diagnostic.code='sql.scope.unavailable';diagnostic.source='Rocketbrain SQL (resolution scope)';
        collection.set(document.uri,[diagnostic]);
        return {state:'unknown',reason:'configured-catalog-unavailable',virtualPreview:true,statements:[],executedSql:false};
      }
    }
    const seed=preview?.model??metadata;
    if(previous?.version===document.version&&previous.epoch===epoch&&previous.preview===preview&&previous.trusted===trusted)return previous.value;
    const text=document.getText(),opts=options();
    let statements=[];
    if(Buffer.byteLength(text)>128*1024){collection.set(document.uri,[new vscode.Diagnostic(new vscode.Range(0,0,0,0),'SQL analysis is limited to 128 KiB per document.',vscode.DiagnosticSeverity.Information)]);return {state:'unknown',reason:'document-size-limit',statements:[]};}
    if (!seed) {
      const parts = engine().statementRanges(text, opts).statements;
      collection.set(document.uri, dmlDiagnostics(document, text, parts, undefined));
      return { state:'not-connected', statements:[] };
    }
    const ddlModel=require('./ddl-model');
    const observeLocalModes=vscode.workspace.isTrusted&&ddlModel.scriptCatalogSupported(seed);
    const split=preview?null:engine().statementRanges(text,{...opts,documentSqlModes:observeLocalModes});
    const virtual=preview?ddlModel.analyzeDdlScript(text,seed):null;
    const automatic=!preview&&vscode.workspace.isTrusted?ddlModel.analyzeLiveDdlScript(text,seed,split):null;
    const parts=split?.statements||[];
    let contextChanged=false;
    statements=virtual?.statements||automatic?.statements||parts.slice(0,100).map(part=>{
      const priorContextChange=contextChanged;
      const source=text.slice(part.start,part.end),model=engine().analyzeSql(source,contextChanged?{tables:[],views:[],complete:false}:metadata,contextChanged?{...opts,catalogComplete:false,sqlMode:undefined}:opts);
      const head=source.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/g,'');
      if(/^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET)\b/i.test(head)||/\/\*!/.test(source))contextChanged=true;
      return {start:part.start,end:part.end,model,priorContextChange};
    });
    const cached = preview?.type === 'local' ? undefined : metadata?.cachedMetadata;
    const diagnostics=dmlDiagnostics(document, text, statements.filter(statement=>!statement.contextUncertain), opts.sqlMode);
    for(const transition of automatic?.modeTransitions||[]){
      const item=new vscode.Diagnostic(new vscode.Range(document.positionAt(transition.start),document.positionAt(transition.end)),
        'Later statements are analyzed with the declared document SQL mode. This does not change an open console session.',
        vscode.DiagnosticSeverity.Information);
      item.code='sql.script.sessionMode';item.source='Rocketbrain SQL (script mode)';diagnostics.push(item);
    }
    if(preview?.type==='overlay'){
      const diagnostic=new vscode.Diagnostic(new vscode.Range(0,0,0,0),
        'Using saved virtual schema '+preview.report.label+'. This editor is for SQL analysis.',
        vscode.DiagnosticSeverity.Information);
      diagnostic.source='Rocketbrain SQL (saved virtual schema)';
      diagnostic.code='sql.virtual.overlay.active';
      diagnostics.push(diagnostic);
    }
    if (cached) {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0),
        'Using cached ' + cached.database + ' metadata captured ' + cached.capturedAt + '. Live schema and query validity are unverified.',
        vscode.DiagnosticSeverity.Information);
      diagnostic.source = 'Rocketbrain SQL (cached metadata)';
      diagnostic.code = 'sql.catalog.cached';
      diagnostics.push(diagnostic);
    }
    for(const statement of statements)for(const issue of statement.model.diagnostics||[]){
      const start=statement.start+(issue.start??0),end=statement.start+(issue.end??issue.start??0);
      const item=new vscode.Diagnostic(new vscode.Range(document.positionAt(start),document.positionAt(end)),issue.message,
        cached ? vscode.DiagnosticSeverity.Information : issue.severity==='error'?vscode.DiagnosticSeverity.Error:issue.severity==='warning'?vscode.DiagnosticSeverity.Warning:vscode.DiagnosticSeverity.Information);
      item.source=cached?'Rocketbrain SQL (cached metadata)':virtual?'Rocketbrain SQL (virtual DDL preview)':
        statement.scriptShadow?'Rocketbrain SQL (script catalog)':'Rocketbrain SQL (source model)';item.code=issue.code;diagnostics.push(item);
    }
    for(const issue of virtual?.unknown||[]){
      const at=document.positionAt(issue.start||0);
      const item=new vscode.Diagnostic(new vscode.Range(at,at),issue.reason,vscode.DiagnosticSeverity.Information);
      item.source='Rocketbrain SQL (virtual DDL preview)';item.code='sql.virtual.incomplete';diagnostics.push(item);
    }
    for(const issue of automatic?.unknown||[]){
      const at=document.positionAt(issue.start||0);
      const item=new vscode.Diagnostic(new vscode.Range(at,at),issue.reason,vscode.DiagnosticSeverity.Information);
      item.source='Rocketbrain SQL (script catalog)';item.code='sql.script.incomplete';diagnostics.push(item);
    }
    if(automatic?.changes.length){
      const at=document.positionAt(automatic.changes[0].start);
      const item=new vscode.Diagnostic(new vscode.Range(at,at),
        'Supported changes are modeled for later statements in this editor. No DDL was sent to the database.',vscode.DiagnosticSeverity.Information);
      item.source='Rocketbrain SQL (script catalog)';item.code='sql.script.catalog';diagnostics.push(item);
    }
    collection.set(document.uri,diagnostics.slice(0,500));
    const states=statements.map(s=>s.model.state),value={state:states.includes('invalid')?'invalid':states.includes('unknown')||contextChanged||parts.length>100||split?.unknown.length?'unknown':'known',contextMayChange:contextChanged,unknown:split?.unknown||[],catalogObservedAt:metadata?.loadedAt||null,catalogVisibility:metadata?.visibility||'not-observed',validityVerified:false,executedSql:false,statements};
    if(virtual)Object.assign(value,{state:virtual.state,contextMayChange:virtual.contextMayChange,
      unknown:virtual.unknown,catalogObservedAt:seed.loadedAt||null,catalogVisibility:seed.visibility,
      virtualPreview:true,ddlChanges:virtual.changes,...(preview.configuredScope?{configuredScope:preview.configuredScope}:{}),
      ...(preview.type==='overlay'&&{virtualSchema:structuredClone(preview.report)})});
    if(automatic)Object.assign(value,{state:automatic.state,contextMayChange:automatic.contextMayChange,
      scriptCatalog:true,unknown:automatic.unknown,ddlChanges:automatic.changes,sqlModeTransitions:automatic.modeTransitions});
    if (cached) Object.assign(value, { state: 'unknown', cachedMetadata: structuredClone(cached) });
    cache.set(key,{version:document.version,epoch,preview,trusted,value});return value;
  }
  function locate(document,position){const offset=document.offsetAt(position),report=analyzeDocument(document),statement=report.statements.find(s=>offset>=s.start&&offset<=s.end);return statement?{...statement,offset:offset-statement.start,scriptCatalog:statement.scriptCatalog}:null;}
  function scriptContextAt(document,offset){
    if(document.languageId!=='sql'||!Number.isInteger(offset))return false;
    const scope=locate(document,document.positionAt(offset));
    return Boolean(scope?.priorContextChange||scope?.contextUncertain);
  }
  function navigationReady(document, scope) {
    return Boolean(objectDefinition && metadata && !metadata.cachedMetadata && scope && !scope.priorContextChange &&
      !disposed && !document.isClosed && vscode.workspace.isTrusted && config().get('enabled', true) &&
      !virtualActive(document) && !require('./federated-select').isFederatedDocument(document));
  }
  function retainedNavigation(document, scope) {
    const snapshot=navigationCache.get(document.uri.toString());
    return snapshot?.version===document.version&&snapshot.epoch===epoch&&snapshot.start===scope.start?snapshot:undefined;
  }
  function localDefinitions(document, scope) {
    return engine().definitionsAt(scope.model,scope.offset,{skipImplicit:true}).map(value=>new vscode.Location(document.uri,
      new vscode.Range(document.positionAt(scope.start+value.start),document.positionAt(scope.start+value.end))));
  }
  async function liveDefinition(document, scope, token) {
    const navigation=require('./sql-live-navigation');
    const snapshot=metadata, generation=epoch, version=document.version, observed=options();
    let remote=[];
    const current=()=>!token?.isCancellationRequested&&document.version===version&&generation===epoch&&snapshot===metadata&&navigationReady(document,scope);
    const assertCurrent=()=>{if(!current())throw Error('The SQL editor or database changed. Resolve the definition again.');};
    try {
      assertCurrent();
      let target=navigation.liveNavigation(scope.model.text,scope.offset,snapshot,observed,remote);
      if(target?.endpoints&&joinCatalog){
        const found=await joinCatalog({endpoints:target.endpoints,includeEdges:false});
        assertCurrent();
        remote=found.tables;
        target=navigation.liveNavigation(scope.model.text,scope.offset,snapshot,observed,remote);
      }
      if(target?.local)return [new vscode.Location(document.uri,new vscode.Range(
        document.positionAt(scope.start+target.local.start),document.positionAt(scope.start+target.local.end)))];
      if(!target?.object)return [];
      const destination=await objectDefinition({...target,sqlMode:observed.sqlMode},assertCurrent);
      assertCurrent();
      if(!destination)return [];
      const key=document.uri.toString();
      let currentFrame=retainedNavigation(document,scope);
      if(!currentFrame){
        if(navigationCache.size>=32)navigationCache.delete(navigationCache.keys().next().value);
        currentFrame={version,epoch:generation,start:scope.start,remote,verified:new Set()};
        navigationCache.set(key,currentFrame);
      }else if(remote.length)currentFrame.remote=remote;
      if(currentFrame.verified.size<32)currentFrame.verified.add(navigation.identityOf(target.object));
      return [destination];
    } catch { return []; }
  }
  function provideDefinition(document,position,token){
    const scope=locate(document,position);
    if(!scope)return [];
    const local=localDefinitions(document,scope);
    return local.length||!navigationReady(document,scope)?local:liveDefinition(document,scope,token);
  }
  async function resolveColumnOrigin(document,position,token){
    const scope=locate(document,position);
    if(!objectColumnOrigin||!navigationReady(document,scope))throw Error('Open a SQL SELECT editor with live database metadata.');
    const version=document.version,generation=epoch,snapshot=metadata,key=document.uri.toString();
    columnOrigins.delete(key);
    const assertCurrent=()=>{
      if(token?.isCancellationRequested||document.version!==version||epoch!==generation||snapshot!==metadata||!navigationReady(document,scope))
        throw Error('The SQL editor or database changed. Resolve the column origin again.');
    };
    const found=await objectColumnOrigin({text:scope.model.text,offset:scope.offset,catalog:snapshot,options:options()},assertCurrent);
    assertCurrent();
    if(columnOrigins.size>=32&&!columnOrigins.has(key))columnOrigins.delete(columnOrigins.keys().next().value);
    columnOrigins.set(key,{version,generation,start:scope.start+found.selectedStart,end:scope.start+found.selectedEnd,quickExplanation:found.quickExplanation});
    return found;
  }
  function provideHover(document,position){
    const scope=locate(document,position);
    if(!scope)return null;
    const value=engine().hoverAt(scope.model,scope.offset),markdown=new vscode.MarkdownString();
    if(value)markdown.appendText(value);
    if(value&&scope.scriptShadow)markdown.appendText('\n\nScript catalog from preceding statements in this editor.');
    const traced=columnOrigins.get(document.uri.toString()),offset=document.offsetAt(position);
    if(navigationReady(document,scope)&&traced?.version===document.version&&traced.generation===epoch&&offset>=traced.start&&offset<traced.end){
      if(value)markdown.appendText('\n\n');
      markdown.appendText(traced.quickExplanation);
      return new vscode.Hover(markdown);
    }
    if(metadata?.cachedMetadata&&!virtualActive(document)&&value){
      markdown.appendText('\nCached metadata captured '+metadata.cachedMetadata.capturedAt);
    }
    if(navigationReady(document,scope)){
      const navigation=require('./sql-live-navigation'),retained=retainedNavigation(document,scope);
      const target=engine().definitionsAt(scope.model,scope.offset,{skipImplicit:true}).length?undefined:
        navigation.liveNavigation(scope.model.text,scope.offset,metadata,options(),retained?.remote);
      const verified=target?.object&&retained?.verified.has(navigation.identityOf(target.object));
      const info=navigation.quickInfo(target,verified);
      if(info){if(value)markdown.appendText('\n\n');markdown.appendText(info);return new vscode.Hover(markdown);}
    }
    return value?new vscode.Hover(markdown):null;
  }
  const renameEngine=()=>require('./sql-rename');
  const projectEngine=()=>require('./sql-project');
  const textHash=text=>require('node:crypto').createHash('sha256').update(text).digest('hex');
  function renameSnapshot(document,position,token){
    if(disposed||document.isClosed)throw new Error('SQL rename document is closed.');
    if(isProfileConsole(document))throw Error('Use the active database console for SQL rename.');
    if(token?.isCancellationRequested)throw new Error('SQL rename was cancelled.');
    if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before renaming SQL symbols.');
    if(virtualActive(document))throw new Error('Exit the virtual DDL preview before renaming SQL symbols.');
    if(metadata?.cachedMetadata)throw new Error('Connect and refresh live metadata before renaming SQL symbols.');
    if(!metadata)throw new Error('Refresh SQL metadata before renaming a local symbol.');
    if(document.languageId!=='sql')throw new Error('Open a SQL document first.');
    const text=document.getText(),scope=locate(document,position);
    if(scope?.priorContextChange||scope?.contextUncertain)throw Error('Open the live statement separately before renaming symbols in a script with preceding DDL.');
    if(!scope||scope.model.state!=='known')throw new Error('SQL rename requires a fully resolved statement and current metadata.');
    return {uri:document.uri.toString(),version:document.version,epoch,hash:textHash(text),text,scope,offset:document.offsetAt(position),options:options(),metadata};
  }
  function assertRenameSnapshot(document,snapshot,token){
    if(disposed||document.isClosed||token?.isCancellationRequested)throw new Error('SQL rename was cancelled or the document was closed.');
    if(!vscode.workspace.isTrusted||document.version!==snapshot.version||epoch!==snapshot.epoch||textHash(document.getText())!==snapshot.hash)throw new Error('SQL rename source or connection changed. Start Rename again.');
  }
  function prepareRename(document,position,token){
    const snapshot=renameSnapshot(document,position,token),s=snapshot.scope;
    const value=renameEngine().prepareSqlRename(snapshot.text.slice(s.start,s.end),snapshot.metadata,snapshot.options,s.offset);
    assertRenameSnapshot(document,snapshot,token);
    preparedRenames.set(snapshot.uri,{version:snapshot.version,epoch:snapshot.epoch,hash:snapshot.hash,offset:snapshot.offset});
    return {range:new vscode.Range(document.positionAt(s.start+value.start),document.positionAt(s.start+value.end)),placeholder:value.name};
  }
  async function renameDocument(document,position,newName,token){
    const snapshot=renameSnapshot(document,position,token),previous=preparedRenames.get(snapshot.uri);
    if(previous&&(previous.version!==snapshot.version||previous.epoch!==snapshot.epoch||previous.hash!==snapshot.hash))throw new Error('SQL rename source or connection changed after preparation. Start Rename again.');
    // Yield once so cancellation, document changes and connection changes cannot race planning.
    await Promise.resolve();assertRenameSnapshot(document,snapshot,token);
    const s=snapshot.scope,plan=renameEngine().planSqlRename(snapshot.text.slice(s.start,s.end),snapshot.metadata,snapshot.options,s.offset,newName);
    assertRenameSnapshot(document,snapshot,token);
    const edit=new vscode.WorkspaceEdit();
    for(const change of plan.edits)edit.replace(document.uri,new vscode.Range(document.positionAt(s.start+change.start),document.positionAt(s.start+change.end)),change.newText,{label:'Rename local SQL symbol'});
    preparedRenames.delete(snapshot.uri);return edit;
  }
  const inside=(root,file)=>{const relative=path.relative(root,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
  function projectTrusted(token){if(disposed)throw new Error('SQL project analysis is closed.');if(token?.isCancellationRequested)throw new Error('SQL project analysis was cancelled.');if(!config().get('enabled',true))throw new Error('SQL source analysis is disabled. Enable it before inspecting project references.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before inspecting SQL project references.');if(!metadata||metadata.cachedMetadata)throw new Error('Refresh live SQL metadata before inspecting project references.');}
  function projectRoots(scanOptions={}){
    const folders=(vscode.workspace.workspaceFolders||[]).filter(f=>f.uri.scheme==='file').map(f=>f.uri.fsPath);
    if(!folders.length)throw new Error('Open a local workspace before inspecting SQL project references.');
    const settings=vscode.workspace.getConfiguration('rocketbrain.sql.project');
    const configured=scanOptions.scope?.roots??settings.get('roots',[]);
    const configuredJava=scanOptions.scope?.javaRoots??settings.get('javaRoots',[]);
    function resolve(selected){
      if(!Array.isArray(selected)||selected.length>20)throw new Error('Configure at most 20 local roots for each SQL source language.');
      return [...new Set(selected.map(raw=>{
        if(typeof raw!=='string'||!raw||raw.includes('\0'))throw new Error('Use local SQL source-root paths.');
        if(!path.isAbsolute(raw)&&!raw.startsWith('file:')&&folders.length!==1)throw new Error('Use absolute SQL source-root paths in a multi-folder workspace.');
        const file=raw.startsWith('file:')?fileURLToPath(raw):path.resolve(folders[0],raw),real=fs.realpathSync(file);
        if(!folders.some(root=>inside(root,file)&&inside(fs.realpathSync(root),real))||!fs.statSync(real).isDirectory())throw new Error('SQL source roots and links must stay inside an open local workspace.');
        return real;
      }))].sort();
    }
    return {roots:resolve(Array.isArray(configured)&&!configured.length?folders:configured),javaRoots:resolve(configuredJava)};
  }
  const projectExclude='**/{node_modules,.git,.vscode-test,test-output,build,target,bin,out,.gradle,dist}/**';
  const sourceLanguage=uri=>path.extname(uri.fsPath).toLowerCase()==='.java'?'java':'sql';
  async function projectFiles({roots,javaRoots},token){
    const found=new Map();let limited=false;
    for(const [language,selected] of [['sql',roots],['java',javaRoots]])for(const root of selected){
      projectTrusted(token);const glob='**/*.{'+language+','+language.toUpperCase()+'}';
      const pattern=vscode.RelativePattern?new vscode.RelativePattern(root,glob):glob;
      const files=await vscode.workspace.findFiles(pattern,projectExclude,201,token);projectTrusted(token);
      if(files.length>200)limited=true;
      for(const uri of files){
        if(uri.scheme!=='file'||!inside(root,uri.fsPath)||path.extname(uri.fsPath).toLowerCase()!=='.'+language)continue;
        found.set(uri.toString(),uri);if(found.size>200)limited=true;
      }
    }
    return {files:[...found.values()].sort((a,b)=>Number(sourceLanguage(a)==='java')-Number(sourceLanguage(b)==='java')||
      a.toString().localeCompare(b.toString())),limited};
  }
  function assertProjectFrame(frame,token,{allowCatalogChange=false}={}){
    projectTrusted(token);if(frame.projectGeneration!==projectGeneration)throw new Error('SQL source roots or workspace configuration changed. Start the source operation again.');
    if(!allowCatalogChange&&frame.epoch!==epoch)throw new Error('SQL project metadata or connection changed. Start the source operation again.');
    if(frame.database!==metadata.database||frame.dialect!==metadata.dialect)throw new Error('The SQL project database changed. Start the source operation again.');
  }
  function assertSourceRecord(record){
    const stat=fs.lstatSync(record.file);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(record.file)!==record.file||stat.size>128*1024||textHash(fs.readFileSync(record.file,'utf8'))!==record.diskHash)throw new Error('SQL source changed on disk. Review the rename again.');
    if(record.document.isClosed||record.document.version!==record.version||textHash(record.document.getText())!==record.hash)throw new Error('SQL source buffer changed. Review the rename again.');
  }
  async function scanProject(target,token,scanOptions={},forRename=false){
    projectTrusted(token);const scope=projectRoots(scanOptions),frame={epoch,projectGeneration,database:metadata.database,dialect:metadata.dialect},observed=structuredClone(metadata),opts=options();
    const includeEmbeddedJava=scanOptions.includeEmbeddedJava===true;
    const sameDatabase=!target?.database||(opts.tableNameCaseSensitive===false
      ? String(target.database).toLowerCase()===observed.database.toLowerCase() : target.database===observed.database);
    let joinTables=[];
    if(sameDatabase||forRename||!joinCatalog)target=projectEngine().normalizeTarget(target,observed,opts);
    else{
      projectEngine().validateIdentifier(target.database);projectEngine().validateIdentifier(target.table);
      const visible=await joinCatalog({endpoints:[{schema:target.database,table:target.table}],includeEdges:false});
      assertProjectFrame(frame,token);
      joinTables=visible.tables;
      const catalog={database:target.database,tables:joinTables.filter(table=>table.schema===target.database),views:[]};
      target=projectEngine().normalizeTarget(target,catalog,{...opts,database:target.database});
    }
    const usageOptions={...opts,usageParameters:!forRename,dmlUsages:!forRename,joinOrigins:joinTables.length>0,joinTables};
    const inventory=await projectFiles(scope,token);assertProjectFrame(frame,token);
    const documents=[],unknownFiles=[],references=[];let totalBytes=0;
    let recognizedJavaFragments=0;
    if(inventory.limited)unknownFiles.push({reason:'SQL usage scanning is limited to 200 files across the selected roots.'});
    for(const uri of inventory.files.slice(0,200)){
      projectTrusted(token);assertProjectFrame(frame,token);
      const language=sourceLanguage(uri),java=language==='java';
      if(!java&&isProfileConsole({uri})){
        unknownFiles.push({uri:uri.toString(),reason:'This SQL file has a dedicated database profile.'});
        continue;
      }
      if(!java&&configuredScope({uri})){
        unknownFiles.push({uri:uri.toString(),reason:'A local DDL resolution scope supplies this SQL file’s catalog.'});
        continue;
      }
      try{
        const stat=fs.lstatSync(uri.fsPath),real=fs.realpathSync(uri.fsPath);
        if(!stat.isFile()||stat.isSymbolicLink()||!(java?scope.javaRoots:scope.roots).some(root=>inside(root,real)))throw new Error('SQL source files must be regular local files inside the selected roots.');
        if(stat.size>128*1024)throw new Error('SQL project files are limited to128KiB.');
        totalBytes+=stat.size;if(totalBytes>8*1024*1024)throw new Error('SQL project scanning is limited to8MiB.');
        const disk=fs.readFileSync(real,'utf8'),document=await vscode.workspace.openTextDocument(uri);assertProjectFrame(frame,token);
        if(document.isClosed)throw new Error('The SQL source document closed during project inspection.');
        const text=document.getText();totalBytes+=Math.max(0,Buffer.byteLength(text)-stat.size);if(totalBytes>8*1024*1024)throw new Error('SQL project scanning is limited to8MiB.');
        const record={uri:uri.toString(),file:real,document,version:document.version,hash:textHash(text),diskHash:textHash(disk),text,language};
        documents.push(record);
        let usages,unknown;
        if(java){
          const embedded=require('./sql-usage-sources'),report=embedded.analyzeJavaUsageDocument(text,observed,usageOptions);
          const found=embedded.usagesInJava(report,target,opts);
          usages=found.references;unknown=[...report.unknown,...found.unknown];recognizedJavaFragments+=report.fragments.length;
        }else{
          const report=projectEngine().analyzeProjectDocument(text,observed,usageOptions);
          usages=projectEngine().referencesInDocument(report,target,opts);unknown=report.unknown;
        }
        references.push(...usages.map(ref=>({...ref,uri:record.uri})));
        if(unknown.length)unknownFiles.push({uri:record.uri,language,unresolvedCount:unknown.length,reasons:unknown.slice(0,10),
          reason:java?'Some embedded SQL has uncertain binding, source context or source location.':'Some SQL statements have unresolved bindings.'});
      }catch(error){assertProjectFrame(frame,token);unknownFiles.push({uri:uri.toString(),reason:error.message});}
    }
    const completedInventory=await projectFiles(scope,token);assertProjectFrame(frame,token);if(completedInventory.limited!==inventory.limited||JSON.stringify(completedInventory.files.map(u=>u.toString()))!==JSON.stringify(inventory.files.map(u=>u.toString())))throw new Error('The SQL project file set changed during inspection. Try again.');for(const record of documents)assertSourceRecord(record);
    const javaReferences=references.filter(ref=>ref.language==='java').length;
    const coverage={complete:unknownFiles.length===0,scope:scope.javaRoots.length?'selected-local-sql-and-java-roots':'selected-local-sql-roots',
      ...scope,excluded:projectExclude,files:inventory.files.length,analyzedFiles:documents.length,totalBytes,
      limits:{files:200,fileBytes:128*1024,totalBytes:8*1024*1024},unknownFiles,
      java:{enabled:scope.javaRoots.length>0,analyzedFiles:documents.filter(record=>record.language==='java').length,
        recognizedFragments:recognizedJavaFragments,references:javaReferences,...(includeEmbeddedJava&&{renameEnabled:true})},
      dml:{readReferences:references.filter(ref=>ref.usage==='read').length,writeReferences:references.filter(ref=>ref.usage==='write').length},
      sourceRenameEligible:unknownFiles.length===0&&(includeEmbeddedJava||javaReferences===0)&&!references.some(ref=>ref.command),
      embeddedSql:'Recognized native Java SQL in selected Java roots. Other embedded languages and runtime strings are outside scope.'};
    return {target,frame,...scope,options:opts,metadata:observed,inventory:inventory.files.map(u=>u.toString()),documents,references,coverage};
  }
  function publicProjectReport(scan){return structuredClone({target:scan.target,references:scan.references,coverage:scan.coverage,executedSql:false});}
  async function findCatalogReferences(target,token,scanOptions={}){const scan=await scanProject(target,token,scanOptions);return lastProjectReport=publicProjectReport(scan);}
  async function captureCatalogFileUsages(target,token,scanOptions={}){
    const scan=await scanProject(target,token,scanOptions);
    const references=scan.references.slice(0,512);
    return {
      report:structuredClone({target:scan.target,references,coverage:scan.coverage,truncated:scan.references.length>references.length}),
      async open(index){
        assertProjectFrame(scan.frame,undefined);
        const hit=references[index], record=hit&&scan.documents.find(document=>document.uri===hit.uri);
        if(!record)throw Error('The captured SQL location is unavailable. Find usages again.');
        try{assertSourceRecord(record);}
        catch{throw Error('The SQL source changed. Find usages again.');}
        const selection=new vscode.Range(record.document.positionAt(hit.start),record.document.positionAt(hit.end));
        const editor=await vscode.window.showTextDocument(record.document,{preview:false,selection});
        assertProjectFrame(scan.frame,undefined);
        try{assertSourceRecord(record);}
        catch{throw Error('The SQL source changed. Find usages again.');}
        return {documentUri:editor.document.uri.toString()};
      }
    };
  }
  function javaReport(document,observed){
    if(document.uri.scheme!=='file'||sourceLanguage(document.uri)!=='java'||document.isClosed)return null;
    const configured=vscode.workspace.getConfiguration('rocketbrain.sql.project').get('javaRoots',[]);
    if(!Array.isArray(configured)||!configured.length)return null;
    const {javaRoots}=projectRoots();
    if(!javaRoots.some(root=>inside(root,document.uri.fsPath)))return null;
    let stat,real;
    try{stat=fs.lstatSync(document.uri.fsPath);real=fs.realpathSync(document.uri.fsPath);}
    catch{return null;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024||!javaRoots.some(root=>inside(root,real)))return null;
    const text=document.getText();
    if(Buffer.byteLength(text)>128*1024)return null;
    return require('./sql-usage-sources').analyzeJavaUsageDocument(text,metadata,observed);
  }
  function usageTarget(document,position,joinTables=[]){
    const offset=document.offsetAt(position),observed={...options(),usageParameters:true,dmlUsages:true,joinOrigins:joinTables.length>0,joinTables};
    if(document.languageId==='java'){
      const report=javaReport(document,observed);
      return report?{report,selected:require('./sql-usage-sources').targetAtJava(report,offset,observed),embedded:true}:null;
    }
    const report=projectEngine().analyzeProjectDocument(document.getText(),metadata,observed);
    return {report,selected:projectEngine().targetAtDocument(report,offset,observed),embedded:false};
  }
  function catalogTargetAt(document,position){
    if(isProfileConsole(document)||virtualActive(document)||scriptContextAt(document,document.offsetAt(position)))return null;
    projectTrusted();const target=usageTarget(document,position)?.selected;
    return !target||['local','pending-dml'].includes(target.kind)?null:target;
  }
  function buildCatalogEdit(plan,{reviewed=false}={}){
    const edit=new vscode.WorkspaceEdit();for(const record of plan.documents)for(const change of record.changes)edit.replace(vscode.Uri.parse(record.uri),new vscode.Range(record.document.positionAt(change.start),record.document.positionAt(change.end)),change.newText,{label:'Rename physical SQL reference',needsConfirmation:!reviewed});return edit;
  }
  async function planCatalogRename(target,newName,token,scanOptions={}){
    const scan=await scanProject(target,token,scanOptions,true);lastProjectReport=publicProjectReport(scan);
    if(!scan.coverage.complete)throw Object.assign(new Error('Unsupported, incomplete or excluded-by-limit SQL prevents a complete source rename plan. Select query-only roots or review a database-only rename explicitly.'),{code:'SQL_PROJECT_INCOMPLETE',coverage:scan.coverage});
    if(!scan.coverage.sourceRenameEligible)throw Object.assign(new Error('The selected database object has embedded Java SQL usages. Review those sources separately before renaming.'),{code:'SQL_PROJECT_EMBEDDED_READ_ONLY',coverage:scan.coverage});
    const documents=scan.documents.map(record=>{
      let changes;
      if(record.language==='java')changes=scan.coverage.java.renameEnabled
        ?require('./sql-usage-sources').planJavaCatalogRename(record.text,scan.metadata,scan.options,scan.target,newName).edits:[];
      else changes=projectEngine().planCatalogDocumentRename(record.text,scan.metadata,scan.options,scan.target,newName).edits;
      return {...record,changes};
    });
    const plan={id:crypto.randomUUID(),createdAt:Date.now(),...scan,documents,newName};
    for(const [id,value]of projectPlans)if(Date.now()-value.createdAt>120000)projectPlans.delete(id);while(projectPlans.size>=5)projectPlans.delete(projectPlans.keys().next().value);projectPlans.set(plan.id,plan);
    await validateCatalogRename(plan.id,token);
    const edit=buildCatalogEdit(plan);return {id:plan.id,target:structuredClone(plan.target),newName,edit,edits:edit,expiresAt:plan.createdAt+120000,documents:structuredClone(documents.map(r=>({uri:r.uri,language:r.language,version:r.version,hash:r.hash,edits:r.changes}))),coverage:structuredClone(plan.coverage),executedSql:false,atomicWithDatabaseDDL:false};
  }
  async function validateCatalogRename(id,token,validationOptions={}){
    const plan=projectPlans.get(typeof id==='string'?id:id?.id);if(!plan||Date.now()-plan.createdAt>120000)throw new Error('The SQL source rename plan expired. Review it again.');
    assertProjectFrame(plan.frame,token,validationOptions);for(const root of [...plan.roots,...plan.javaRoots])if(fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())throw new Error('SQL source roots changed on disk. Review the rename again.');const inventory=await projectFiles(plan,token);assertProjectFrame(plan.frame,token,validationOptions);
    if(inventory.limited||JSON.stringify(inventory.files.map(u=>u.toString()))!==JSON.stringify(plan.inventory))throw new Error('The SQL project file set changed. Review the rename again.');
    for(const record of plan.documents){
      assertSourceRecord(record);
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(record.uri));assertProjectFrame(plan.frame,token,validationOptions);
      if(document.isClosed||document.version!==record.version||textHash(document.getText())!==record.hash)throw new Error('SQL source buffer changed. Review the rename again.');record.document=document;
    }
    const finalInventory=await projectFiles(plan,token);assertProjectFrame(plan.frame,token,validationOptions);if(finalInventory.limited||JSON.stringify(finalInventory.files.map(u=>u.toString()))!==JSON.stringify(plan.inventory))throw new Error('The SQL project file set changed. Review the rename again.');for(const record of plan.documents)assertSourceRecord(record);
    return {state:'fresh',id:plan.id,documents:plan.documents.length,catalogChangeAllowed:validationOptions.allowCatalogChange===true,rootMustVerifyDatabaseDDL:validationOptions.allowCatalogChange===true};
  }
  async function catalogRenameEdit(id,token,validationOptions={}){await validateCatalogRename(id,token,validationOptions);return buildCatalogEdit(projectPlans.get(typeof id==='string'?id:id?.id),validationOptions);}
  async function provideReferences(document,position,context={},token){
    if(!config().get('enabled',true)||isProfileConsole(document)||virtualActive(document)||!metadata||metadata.cachedMetadata||!vscode.workspace.isTrusted||
        scriptContextAt(document,document.offsetAt(position)))return [];
    projectTrusted(token);
    const version=document.version,generation=epoch;
    let usage=usageTarget(document,position);
    if(usage?.selected?.kind==='pending-dml'){
      if(!joinCatalog)return [];
      try{
        const observed=await joinCatalog({endpoints:usage.selected.endpoints,includeEdges:false});
        projectTrusted(token);
        if(document.isClosed||document.version!==version||epoch!==generation)return [];
        usage=usageTarget(document,position,observed.tables);
      }catch{return [];}
    }
    const selected=usage?.selected;
    if(!selected||selected.kind==='pending-dml')return [];
    if(selected.kind==='local')return selected.statement.model.references.filter(ref=>!ref.implicit&&ref.start<ref.end&&sameDefinition(ref.definition,selected.definition)&&(context.includeDeclaration||!ref.kind.endsWith('-definition'))).map(ref=>new vscode.Location(document.uri,new vscode.Range(document.positionAt(selected.statement.start+ref.start),document.positionAt(selected.statement.start+ref.end))));
    const found=await findCatalogReferences(selected,token),locations=found.references.map(ref=>new vscode.Location(vscode.Uri.parse(ref.uri),new vscode.Range(ref.range.start,ref.range.end)));
    if(document.isClosed||document.version!==version)return [];
    if(!found.coverage.complete){vscode.window.setStatusBarMessage?.('SQL usages are partial: '+found.coverage.unknownFiles.length+' sources or limits need review. Check the SQL usage coverage report.',10000);output?.appendLine('SQL project reference coverage: '+JSON.stringify(found.coverage));}
    if(!usage.embedded&&!found.references.some(ref=>ref.uri===document.uri.toString()))for(const ref of projectEngine().referencesInDocument(usage.report,selected,options()))locations.push(new vscode.Location(document.uri,new vscode.Range(ref.range.start,ref.range.end)));
    return locations;
  }
  const sameDefinition=(a,b)=>Boolean(a&&b&&a.start===b.start&&a.end===b.end);
  function reanalyze(){cache.clear();for(const doc of vscode.workspace.textDocuments)if(doc.languageId==='sql'&&!doc.isClosed)analyzeDocument(doc);events.fire();}
  async function refreshMetadata(){
    if(disposed)throw new Error('SQL analysis is closed.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before reading SQL metadata.');
    const generation=epoch,sequence=++request,result=await catalog();
    if(disposed||generation!==epoch||sequence!==request||!vscode.workspace.isTrusted)throw new Error('The SQL analysis connection changed during metadata inspection. Refresh again.');
    metadata=result;epoch++;reanalyze();return {database:result.database,loadedAt:result.loadedAt,dialect:result.dialect,coverage:result.coverage,visibility:result.visibility};
  }
  async function useDdlPreview(document,source={}){
    if(disposed||!vscode.workspace.isTrusted)throw Error('Trust the workspace before previewing a SQL schema.');
    if(!document||document.isClosed||document.languageId!=='sql')throw Error('Open a SQL editor.');
    if(!config().get('enabled',true))throw Error('Enable SQL analysis before previewing a schema.');
    if(analysisOnly(document))throw Error('Exit the saved virtual schema preview before opening another DDL preview.');
    const uri=document.uri.toString();
    const version=document.version;
    let preview;
    if(source.file){
      if(source.file.scheme!=='file')throw Error('Choose a local DDL file.');
      const handle=await fs.promises.open(source.file.fsPath,'r');
      try{
        const stats=await handle.stat();
        if(!stats.isFile()||stats.size>128*1024)throw Error('Use a regular DDL file up to 128 KiB.');
        const bytes=Buffer.alloc(128*1024+1);
        let read=0;
        while(read<bytes.length){
          const {bytesRead}=await handle.read(bytes,read,bytes.length-read,read);
          if(!bytesRead)break;
          read+=bytesRead;
        }
        if(read>128*1024)throw Error('Use a regular DDL file up to 128 KiB.');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,read));
        const {model}=require('./ddl-model').parseSchema(text,source.database,source.dialect);
        preview={type:'local',model};
      }finally{await handle.close();}
    }else{
      if(!metadata)await refreshMetadata();
      if(metadata?.coverage?.tables!=='loaded'||metadata.coverage.columns!=='loaded'){
        throw Error('Refresh the complete visible SQL catalog before previewing its DDL changes.');
      }
      preview={type:'observed'};
    }
    if(disposed||!vscode.workspace.isTrusted||document.isClosed||document.version!==version){
      throw Error('The SQL editor changed. Start the DDL preview again.');
    }
    if(ddlPreviews.size>=24&&!ddlPreviews.has(uri))throw Error('Close a SQL preview before opening another.');
    ddlPreviews.set(uri,preview);cache.delete(uri);preparedRenames.delete(uri);
    const report=analyzeDocument(document);
    events.fire(document);
    return report;
  }
  function clearDdlPreview(document){
    if(!document||!ddlPreviews.delete(document.uri.toString()))return false;
    cache.delete(document.uri.toString());
    if(!document.isClosed){analyzeDocument(document);events.fire(document);}
    return true;
  }
  function overlayContext(){
    if(disposed||!vscode.workspace.isTrusted||!overlays)throw Error('Trust the workspace before using its saved virtual schemas.');
    const identity=liveCatalogIdentity?.(), observed=metadata, generation=epoch;
    const scope=overlayScope(identity,observed);
    const assertCurrent=()=>{
      const current=liveCatalogIdentity?.();
      if(disposed||!vscode.workspace.isTrusted||metadata!==observed||epoch!==generation||
          !current||current.epoch!==identity.epoch||overlayScope(current,observed)!==scope){
        throw Error('The live database catalog changed. Review the virtual schema again.');
      }
    };
    return {scope,observed,assertCurrent};
  }
  function overlayCurrent(preview){
    try{
      preview.assertCurrent();
      return overlays.read(preview.scope,preview.report.id).revision===preview.report.revision;
    }catch{return false;}
  }
  function overlayDocument(document){
    if(!document||document.isClosed||document.languageId!=='sql'||isProfileConsole(document)||
        require('./federated-select').isFederatedDocument(document))throw Error('Open a SQL editor for the active database.');
    if(!config().get('enabled',true))throw Error('Enable SQL analysis before using a saved virtual schema.');
  }
  const listOverlays=()=>overlays.list(overlayContext().scope);
  const readOverlay=id=>overlays.read(overlayContext().scope,id);
  async function saveOverlay(value){
    const {scope,observed,assertCurrent}=overlayContext();
    const {changes,externalInputs}=await buildOverlay(value,observed,{loadForeign:joinCatalog,assertCurrent});
    const saved=await overlays.save(scope,value,assertCurrent);
    reanalyze();
    return {...saved,changes,externalInputs,executedSql:false};
  }
  async function removeOverlay(id,revision){
    const {scope,assertCurrent}=overlayContext();
    const removed=await overlays.remove(scope,id,revision,assertCurrent);
    reanalyze();
    return removed;
  }
  async function useOverlay(document,id){
    overlayDocument(document);
    const {scope,observed,assertCurrent}=overlayContext(), version=document.version, uri=document.uri.toString();
    if(document.uri.scheme===overlaySourceScheme)throw Error('Apply a saved virtual schema to a query editor.');
    const value=overlays.read(scope,id);
    const {model,changes,externalInputs}=await buildOverlay(value,observed,{loadForeign:joinCatalog,assertCurrent});
    if(document.isClosed||document.version!==version||overlays.read(scope,id).revision!==value.revision)
      throw Error('The SQL editor or virtual schema changed. Reapply the virtual schema.');
    if(ddlPreviews.size>=24&&!ddlPreviews.has(uri))throw Error('Close a SQL preview before opening another.');
    ddlPreviews.set(uri,{type:'overlay',model,scope,assertCurrent,report:{id,label:value.label,revision:value.revision,changes,externalInputs}});
    cache.delete(uri);
    preparedRenames.delete(uri);
    const report=analyzeDocument(document);
    events.fire(document);
    return report;
  }
  const virtualSchemas={list:listOverlays,read:readOverlay,save:saveOverlay,remove:removeOverlay,use:useOverlay};
  if(overlays)subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(overlaySourceScheme,{
    provideTextDocumentContent(uri){
      const match=/^\/([0-9a-f-]+)\/overlay\.sql$/u.exec(uri.path);
      if(match){
        try{return readOverlay(match[1]).source+'\n';}catch{/* A saved definition needs its matching live scope. */}
      }
      return '-- The saved virtual schema is unavailable for the current database.\n';
    }
  }));
  function callOptions(document, scope) {
    if (!vscode.workspace.isTrusted || !metadata?.semanticContextObserved || metadata.cachedMetadata ||
        virtualActive(document) || scope.priorContextChange) return {};
    return options();
  }
  subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'sql' }, {
    provideCompletionItems(document, position, token) {
      const scope = locate(document, position);
      if (!scope || token?.isCancellationRequested) return [];
      const observed = callOptions(document, scope), cached = metadata?.cachedMetadata && !virtualActive(document);
      const ordinary = engine().completionsAt(scope.model, scope.offset);
      const extra = vscode.workspace.isTrusted && !scope.priorContextChange
        ? callCompletions(scope.model.text, scope.offset, observed, scope.model) : [];
      return [...ordinary, ...extra].map(value => {
        const kind = value.kind === 'function' ? vscode.CompletionItemKind.Function : value.kind === 'alias' ? vscode.CompletionItemKind.Reference :
          value.kind === 'column' ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Struct;
        const label = value.description ? { label: value.label, detail: ' · ' + value.description } : value.label;
        const item = new vscode.CompletionItem(label, kind);
        item.detail = cached ? 'Cached metadata · ' + value.detail : value.detail;
        if (value.parts) {
          const snippet = new vscode.SnippetString();
          for (const part of value.parts) {
            if (typeof part === 'string') snippet.appendText(part);
            else snippet.appendPlaceholder(part.placeholder);
          }
          item.insertText = snippet;
        } else item.insertText = value.insertText || value.label;
        if (value.filterText) item.filterText = value.filterText;
        if (value.rank !== undefined) item.sortText = `${value.rank + 1}:${value.label}:${value.description || ''}`;
        if (value.start !== undefined) item.range = new vscode.Range(document.positionAt(scope.start + value.start), document.positionAt(scope.start + value.end));
        return item;
      });
    }
  }, '.'));
  if (vscode.languages.registerSignatureHelpProvider) subscriptions.push(vscode.languages.registerSignatureHelpProvider({ language: 'sql' }, {
    provideSignatureHelp(document, position, token) {
      const scope = locate(document, position);
      if (!scope || token?.isCancellationRequested) return;
      const signatures = callSignature(scope.model.text, scope.offset, callOptions(document, scope));
      if (!signatures?.length) return;
      const help = new vscode.SignatureHelp();
      help.signatures = signatures.map(entry => {
        const info = new vscode.SignatureInformation(entry.label);
        info.parameters = entry.parameters.map(parameter => new vscode.ParameterInformation(parameter));
        info.activeParameter = entry.active;
        return info;
      });
      help.activeSignature = 0;
      help.activeParameter = signatures[0].active;
      return help;
    }
  }, '(', ','));
  subscriptions.push(vscode.languages.registerCompletionItemProvider({language:'sql'}, {
    async provideCompletionItems(document,position,token) {
      if(disposed||!vscode.workspace.isTrusted||!config().get('enabled',true)||!metadata||isProfileConsole(document)||virtualActive(document)||require('./federated-select').isFederatedDocument(document))return [];
      const scope=locate(document,position), shadow=scope?.scriptCatalog;
      if (scope?.contextUncertain || scope?.priorContextChange&&!shadow) return [];
      const projected=Boolean(scope?.sqlMode&&shadow);
      const text=projected?scope.model.text:document.getText(), offset=projected?scope.offset:document.offsetAt(position);
      const observed={...options(),...(projected&&{sqlMode:scope.sqlMode})};
      const snapshot = metadata, version = document.version, generation = epoch;
      const current = () => !disposed && !token?.isCancellationRequested && !document.isClosed && document.version === version &&
        epoch === generation && snapshot === metadata && vscode.workspace.isTrusted && config().get('enabled', true) && !virtualActive(document);
      const activeCatalog=shadow||snapshot;
      const fields = require('./sql-field-lists').sqlFieldLists(text, offset, activeCatalog, observed);
      const [mutations, joins] = await Promise.all([
        require('./sql-dml-completion').scopedDmlColumns(text, offset, activeCatalog, observed, shadow?undefined:joinCatalog, current),
        shadow?[]:require('./foreign-key-joins').scopedForeignKeyJoins(text, offset, snapshot,
          { ...observed, readLogical: joinLogicalRelationships }, joinCatalog, current)
      ]);
      if (!current()) return [];
      const indexes=shadow?require('./ddl-script-indexes').indexHintCompletions(scope.model.text,scope.offset,shadow)
        .map(candidate=>({...candidate,start:scope.start+candidate.start,end:scope.start+candidate.end})):[];
      const candidates=[...fields,...mutations,...joins].map(candidate=>projected
        ? {...candidate,start:candidate.start+scope.start,end:candidate.end+scope.start} : candidate);
      return [...candidates, ...indexes].map(candidate=>{
        const kind = candidate.kind === 'column' ? vscode.CompletionItemKind.Field :
          candidate.kind && candidate.kind !== 'table' ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Reference;
        const item=new vscode.CompletionItem(candidate.label,kind);
        item.detail=candidate.detail;
        item.insertText=candidate.insertText;
        item.range=new vscode.Range(document.positionAt(candidate.start),document.positionAt(candidate.end));
        return item;
      });
    }
  },' ','.'));
  subscriptions.push(vscode.languages.registerDefinitionProvider({language:'sql'}, {provideDefinition}));
  subscriptions.push(vscode.languages.registerHoverProvider({language:'sql'}, {provideHover}));
  if(vscode.languages.registerRenameProvider)subscriptions.push(vscode.languages.registerRenameProvider({language:'sql'},{prepareRename,provideRenameEdits:renameDocument}));
  if(vscode.languages.registerReferenceProvider)subscriptions.push(vscode.languages.registerReferenceProvider(
    [{language:'sql'},{language:'java',scheme:'file'}],{provideReferences}));
  if(vscode.workspace.onDidOpenTextDocument)subscriptions.push(vscode.workspace.onDidOpenTextDocument(document=>{
    if(document.languageId==='sql'&&configuredScope(document))analyzeDocument(document);
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(event.document.languageId==='sql')analyzeDocument(event.document);}),vscode.workspace.onDidCloseTextDocument(document=>{cache.delete(document.uri.toString());navigationCache.delete(document.uri.toString());columnOrigins.delete(document.uri.toString());ddlPreviews.delete(document.uri.toString());preparedRenames.delete(document.uri.toString());collection.delete(document.uri);}),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.sql.analysis')){scopeCache.clear();navigationCache.clear();columnOrigins.clear();reanalyze();}}));
  if(onDidChangeDatabase)subscriptions.push(onDidChangeDatabase(value=>{
    for(const [uri,preview] of ddlPreviews)if(preview.type==='observed')ddlPreviews.delete(uri);
    invalidate();
    if(value?.metadata)metadata=value.metadata;
    reanalyze();
  }));
  const command=(name,action)=>subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await action(...args);}catch(error){output?.appendLine(error.message);await vscode.window.showErrorMessage('Rocketbrain SQL: '+error.message);}}));
  command('rocketbrain.sql.refreshAnalysisMetadata',refreshMetadata);
  command('rocketbrain.sql.previewDdl',async resource=>{
    const document=sqlEditorForAction(vscode,resource)?.document;
    if(document?.languageId!=='sql')throw Error('Open a SQL editor.');
    const basis=await vscode.window.showQuickPick(['Observed database catalog','Local DDL snapshot'],{title:'Preview SQL with a Virtual Schema'});
    if(!basis)return;
    let source;
    if(basis==='Local DDL snapshot'){
      const [file]=await vscode.window.showOpenDialog({canSelectMany:false,filters:{SQL:['sql']}})||[];
      if(!file)return;
      const database=await vscode.window.showInputBox({title:'Virtual Schema Name',prompt:'Use the schema identifier from the DDL file'});
      if(!database)return;
      const dialect=await vscode.window.showQuickPick(['mysql','mariadb'],{title:'SQL Dialect'});
      if(!dialect)return;
      source={file,database,dialect};
    }
    const report=await useDdlPreview(document,source);
    vscode.window.setStatusBarMessage(`Virtual SQL schema · ${report.ddlChanges?.length??0} scripted changes · no SQL executed`,10000);
    return report;
  });
  command('rocketbrain.sql.clearDdlPreview',resource=>clearDdlPreview(sqlEditorForAction(vscode,resource)?.document));
  command('rocketbrain.sql.manageVirtualSchemas',async resource=>{
    const editor=sqlEditorForAction(vscode,resource);
    const selectedContext=overlayContext();
    const saved=overlays.list(selectedContext.scope);
    const choices=[
      {label:'Save Selected SQL as a Virtual Schema',create:true},
      ...saved.map(item=>({label:item.label,description:'Saved virtual schema',item}))
    ];
    const selected=await vscode.window.showQuickPick(choices,{title:'Manage Saved Virtual Schemas'});
    if(!selected)return;
    if(selected.create){
      overlayDocument(editor?.document);
      const source=editor.document.getText(editor.selection);
      if(!source.trim())throw Error('Select the SQL definitions for this virtual schema.');
      const label=await vscode.window.showInputBox({title:'Virtual Schema Name'});
      selectedContext.assertCurrent();
      if(label!==undefined)return saveOverlay({label,source});
      return;
    }
    const actions=['Apply to Current SQL Editor','Open Saved Definitions','Replace with Selected SQL','Remove Saved Virtual Schema'];
    const action=await vscode.window.showQuickPick(actions,{title:selected.item.label});
    selectedContext.assertCurrent();
    if(action===actions[0]){
      const report=await useOverlay(editor?.document,selected.item.id);
      vscode.window.setStatusBarMessage('Saved virtual schema · '+selected.item.label,10000);
      return report;
    }
    if(action===actions[1]){
      const uri=vscode.Uri.from({scheme:overlaySourceScheme,path:'/'+selected.item.id+'/overlay.sql'});
      const document=await vscode.workspace.openTextDocument(uri);
      return vscode.window.showTextDocument(document,{preview:false});
    }
    if(action===actions[2]){
      overlayDocument(editor?.document);
      return saveOverlay({...selected.item,source:editor.document.getText(editor.selection)});
    }
    if(action===actions[3]&&await vscode.window.showWarningMessage('Remove saved virtual schema '+selected.item.label+'?',
        {modal:true},'Remove')==='Remove'){
      selectedContext.assertCurrent();
      return removeOverlay(selected.item.id,selected.item.revision);
    }
  });
  function showOrigin(explain,resource){
    const editor=sqlEditorForAction(vscode,resource);
    if(!editor||editor.document.languageId!=='sql')throw Error('Place the cursor inside a SQL column name.');
    const version=editor.document.version,generation=epoch;
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Tracing the database column origin',cancellable:true},
      async(_,token)=>{
        const result=await resolveColumnOrigin(editor.document,editor.selection.active,token);
        const document=explain?await vscode.workspace.openTextDocument({language:'plaintext',content:result.quickExplanation+'\n'}):
          await vscode.workspace.openTextDocument(result.location.uri);
        if(token.isCancellationRequested)return;
        if(!vscode.workspace.isTrusted||editor.document.isClosed||editor.document.version!==version||epoch!==generation)
          throw Error('The SQL editor or database changed. Resolve the column origin again.');
        await vscode.window.showTextDocument(document,{preview:false,...(!explain&&{selection:result.location.range})});
        return result;
      });
  }
  command('rocketbrain.sql.goToColumnOrigin',resource=>showOrigin(false,resource));
  command('rocketbrain.sql.explainColumnOrigin',resource=>showOrigin(true,resource));
  command('rocketbrain.sql.findReferences',async resource=>{
    const editor=sqlEditorForAction(vscode,resource);
    if(!editor||!['sql','java'].includes(editor.document.languageId))throw new Error('Open SQL or a configured Java source file.');
    lastProjectReport=null;
    const locations=await provideReferences(editor.document,editor.selection.active,{includeDeclaration:true});
    await vscode.commands.executeCommand('editor.action.showReferences',editor.document.uri,editor.selection.active,locations);
    return {references:locations.length,coverage:lastProjectReport?.coverage};
  });
  command('rocketbrain.sql.showUsageCoverage',async()=>{
    if(!lastProjectReport)throw Error('Run SQL Find References before opening its coverage.');
    projectTrusted();
    const report=lastProjectReport;
    const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify({
      target:report.target,references:report.references.length,coverage:report.coverage
    },null,2)+'\n'});
    await vscode.window.showTextDocument(document,{preview:true});
    return structuredClone(report.coverage);
  });
  command('rocketbrain.sql.analyze',async resource=>{
    const document=sqlEditorForAction(vscode,resource)?.document;
    if(!document||document.languageId!=='sql')throw new Error('Open a SQL document first.');
    if(!isProfileConsole(document)&&!virtualActive(document)&&!metadata?.cachedMetadata&&(!liveCatalogIdentity||liveCatalogIdentity()))await refreshMetadata();
    const report=analyzeDocument(document);
    const summary=report.state==='not-connected'?'not-connected. Connect to MySQL or MariaDB for catalog-backed checks.':
      report.state+'; '+report.statements.length+' statements.';
    output?.appendLine('SQL source analysis: '+summary+' No user query was executed.');
    output?.show?.(true);
    return report;
  });
  if(vscode.workspace.onDidChangeWorkspaceFolders)subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{projectGeneration++;projectPlans.clear();lastProjectReport=null;}));
  if(onDidChangeSqlFileProfile)subscriptions.push(onDidChangeSqlFileProfile(document=>{
    projectGeneration++;projectPlans.clear();lastProjectReport=null;
    analyzeDocument(document);
  }));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.sql.project')){projectGeneration++;projectPlans.clear();lastProjectReport=null;}}));
  return {analyzeDocument,refreshMetadata,useDdlPreview,clearDdlPreview,virtualActive,analysisOnly,scriptContextAt,virtualSchemas,resolveColumnOrigin,prepareRename,renameDocument,findCatalogReferences,captureCatalogFileUsages,catalogTargetAt,planCatalogRename,validateCatalogRename,catalogRenameEdit,projectSnapshot:()=>lastProjectReport?structuredClone(lastProjectReport):null,invalidate,onDidChange:events.event,snapshot:()=>metadata?{database:metadata.database,dialect:metadata.dialect,loadedAt:metadata.loadedAt}:null,dispose(){disposed=true;scopeCache.clear();ddlPreviews.clear();preparedRenames.clear();projectPlans.clear();invalidate();for(const sub of subscriptions)sub.dispose();}};
}
module.exports={registerSQLAnalysis};
