'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{pathToFileURL,fileURLToPath}=require('node:url');
const {registerSQLAnalysis}=require('../src/db/sql-vscode');
const catalog={database:'app',dialect:'mysql',sqlMode:[],tableNameCaseSensitive:false,loadedAt:'now',coverage:{tables:'loaded',columns:'loaded'},tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false}]}],views:[]};
function host(files){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rb-sql-project-')),docs=new Map(),providers={},events={},commands=new Map();let roots=[],javaRoots=[],enabled=true,currentCatalog=structuredClone(catalog),onOpen;
 for(const [name,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),text);}
 const uri=file=>({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
 class Event{listeners=new Set();event=fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)};};fire(value){for(const fn of this.listeners)fn(value);}dispose(){}}
 class Range{constructor(start,end){this.start=start;this.end=end;}}
 class WorkspaceEdit{changes=[];replace(uri,range,newText,metadata){this.changes.push({uri,range,newText,metadata});}}
 const document=async value=>{const key=value.toString();if(!docs.has(key)){const d={uri:value,languageId:/\.java$/i.test(value.fsPath)?'java':'sql',version:1,isClosed:false,text:fs.readFileSync(value.fsPath,'utf8'),getText(){return this.text;},positionAt(offset){const lines=this.text.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};},offsetAt(p){return this.text.split('\n').slice(0,p.line).reduce((sum,l)=>sum+l.length+1,0)+p.character;}};docs.set(key,d);}if(onOpen)await onOpen(value);return docs.get(key);};
 const vscode={EventEmitter:Event,Range,WorkspaceEdit,RelativePattern:class{constructor(base,pattern){Object.assign(this,{base,pattern});}},Uri:{file:uri,parse:value=>uri(fileURLToPath(value))},Location:class{constructor(uri,range){Object.assign(this,{uri,range});}},DiagnosticSeverity:{Error:0,Warning:1,Information:2},Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},languages:{createDiagnosticCollection:()=>({clear(){},set(){},delete(){},dispose(){}})},window:{showErrorMessage:async()=>{}},commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return{dispose(){}};}},workspace:{isTrusted:true,workspaceFolders:[{uri:uri(root)}],get textDocuments(){return [...docs.values()];},getConfiguration:()=>({get:(key,fallback)=>key==='roots'?roots:key==='javaRoots'?javaRoots:key==='enabled'?enabled:fallback}),openTextDocument:document,findFiles:async pattern=>{const all=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(/\.(?:sql|java)$/i.test(e.name))all.push(uri(file));}}walk(pattern.base||root);return all;}}};
 for(const name of ['onDidChangeTextDocument','onDidCloseTextDocument','onDidChangeConfiguration','onDidChangeWorkspaceFolders']){events[name]=new Event();vscode.workspace[name]=events[name].event;}
 for(const [name,key]of [['registerCompletionItemProvider','completion'],['registerHoverProvider','hover'],['registerDefinitionProvider','definition'],['registerRenameProvider','rename'],['registerReferenceProvider','references']])vscode.languages[name]=(selector,provider)=>{providers[key]=provider;return{dispose(){}};};
 const connection=new Event(),api=registerSQLAnalysis({},vscode,{catalog:async()=>currentCatalog,catalogSnapshot:()=>currentCatalog,onDidChangeDatabase:connection.event});
 return {api,vscode,root,providers,events,connection,commands,uri:relative=>uri(path.join(root,relative)),doc:name=>document(uri(path.join(root,name))),set roots(value){roots=value;},set javaRoots(value){javaRoots=value;},set enabled(value){enabled=value;},set onOpen(value){onOpen=value;},set catalog(value){currentCatalog=value;},async dispose(){api.dispose();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('rb-sql-project-'));fs.rmSync(root,{recursive:true,force:true});}};
}
const target={kind:'column',database:'app',table:'people',column:'name'};
test('workspace references and source rename cover two files, preserve aliases and expose versioned review edits',async()=>{
 const h=host({'a.sql':"SELECT p.name FROM people p WHERE p.name<>'name'",'queries/b.sql':'WITH x AS (SELECT name FROM people) SELECT x.name FROM x'});
 try{const found=await h.api.findCatalogReferences(target);assert.equal(found.coverage.complete,true);assert.equal(found.references.length,4);assert.equal(new Set(found.references.map(r=>r.uri)).size,2);const plan=await h.api.planCatalogRename(target,'title');assert.equal(plan.documents.length,2);assert.equal(plan.edit.changes.length,4);assert.ok(plan.edit.changes.every(c=>c.metadata.needsConfirmation));assert.equal((await h.doc('a.sql')).getText(),"SELECT p.name FROM people p WHERE p.name<>'name'");assert.equal((await h.api.validateCatalogRename(plan.id)).state,'fresh');plan.documents[0].edits[0].newText='BAD';plan.coverage.roots.length=0;plan.target.column='BAD';const reviewed=await h.api.catalogRenameEdit(plan.id,undefined,{reviewed:true});assert.ok(reviewed.changes.every(c=>!c.metadata.needsConfirmation));assert.ok(reviewed.changes.every(c=>c.newText==='`title`'),'Public review DTO mutation cannot replace private approved source edits');
 const doc=await h.doc('a.sql'),locations=await h.providers.references.provideReferences(doc,doc.positionAt(doc.getText().indexOf('p.name')+2),{includeDeclaration:true});assert.equal(locations.length,4);
 }finally{await h.dispose();}
});

