'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fileURLToPath}=require('node:url');
const { inspectDmlScope } = require('./sql-dml-scope');

function registerSQLAnalysis(context,vscode,{catalog,catalogSnapshot,onDidChangeDatabase,output}={}) {
  const collection=vscode.languages.createDiagnosticCollection('rocketbrain-sql');
  const events=new vscode.EventEmitter(),subscriptions=[collection,events];
  let metadata=catalogSnapshot?.()||null,epoch=0,request=0,disposed=false;
  const cache=new Map(),preparedRenames=new Map(),projectPlans=new Map(),ddlPreviews=new Map();let projectGeneration=0,lastProjectReport=null;
  const resolutionScopes=require('./sql-resolution-scopes');
  const scopeCache=new Map();
  const engine=()=>require('./sql-analysis');
  const config=()=>vscode.workspace.getConfiguration('rocketbrain.sql.analysis');
  function invalidate(){epoch++;request++;metadata=null;cache.clear();collection.clear();if(!disposed)events.fire();}
  function options(){return {dialect:metadata?.dialect||'mysql',database:metadata?.database,catalogComplete:Boolean(metadata?.coverage?.tables==='loaded'&&metadata?.coverage?.columns==='loaded'),tableNameCaseSensitive:metadata?.tableNameCaseSensitive,sqlMode:metadata?.sqlMode};}
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
      const source=text.slice(part.start,part.end),model=engine().analyzeSql(source,contextChanged?{tables:[],views:[],complete:false}:metadata,contextChanged?{...opts,catalogComplete:false,sqlMode:undefined}:opts);
      const head=source.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/g,'');
      if(/^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET)\b/i.test(head)||/\/\*!/.test(source))contextChanged=true;
      return {start:part.start,end:part.end,model};
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
    const configured=scanOptions.scope?.roots??vscode.workspace.getConfiguration('rocketbrain.sql.project').get('roots',[]);
    if(!Array.isArray(configured)||configured.length>20)throw new Error('Configure at most20 local SQL query roots.');
    const selected=configured.length?configured:folders;
    return [...new Set(selected.map(raw=>{
      if(typeof raw!=='string'||!raw||raw.includes('\0'))throw new Error('Use local SQL query-root paths.');
      if(!path.isAbsolute(raw)&&!raw.startsWith('file:')&&folders.length!==1)throw new Error('Use absolute SQL query-root paths in a multi-folder workspace.');
      const file=raw.startsWith('file:')?fileURLToPath(raw):path.resolve(folders[0],raw),real=fs.realpathSync(file);
      if(!folders.some(root=>inside(root,file)&&inside(fs.realpathSync(root),real))||!fs.statSync(real).isDirectory())throw new Error('SQL query roots and links must stay inside an open local workspace.');
      return real;
    }))].sort();
  }
  const projectExclude='**/{node_modules,.git,.vscode-test,test-output,build,target,bin,out,.gradle,dist}/**';
  async function projectFiles(roots,token){
    const found=new Map();let limited=false;
    for(const root of roots){projectTrusted(token);const pattern=vscode.RelativePattern?new vscode.RelativePattern(root,'**/*.{sql,SQL}'): '**/*.{sql,SQL}';
      const files=await vscode.workspace.findFiles(pattern,projectExclude,201,token);projectTrusted(token);
      if(files.length>200)limited=true;
      for(const uri of files){if(uri.scheme!=='file'||!inside(root,uri.fsPath))continue;found.set(uri.toString(),uri);if(found.size>200)limited=true;}
    }
    return {files:[...found.values()].sort((a,b)=>a.toString().localeCompare(b.toString())),limited};
  }
  function assertProjectFrame(frame,token,{allowCatalogChange=false}={}){
    projectTrusted(token);if(frame.projectGeneration!==projectGeneration)throw new Error('SQL query roots or workspace configuration changed. Review the rename again.');
    if(!allowCatalogChange&&frame.epoch!==epoch)throw new Error('SQL project metadata or connection changed. Review the rename again.');
    if(frame.database!==metadata.database||frame.dialect!==metadata.dialect)throw new Error('The SQL project database changed. Review the rename again.');
  }
  function assertSourceRecord(record){
    const stat=fs.lstatSync(record.file);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(record.file)!==record.file||stat.size>128*1024||textHash(fs.readFileSync(record.file,'utf8'))!==record.diskHash)throw new Error('SQL source changed on disk. Review the rename again.');
    if(record.document.isClosed||record.document.version!==record.version||textHash(record.document.getText())!==record.hash)throw new Error('SQL source buffer changed. Review the rename again.');
  }
  async function scanProject(target,token,scanOptions={}){
    projectTrusted(token);const roots=projectRoots(scanOptions),frame={epoch,projectGeneration,database:metadata.database,dialect:metadata.dialect},observed=structuredClone(metadata),opts=options();
    target=projectEngine().normalizeTarget(target,observed,opts);
    const inventory=await projectFiles(roots,token);assertProjectFrame(frame,token);
    const documents=[],unknownFiles=[],references=[];let totalBytes=0;
    if(inventory.limited)unknownFiles.push({reason:'SQL project scanning is limited to200 files.'});
    for(const uri of inventory.files.slice(0,200)){
      projectTrusted(token);assertProjectFrame(frame,token);
      if(configuredScope({uri})){
        unknownFiles.push({uri:uri.toString(),reason:'A local DDL resolution scope supplies this SQL file’s catalog.'});
        continue;
      }
      try{
        const stat=fs.lstatSync(uri.fsPath),real=fs.realpathSync(uri.fsPath);
        if(!stat.isFile()||stat.isSymbolicLink()||!roots.some(root=>inside(root,real)))throw new Error('SQL files must be regular local files inside the selected query roots.');
        if(stat.size>128*1024)throw new Error('SQL project files are limited to128KiB.');
        totalBytes+=stat.size;if(totalBytes>8*1024*1024)throw new Error('SQL project scanning is limited to8MiB.');
        const disk=fs.readFileSync(real,'utf8'),document=await vscode.workspace.openTextDocument(uri);assertProjectFrame(frame,token);
        if(document.isClosed)throw new Error('The SQL source document closed during project inspection.');
        const text=document.getText();totalBytes+=Math.max(0,Buffer.byteLength(text)-stat.size);if(totalBytes>8*1024*1024)throw new Error('SQL project scanning is limited to8MiB.');
        const report=projectEngine().analyzeProjectDocument(text,observed,opts),record={uri:uri.toString(),file:real,document,version:document.version,hash:textHash(text),diskHash:textHash(disk),text,report};documents.push(record);
        references.push(...projectEngine().referencesInDocument(report,target,opts).map(ref=>({...ref,uri:record.uri})));
        if(report.unknown.length)unknownFiles.push({uri:record.uri,reasons:report.unknown.slice(0,10),reason:'Not every SQL statement has a supported, resolved binding.'});
      }catch(error){assertProjectFrame(frame,token);unknownFiles.push({uri:uri.toString(),reason:error.message});}
    }
    const completedInventory=await projectFiles(roots,token);assertProjectFrame(frame,token);if(completedInventory.limited!==inventory.limited||JSON.stringify(completedInventory.files.map(u=>u.toString()))!==JSON.stringify(inventory.files.map(u=>u.toString())))throw new Error('The SQL project file set changed during inspection. Try again.');for(const record of documents)assertSourceRecord(record);
    const coverage={complete:unknownFiles.length===0,scope:'selected-local-sql-roots',roots,excluded:projectExclude,files:inventory.files.length,analyzedFiles:documents.length,totalBytes,limits:{files:200,fileBytes:128*1024,totalBytes:8*1024*1024},unknownFiles,embeddedSql:'Java strings and other embedded/dynamic SQL are outside this source index.'};
    return {target,frame,roots,options:opts,metadata:observed,inventory:inventory.files.map(u=>u.toString()),documents,references,coverage};
  }
  function publicProjectReport(scan){return structuredClone({target:scan.target,references:scan.references,coverage:scan.coverage,executedSql:false});}
  async function findCatalogReferences(target,token,scanOptions={}){const scan=await scanProject(target,token,scanOptions);return lastProjectReport=publicProjectReport(scan);}
  function catalogTargetAt(document,position){
    if(virtualActive(document))return null;
    projectTrusted();const report=projectEngine().analyzeProjectDocument(document.getText(),metadata,options()),target=projectEngine().targetAtDocument(report,document.offsetAt(position),options());
    return target?.kind==='local'?null:target;
  }
  function buildCatalogEdit(plan,{reviewed=false}={}){
    const edit=new vscode.WorkspaceEdit();for(const record of plan.documents)for(const change of record.changes)edit.replace(vscode.Uri.parse(record.uri),new vscode.Range(record.document.positionAt(change.start),record.document.positionAt(change.end)),change.newText,{label:'Rename physical SQL reference',needsConfirmation:!reviewed});return edit;
  }
  async function planCatalogRename(target,newName,token,scanOptions={}){
    const scan=await scanProject(target,token,scanOptions);lastProjectReport=publicProjectReport(scan);
    if(!scan.coverage.complete)throw Object.assign(new Error('Unsupported, incomplete or excluded-by-limit SQL prevents a complete source rename plan. Select query-only roots or review a database-only rename explicitly.'),{code:'SQL_PROJECT_INCOMPLETE',coverage:scan.coverage});
    const documents=scan.documents.map(record=>({...record,changes:projectEngine().planCatalogDocumentRename(record.text,scan.metadata,scan.options,scan.target,newName).edits}));
    const plan={id:crypto.randomUUID(),createdAt:Date.now(),...scan,documents,newName};
    for(const [id,value]of projectPlans)if(Date.now()-value.createdAt>120000)projectPlans.delete(id);while(projectPlans.size>=5)projectPlans.delete(projectPlans.keys().next().value);projectPlans.set(plan.id,plan);
    await validateCatalogRename(plan.id,token);
    const edit=buildCatalogEdit(plan);return {id:plan.id,target:structuredClone(plan.target),newName,edit,edits:edit,expiresAt:plan.createdAt+120000,documents:structuredClone(documents.map(r=>({uri:r.uri,version:r.version,hash:r.hash,edits:r.changes}))),coverage:structuredClone(plan.coverage),executedSql:false,atomicWithDatabaseDDL:false};
  }
  async function validateCatalogRename(id,token,validationOptions={}){
    const plan=projectPlans.get(typeof id==='string'?id:id?.id);if(!plan||Date.now()-plan.createdAt>120000)throw new Error('The SQL source rename plan expired. Review it again.');
    assertProjectFrame(plan.frame,token,validationOptions);for(const root of plan.roots)if(fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())throw new Error('SQL query roots changed on disk. Review the rename again.');const inventory=await projectFiles(plan.roots,token);assertProjectFrame(plan.frame,token,validationOptions);
    if(inventory.limited||JSON.stringify(inventory.files.map(u=>u.toString()))!==JSON.stringify(plan.inventory))throw new Error('The SQL project file set changed. Review the rename again.');
    for(const record of plan.documents){
      assertSourceRecord(record);
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(record.uri));assertProjectFrame(plan.frame,token,validationOptions);
      if(document.isClosed||document.version!==record.version||textHash(document.getText())!==record.hash)throw new Error('SQL source buffer changed. Review the rename again.');record.document=document;
    }
    const finalInventory=await projectFiles(plan.roots,token);assertProjectFrame(plan.frame,token,validationOptions);if(finalInventory.limited||JSON.stringify(finalInventory.files.map(u=>u.toString()))!==JSON.stringify(plan.inventory))throw new Error('The SQL project file set changed. Review the rename again.');for(const record of plan.documents)assertSourceRecord(record);
    return {state:'fresh',id:plan.id,documents:plan.documents.length,catalogChangeAllowed:validationOptions.allowCatalogChange===true,rootMustVerifyDatabaseDDL:validationOptions.allowCatalogChange===true};
  }
  async function catalogRenameEdit(id,token,validationOptions={}){await validateCatalogRename(id,token,validationOptions);return buildCatalogEdit(projectPlans.get(typeof id==='string'?id:id?.id),validationOptions);}
  async function provideReferences(document,position,context={},token){
    if(!config().get('enabled',true)||virtualActive(document)||metadata?.cachedMetadata)return [];
    projectTrusted(token);const report=projectEngine().analyzeProjectDocument(document.getText(),metadata,options()),selected=projectEngine().targetAtDocument(report,document.offsetAt(position),options());if(!selected)return [];
    if(selected.kind==='local')return selected.statement.model.references.filter(ref=>!ref.implicit&&ref.start<ref.end&&sameDefinition(ref.definition,selected.definition)&&(context.includeDeclaration||!ref.kind.endsWith('-definition'))).map(ref=>new vscode.Location(document.uri,new vscode.Range(document.positionAt(selected.statement.start+ref.start),document.positionAt(selected.statement.start+ref.end))));
    const found=await findCatalogReferences(selected,token),locations=found.references.map(ref=>new vscode.Location(vscode.Uri.parse(ref.uri),new vscode.Range(ref.range.start,ref.range.end)));
    if(!found.coverage.complete){vscode.window.setStatusBarMessage?.('SQL references are partial: '+found.coverage.unknownFiles.length+' unsupported or incomplete file(s). Select query-only roots for a complete supported index.',10000);output?.appendLine('SQL project reference coverage: '+JSON.stringify(found.coverage));}
    if(!found.references.some(ref=>ref.uri===document.uri.toString()))for(const ref of projectEngine().referencesInDocument(report,selected,options()))locations.push(new vscode.Location(document.uri,new vscode.Range(ref.range.start,ref.range.end)));
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
    provideCompletionItems(document,position) {
      if(disposed||!vscode.workspace.isTrusted||!config().get('enabled',true)||!metadata||virtualActive(document))return [];
      const text = document.getText(), offset = document.offsetAt(position), observed = options();
      const candidates = [
        ...require('./sql-field-lists').sqlFieldLists(text, offset, metadata, observed),
        ...require('./foreign-key-joins').foreignKeyJoins(text, offset, metadata, observed)
      ];
      return candidates.map(candidate=>{
        const item=new vscode.CompletionItem(candidate.label, candidate.kind
          ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Reference);
        item.detail=candidate.detail;
        item.insertText=candidate.insertText;
        item.range=new vscode.Range(document.positionAt(candidate.start),document.positionAt(candidate.end));
        return item;
      });
    }
  },' '));
  subscriptions.push(vscode.languages.registerDefinitionProvider({language:'sql'}, {provideDefinition(document,position){const scope=locate(document,position);if(!scope)return [];return engine().definitionsAt(scope.model,scope.offset).map(value=>new vscode.Location(document.uri,new vscode.Range(document.positionAt(scope.start+value.start),document.positionAt(scope.start+value.end))));}}));
  subscriptions.push(vscode.languages.registerHoverProvider({language:'sql'}, {provideHover(document,position){const scope=locate(document,position);if(!scope)return;const value=engine().hoverAt(scope.model,scope.offset);if(!value)return;const markdown=new vscode.MarkdownString();markdown.appendText(value);if(metadata?.cachedMetadata&&!virtualActive(document))markdown.appendText('\nCached metadata captured '+metadata.cachedMetadata.capturedAt);return new vscode.Hover(markdown);}}));
  if(vscode.languages.registerRenameProvider)subscriptions.push(vscode.languages.registerRenameProvider({language:'sql'},{prepareRename,provideRenameEdits:renameDocument}));
  if(vscode.languages.registerReferenceProvider)subscriptions.push(vscode.languages.registerReferenceProvider({language:'sql'},{provideReferences}));
  if(vscode.workspace.onDidOpenTextDocument)subscriptions.push(vscode.workspace.onDidOpenTextDocument(document=>{
    if(document.languageId==='sql'&&configuredScope(document))analyzeDocument(document);
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(event.document.languageId==='sql')analyzeDocument(event.document);}),vscode.workspace.onDidCloseTextDocument(document=>{cache.delete(document.uri.toString());ddlPreviews.delete(document.uri.toString());preparedRenames.delete(document.uri.toString());collection.delete(document.uri);}),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.sql.analysis')){scopeCache.clear();reanalyze();}}));
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
  command('rocketbrain.sql.findReferences',async()=>{const editor=vscode.window.activeTextEditor;if(!editor||editor.document.languageId!=='sql')throw new Error('Open a SQL document first.');const locations=await provideReferences(editor.document,editor.selection.active,{includeDeclaration:true});await vscode.commands.executeCommand('editor.action.showReferences',editor.document.uri,editor.selection.active,locations);return {references:locations.length,coverage:lastProjectReport?.coverage};});
  command('rocketbrain.sql.analyze',async()=>{const document=vscode.window.activeTextEditor?.document;if(!document||document.languageId!=='sql')throw new Error('Open a SQL document first.');if(!virtualActive(document)&&!metadata?.cachedMetadata)await refreshMetadata();const report=analyzeDocument(document);output?.appendLine('SQL source analysis: '+report.state+'; '+report.statements.length+' statements. No user query was executed.');return report;});
  if(vscode.workspace.onDidChangeWorkspaceFolders)subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{projectGeneration++;projectPlans.clear();}));
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.sql.project')){projectGeneration++;projectPlans.clear();}}));
  return {analyzeDocument,refreshMetadata,useDdlPreview,clearDdlPreview,virtualActive,prepareRename,renameDocument,findCatalogReferences,catalogTargetAt,planCatalogRename,validateCatalogRename,catalogRenameEdit,projectSnapshot:()=>lastProjectReport?structuredClone(lastProjectReport):null,invalidate,onDidChange:events.event,snapshot:()=>metadata?{database:metadata.database,dialect:metadata.dialect,loadedAt:metadata.loadedAt}:null,dispose(){disposed=true;scopeCache.clear();ddlPreviews.clear();preparedRenames.clear();projectPlans.clear();invalidate();for(const sub of subscriptions)sub.dispose();}};
}
module.exports={registerSQLAnalysis};
