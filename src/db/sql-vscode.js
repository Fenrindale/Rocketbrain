'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fileURLToPath}=require('node:url');
const { inspectDmlScope } = require('./sql-dml-scope');

function registerSQLAnalysis(context,vscode,{catalog,catalogSnapshot,onDidChangeDatabase,output,joinCatalog,joinLogicalRelationships,objectDefinition}={}) {
  const collection=vscode.languages.createDiagnosticCollection('rocketbrain-sql');
  const events=new vscode.EventEmitter(),subscriptions=[collection,events];
  let metadata=catalogSnapshot?.()||null,epoch=0,request=0,disposed=false;
  const cache=new Map(),preparedRenames=new Map(),projectPlans=new Map(),ddlPreviews=new Map();let projectGeneration=0,lastProjectReport=null;
  const resolutionScopes=require('./sql-resolution-scopes');
  const scopeCache=new Map();
  const navigationCache=new Map();
  const engine=()=>require('./sql-analysis');
  const config=()=>vscode.workspace.getConfiguration('rocketbrain.sql.analysis');
  function invalidate(){epoch++;request++;metadata=null;lastProjectReport=null;cache.clear();navigationCache.clear();collection.clear();if(!disposed)events.fire();}
  function options(){return {dialect:metadata?.dialect||'mysql',database:metadata?.database,serverVersion:metadata?.serverVersion,catalogComplete:Boolean(metadata?.coverage?.tables==='loaded'&&metadata?.coverage?.columns==='loaded'),tableNameCaseSensitive:metadata?.tableNameCaseSensitive,sqlMode:metadata?.sqlMode};}
  function configuredScope(document){
    if(!vscode.workspace.isTrusted||document.uri.scheme!=='file')return null;
    const folder=vscode.workspace.getWorkspaceFolder?.(document.uri);
    if(folder?.uri.scheme!=='file')return null;
    const rules=vscode.workspace.getConfiguration('rocketbrain.sql.analysis',document.uri).get('resolutionScopes',[]);
    const rule=resolutionScopes.selectScope(folder.uri.fsPath,document.uri.fsPath,rules);
    return rule&&{folder:folder.uri.fsPath,rule};
  }
  const virtualActive=document=>vscode.workspace.isTrusted&&
    (ddlPreviews.has(document.uri.toString())||Boolean(configuredScope(document)));
  function dmlDiagnostics(document, text, parts, sqlMode) {
    return parts.slice(0, 100).flatMap(part => {
      let scope;
      try { scope = inspectDmlScope(text.slice(part.start, part.end), sqlMode); }
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
    if(require('./federated-select').isFederatedDocument(document)){collection.delete(document.uri);return {state:'disabled',statements:[]};}
    const key=document.uri.toString(),previous=cache.get(key);
    let preview=vscode.workspace.isTrusted?ddlPreviews.get(key):null;
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
    const seed=preview?.type==='local'?preview.model:metadata;
    if(previous?.version===document.version&&previous.epoch===epoch&&previous.preview===preview)return previous.value;
    const text=document.getText(),opts=options();
    let statements=[];
    if(Buffer.byteLength(text)>128*1024){collection.set(document.uri,[new vscode.Diagnostic(new vscode.Range(0,0,0,0),'SQL analysis is limited to 128 KiB per document.',vscode.DiagnosticSeverity.Information)]);return {state:'unknown',reason:'document-size-limit',statements:[]};}
    if (!seed) {
      const parts = engine().statementRanges(text, opts).statements;
      collection.set(document.uri, dmlDiagnostics(document, text, parts, undefined));
      return { state:'not-connected', statements:[] };
    }
    const split=preview?null:engine().statementRanges(text,opts);
    const virtual=preview?require('./ddl-model').analyzeDdlScript(text,seed):null;
    const parts=split?.statements||[];
    let contextChanged=false;
    statements=virtual?.statements||parts.slice(0,100).map(part=>{
      const priorContextChange=contextChanged;
      const source=text.slice(part.start,part.end),model=engine().analyzeSql(source,contextChanged?{tables:[],views:[],complete:false}:metadata,contextChanged?{...opts,catalogComplete:false,sqlMode:undefined}:opts);
      const head=source.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/g,'');
      if(/^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET)\b/i.test(head)||/\/\*!/.test(source))contextChanged=true;
      return {start:part.start,end:part.end,model,priorContextChange};
    });
    const cached = preview?.type === 'local' ? undefined : metadata?.cachedMetadata;
    const diagnostics=dmlDiagnostics(document, text, statements, opts.sqlMode);
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
      item.source=cached?'Rocketbrain SQL (cached metadata)':virtual?'Rocketbrain SQL (virtual DDL preview)':'Rocketbrain SQL (source model)';item.code=issue.code;diagnostics.push(item);
    }
    for(const issue of virtual?.unknown||[]){
      const at=document.positionAt(issue.start||0);
      const item=new vscode.Diagnostic(new vscode.Range(at,at),issue.reason,vscode.DiagnosticSeverity.Information);
      item.source='Rocketbrain SQL (virtual DDL preview)';item.code='sql.virtual.incomplete';diagnostics.push(item);
    }
    collection.set(document.uri,diagnostics.slice(0,500));
    const states=statements.map(s=>s.model.state),value={state:states.includes('invalid')?'invalid':states.includes('unknown')||contextChanged||parts.length>100||split?.unknown.length?'unknown':'known',contextMayChange:contextChanged,unknown:split?.unknown||[],catalogObservedAt:metadata?.loadedAt||null,catalogVisibility:metadata?.visibility||'not-observed',validityVerified:false,executedSql:false,statements};
    if(virtual)Object.assign(value,{state:virtual.state,contextMayChange:virtual.contextMayChange,
      unknown:virtual.unknown,catalogObservedAt:seed.loadedAt||null,catalogVisibility:seed.visibility,
      virtualPreview:true,ddlChanges:virtual.changes,...(preview.configuredScope?{configuredScope:preview.configuredScope}:{})});
    if (cached) Object.assign(value, { state: 'unknown', cachedMetadata: structuredClone(cached) });
    cache.set(key,{version:document.version,epoch,preview,value});return value;
  }
  function locate(document,position){const offset=document.offsetAt(position),report=analyzeDocument(document),statement=report.statements.find(s=>offset>=s.start&&offset<=s.end);return statement?{...statement,offset:offset-statement.start}:null;}
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
  function provideHover(document,position){
    const scope=locate(document,position);
    if(!scope)return null;
    const value=engine().hoverAt(scope.model,scope.offset),markdown=new vscode.MarkdownString();
    if(value)markdown.appendText(value);
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
    if(token?.isCancellationRequested)throw new Error('SQL rename was cancelled.');
    if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before renaming SQL symbols.');
    if(virtualActive(document))throw new Error('Exit the virtual DDL preview before renaming SQL symbols.');
    if(metadata?.cachedMetadata)throw new Error('Connect and refresh live metadata before renaming SQL symbols.');
    if(!metadata)throw new Error('Refresh SQL metadata before renaming a local symbol.');
    if(document.languageId!=='sql')throw new Error('Open a SQL document first.');
    const text=document.getText(),scope=locate(document,position);
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
        recognizedFragments:recognizedJavaFragments,references:javaReferences},
      dml:{readReferences:references.filter(ref=>ref.usage==='read').length,writeReferences:references.filter(ref=>ref.usage==='write').length},
      sourceRenameEligible:unknownFiles.length===0&&javaReferences===0&&!references.some(ref=>ref.command),
      embeddedSql:'Recognized native Java SQL in selected Java roots. Other embedded languages and runtime strings are outside scope.'};
    return {target,frame,...scope,options:opts,metadata:observed,inventory:inventory.files.map(u=>u.toString()),documents,references,coverage};
  }
  function publicProjectReport(scan){return structuredClone({target:scan.target,references:scan.references,coverage:scan.coverage,executedSql:false});}
  async function findCatalogReferences(target,token,scanOptions={}){const scan=await scanProject(target,token,scanOptions);return lastProjectReport=publicProjectReport(scan);}
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
    if(virtualActive(document))return null;
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
    const documents=scan.documents.map(record=>({...record,changes:record.language==='java'?[]:projectEngine().planCatalogDocumentRename(record.text,scan.metadata,scan.options,scan.target,newName).edits}));
    const plan={id:crypto.randomUUID(),createdAt:Date.now(),...scan,documents,newName};
    for(const [id,value]of projectPlans)if(Date.now()-value.createdAt>120000)projectPlans.delete(id);while(projectPlans.size>=5)projectPlans.delete(projectPlans.keys().next().value);projectPlans.set(plan.id,plan);
    await validateCatalogRename(plan.id,token);
    const edit=buildCatalogEdit(plan);return {id:plan.id,target:structuredClone(plan.target),newName,edit,edits:edit,expiresAt:plan.createdAt+120000,documents:structuredClone(documents.map(r=>({uri:r.uri,version:r.version,hash:r.hash,edits:r.changes}))),coverage:structuredClone(plan.coverage),executedSql:false,atomicWithDatabaseDDL:false};
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
    if(!config().get('enabled',true)||virtualActive(document)||!metadata||metadata.cachedMetadata||!vscode.workspace.isTrusted)return [];
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
    return analyzeDocument(document);
  }
  function clearDdlPreview(document){
    if(!document||!ddlPreviews.delete(document.uri.toString()))return false;
    cache.delete(document.uri.toString());
    if(!document.isClosed)analyzeDocument(document);
    return true;
  }
  subscriptions.push(vscode.languages.registerCompletionItemProvider({language:'sql'}, {provideCompletionItems(document,position){const scope=locate(document,position);if(!scope)return [];return engine().completionsAt(scope.model,scope.offset).map(value=>{const item=new vscode.CompletionItem(value.label,value.kind==='column'?vscode.CompletionItemKind.Field:vscode.CompletionItemKind.Struct);item.detail=metadata?.cachedMetadata&&!virtualActive(document)?'Cached metadata · '+value.detail:value.detail;item.insertText=value.insertText||value.label;return item;});}},'.'));
  subscriptions.push(vscode.languages.registerCompletionItemProvider({language:'sql'}, {
    async provideCompletionItems(document,position,token) {
      if(disposed||!vscode.workspace.isTrusted||!config().get('enabled',true)||!metadata||virtualActive(document)||require('./federated-select').isFederatedDocument(document))return [];
      const text = document.getText(), offset = document.offsetAt(position), observed = options();
      const snapshot = metadata, version = document.version, generation = epoch;
      const current = () => !disposed && !token?.isCancellationRequested && !document.isClosed && document.version === version &&
        epoch === generation && snapshot === metadata && vscode.workspace.isTrusted && config().get('enabled', true) && !virtualActive(document);
      const candidates = [
        ...require('./sql-field-lists').sqlFieldLists(text, offset, snapshot, observed),
        ...await require('./foreign-key-joins').scopedForeignKeyJoins(text, offset, snapshot,
          { ...observed, readLogical: joinLogicalRelationships }, joinCatalog, current)
      ];
      if (!current()) return [];
      return candidates.map(candidate=>{
        const item=new vscode.CompletionItem(candidate.label, candidate.kind
          ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Reference);
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
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(event.document.languageId==='sql')analyzeDocument(event.document);}),vscode.workspace.onDidCloseTextDocument(document=>{cache.delete(document.uri.toString());navigationCache.delete(document.uri.toString());ddlPreviews.delete(document.uri.toString());preparedRenames.delete(document.uri.toString());collection.delete(document.uri);}),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.sql.analysis')){scopeCache.clear();navigationCache.clear();reanalyze();}}));
  if(onDidChangeDatabase)subscriptions.push(onDidChangeDatabase(value=>{
    for(const [uri,preview] of ddlPreviews)if(preview.type==='observed')ddlPreviews.delete(uri);
    invalidate();
    if(value?.metadata)metadata=value.metadata;
    reanalyze();
  }));
  const command=(name,action)=>subscriptions.push(vscode.commands.registerCommand(name,async()=>{try{return await action();}catch(error){output?.appendLine(error.message);await vscode.window.showErrorMessage('Rocketbrain SQL: '+error.message);}}));
  command('rocketbrain.sql.refreshAnalysisMetadata',refreshMetadata);
  command('rocketbrain.sql.previewDdl',async()=>{
    const document=vscode.window.activeTextEditor?.document;
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
  command('rocketbrain.sql.clearDdlPreview',()=>clearDdlPreview(vscode.window.activeTextEditor?.document));
  command('rocketbrain.sql.findReferences',async()=>{
    const editor=vscode.window.activeTextEditor;
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
  command('rocketbrain.sql.analyze',async()=>{const document=vscode.window.activeTextEditor?.document;if(!document||document.languageId!=='sql')throw new Error('Open a SQL document first.');if(!virtualActive(document)&&!metadata?.cachedMetadata)await refreshMetadata();const report=analyzeDocument(document);output?.appendLine('SQL source analysis: '+report.state+'; '+report.statements.length+' statements. No user query was executed.');return report;});
  if(vscode.workspace.onDidChangeWorkspaceFolders)subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{projectGeneration++;projectPlans.clear();lastProjectReport=null;}));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.sql.project')){projectGeneration++;projectPlans.clear();lastProjectReport=null;}}));
  return {analyzeDocument,refreshMetadata,useDdlPreview,clearDdlPreview,virtualActive,prepareRename,renameDocument,findCatalogReferences,catalogTargetAt,planCatalogRename,validateCatalogRename,catalogRenameEdit,projectSnapshot:()=>lastProjectReport?structuredClone(lastProjectReport):null,invalidate,onDidChange:events.event,snapshot:()=>metadata?{database:metadata.database,dialect:metadata.dialect,loadedAt:metadata.loadedAt}:null,dispose(){disposed=true;scopeCache.clear();ddlPreviews.clear();preparedRenames.clear();projectPlans.clear();invalidate();for(const sub of subscriptions)sub.dispose();}};
}
module.exports={registerSQLAnalysis};