test('registered ReferencesProvider goes both directions across opt-in Java and SQL roots',async()=>{
 const source='import org.springframework.jdbc.core.JdbcTemplate; class Probe { void f(JdbcTemplate jdbc) { jdbc.query("SELECT p.name FROM people p WHERE p.id = ?"); } }';
 const h=host({'queries/read.sql':'SELECT p.name FROM people p','src/Probe.java':source,'ignored/Probe.java':source});
 try{
  h.roots=[path.join(h.root,'queries')];
  const java=await h.doc('src/Probe.java'), sql=await h.doc('queries/read.sql');
  const position=java.positionAt(source.indexOf('p.name')+3);
  assert.deepEqual(await h.providers.references.provideReferences(java,position),[]);
  h.javaRoots=[path.join(h.root,'src')];
  const found=await h.api.findCatalogReferences(target);
  assert.equal(found.coverage.complete,true);assert.equal(found.coverage.sourceRenameEligible,false);assert.equal(found.coverage.analyzedFiles,2);
  assert.deepEqual(h.api.catalogTargetAt(java,position),target);
  for(const [doc,at] of [[java,position],[sql,sql.positionAt(sql.getText().indexOf('p.name')+3)]]){
   const locations=await h.providers.references.provideReferences(doc,at);
   assert.equal(locations.length,2);
   assert.deepEqual(locations.map(value=>path.basename(value.uri.fsPath)).sort(),['Probe.java','read.sql']);
  }
  await assert.rejects(h.api.planCatalogRename(target,'renamed'),{code:'SQL_PROJECT_EMBEDDED_READ_ONLY'});
 }finally{await h.dispose();}
});
test('source rename rejects buffer edits, closed-file disk changes and added/removed SQL files',async()=>{
 const h=host({'a.sql':'SELECT name FROM people','b.sql':'SELECT id FROM people'});
 try{let p=await h.api.planCatalogRename(target,'title'),doc=await h.doc('a.sql');doc.text+=' ';doc.version++;await assert.rejects(h.api.validateCatalogRename(p.id),/buffer changed/);
 p=await h.api.planCatalogRename(target,'title');fs.appendFileSync(path.join(h.root,'b.sql'),' ');await assert.rejects(h.api.validateCatalogRename(p.id),/disk/);
 p=await h.api.planCatalogRename(target,'title');fs.writeFileSync(path.join(h.root,'new.sql'),'SELECT id FROM people');await assert.rejects(h.api.validateCatalogRename(p.id),/file set/);fs.unlinkSync(path.join(h.root,'new.sql'));
 p=await h.api.planCatalogRename(target,'title');fs.unlinkSync(path.join(h.root,'b.sql'));await assert.rejects(h.api.validateCatalogRename(p.id),/file set/);
 }finally{await h.dispose();}
});
test('metadata changes require a new plan except explicit post-DDL completion while file guards remain active',async()=>{
 const h=host({'a.sql':'SELECT name FROM people'});
 try{const p=await h.api.planCatalogRename(target,'title');h.catalog={...catalog,tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'title',type:'varchar(100)',nullable:false}]}]};await h.api.refreshMetadata();await assert.rejects(h.api.validateCatalogRename(p.id),/metadata or connection changed/);assert.equal((await h.api.validateCatalogRename(p.id,undefined,{allowCatalogChange:true})).rootMustVerifyDatabaseDDL,true);assert.equal((await h.api.catalogRenameEdit(p.id,undefined,{allowCatalogChange:true,reviewed:true})).changes.length,1);const doc=await h.doc('a.sql');doc.text+=' ';doc.version++;await assert.rejects(h.api.catalogRenameEdit(p.id,undefined,{allowCatalogChange:true}),/buffer changed/);
 }finally{await h.dispose();}
});
test('unsupported migration files are explicit partial coverage and query-root scope narrows the honest source plan',async()=>{
 const h=host({'queries/a.sql':'SELECT name FROM people','migration.sql':'ALTER TABLE people ADD age int'});
 try{const result=await h.api.findCatalogReferences(target);assert.equal(result.coverage.complete,false);assert.equal(result.references.length,1);assert.ok(result.coverage.unknownFiles.some(f=>f.uri.endsWith('/migration.sql')));await assert.rejects(h.api.planCatalogRename(target,'title'),e=>e.code==='SQL_PROJECT_INCOMPLETE');const scoped=await h.api.planCatalogRename(target,'title',undefined,{scope:{roots:[path.join(h.root,'queries')]}});assert.equal(scoped.coverage.complete,true);assert.equal(scoped.documents.length,1);h.roots=[os.tmpdir()];await assert.rejects(h.api.findCatalogReferences(target),/inside an open local workspace/);
 }finally{await h.dispose();}
});
test('local ReferencesProvider preserves shadow boundaries and respects declaration inclusion',async()=>{
 const text='SELECT p.name FROM people p WHERE EXISTS (SELECT 1 FROM people p WHERE p.id>0)',h=host({'a.sql':text});
 try{const doc=await h.doc('a.sql'),withDecl=await h.providers.references.provideReferences(doc,doc.positionAt(text.indexOf('p.name')),{includeDeclaration:true}),without=await h.providers.references.provideReferences(doc,doc.positionAt(text.indexOf('p.name')),{includeDeclaration:false});assert.equal(withDecl.length,2);assert.equal(without.length,1);assert.ok(withDecl.every(l=>doc.offsetAt(l.range.start)<text.indexOf('EXISTS')));
 }finally{await h.dispose();}
});
test('project APIs reject cancellation, trust loss, configuration changes and disposal',async()=>{
 const h=host({'a.sql':'SELECT name FROM people'});
 try{await assert.rejects(h.api.findCatalogReferences(target,{isCancellationRequested:true}),/cancelled/);h.vscode.workspace.isTrusted=false;await assert.rejects(h.api.planCatalogRename(target,'title'),/Trust/);h.vscode.workspace.isTrusted=true;h.enabled=false;await assert.rejects(h.api.findCatalogReferences(target),/disabled/);const doc=await h.doc('a.sql');assert.deepEqual(await h.providers.references.provideReferences(doc,doc.positionAt(7)),[]);h.enabled=true;const p=await h.api.planCatalogRename(target,'title');h.events.onDidChangeConfiguration.fire({affectsConfiguration:key=>key==='rocketbrain.sql.project'});await assert.rejects(h.api.validateCatalogRename(p.id),/expired/);h.api.dispose();await assert.rejects(h.api.findCatalogReferences(target),/closed/);
 }finally{await h.dispose();}
});
test('an earlier source edit during a later awaited document invalidates the entire inspection and completion',async()=>{
 const h=host({'a.sql':'SELECT name FROM people','b.sql':'SELECT id FROM people'});
 try{const first=await h.doc('a.sql');let changed=false;h.onOpen=async uri=>{if(uri.fsPath.endsWith('b.sql')&&!changed){changed=true;first.text+=' ';first.version++;}};await assert.rejects(h.api.findCatalogReferences(target),/buffer changed/);h.onOpen=undefined;const p=await h.api.planCatalogRename(target,'title');changed=false;h.onOpen=async uri=>{if(uri.fsPath.endsWith('b.sql')&&!changed){changed=true;first.text+=' ';first.version++;}};await assert.rejects(h.api.validateCatalogRename(p.id),/buffer changed/);
 }finally{await h.dispose();}
});
