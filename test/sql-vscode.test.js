'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSQLAnalysis}=require('../src/db/sql-vscode');
const catalog={database:'app',dialect:'mysql',sqlMode:[],tableNameCaseSensitive:false,visibility:'current-account',loadedAt:'observed',coverage:{tables:'loaded',columns:'loaded'},tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false}]}],views:[]};
function host(source,fetchCatalog=async()=>catalog){
  const events={};let collection=new Map();const providers={};let calls=0;
  class Emitter{listeners=new Set();event=fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)};};fire(value){for(const fn of this.listeners)fn(value);}dispose(){}}
  class Range{constructor(...args){if(args.length===2){this.start=args[0];this.end=args[1];}else{this.start={line:args[0],character:args[1]};this.end={line:args[2],character:args[3]};}}}
  const uri={toString:()=> 'file:///fixture/query.sql'},doc={uri,languageId:'sql',version:1,isClosed:false,getText:()=>source,positionAt:offset=>{const lines=source.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};},offsetAt:position=>source.split('\n').slice(0,position.line).reduce((sum,line)=>sum+line.length+1,0)+position.character};
  const vscode={EventEmitter:Emitter,Range,DiagnosticSeverity:{Error:0,Warning:1,Information:2},Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},CompletionItemKind:{Field:1,Struct:2},CompletionItem:class{constructor(label){this.label=label;}},MarkdownString:class{value='';appendText(value){this.value+=value;}},Hover:class{constructor(value){this.contents=[value];}},Location:class{constructor(value,range){this.uri=value;this.range=range;}},languages:{createDiagnosticCollection:()=>({clear:()=>collection.clear(),set:(uri,values)=>collection.set(uri.toString(),values),delete:uri=>collection.delete(uri.toString()),dispose(){}})},window:{activeTextEditor:{document:doc},showErrorMessage:async()=>{}},commands:{registerCommand:()=>({dispose(){}})},workspace:{isTrusted:true,textDocuments:[doc],getConfiguration:()=>({get:(key,value)=>value})}};
  for(const name of ['onDidChangeTextDocument','onDidCloseTextDocument','onDidChangeConfiguration']){events[name]=new Emitter();vscode.workspace[name]=events[name].event;}
  for(const [name,key] of [['registerCompletionItemProvider','completion'],['registerHoverProvider','hover'],['registerDefinitionProvider','definition']])vscode.languages[name]=(selector,provider)=>{providers[key]=provider;return {dispose(){}};};
  const connection=new Emitter();const api=registerSQLAnalysis({},vscode,{catalog:async()=>{calls++;return fetchCatalog();},onDidChangeDatabase:connection.event,catalogSnapshot:()=>catalog});
  return {api,doc,vscode,providers,connection,calls:()=>calls,diagnostics:()=>collection.get(uri.toString())||[]};
}
test('native SQL diagnostics map multiple statements and CTE definitions without implicit server queries',()=>{
  const source='WITH chosen AS (SELECT p.id AS person_id FROM people p)\nSELECT c.person_id FROM chosen c;\nSELECT p.missing FROM people p;',h=host(source);
  try{const report=h.api.analyzeDocument(h.doc);assert.equal(h.calls(),0);assert.equal(report.statements.length,2);assert.equal(report.state,'invalid');assert.ok(h.diagnostics().some(d=>d.code==='sql.name.column'&&d.range.start.line===2));const pos=h.doc.positionAt(source.indexOf('c.person_id')+3),defs=h.providers.definition.provideDefinition(h.doc,pos);assert.ok(defs.length>0);assert.equal(defs[0].range.start.line,0);const hover=h.providers.hover.provideHover(h.doc,pos);assert.ok(hover.contents[0].value.includes('person_id'));}finally{h.api.dispose();}
});
test('SQL statement context changes do not produce false errors from stale catalog metadata',()=>{
  const h=host('ALTER TABLE people ADD extra_column int;\nSELECT p.extra_column FROM people p;');
  try{const report=h.api.analyzeDocument(h.doc);assert.equal(report.contextMayChange,true);assert.equal(report.state,'unknown');assert.equal(h.diagnostics().filter(d=>d.severity===0).length,0);}finally{h.api.dispose();}
});
test('a connection change prevents old SQL catalog responses and diagnostics from reappearing',async()=>{
  let release;const h=host('SELECT p.id FROM people p',()=>new Promise(resolve=>{release=resolve;}));
  try{const work=h.api.refreshMetadata();h.connection.fire({mysql:false});release(catalog);await assert.rejects(()=>work,/changed/);assert.equal(h.api.snapshot(),null);assert.equal(h.api.analyzeDocument(h.doc).state,'not-connected');}finally{h.api.dispose();}
});
test('SQL metadata reads require trust and recheck it after awaiting the server',async()=>{
  let release;const h=host('SELECT 1',()=>new Promise(resolve=>{release=resolve;}));
  try{h.vscode.workspace.isTrusted=false;await assert.rejects(()=>h.api.refreshMetadata(),/Trust/);assert.equal(h.calls(),0);h.vscode.workspace.isTrusted=true;const work=h.api.refreshMetadata();h.vscode.workspace.isTrusted=false;release(catalog);await assert.rejects(()=>work,/changed/);}finally{h.api.dispose();}
});

test('explicitly selected cached metadata can resolve columns but cannot establish live validity or rename authority', () => {
  const source = 'SELECT p.id, p.missing FROM people p;', h = host(source);
  const provenance = { database: 'app', capturedAt: '2026-11-25T07:20:00.000Z' };
  try {
    h.connection.fire({ mysql: false, metadata: { ...catalog, coverage: {}, complete: false,
      visibility: 'cached-current-account', cachedMetadata: provenance } });
    const report = h.api.analyzeDocument(h.doc);
    assert.equal(report.state, 'unknown');
    assert.equal(report.validityVerified, false);
    assert.equal(report.executedSql, false);
    assert.deepEqual(report.cachedMetadata, provenance);
    assert.equal(h.calls(), 0);
    assert.ok(h.diagnostics().some(d => d.code === 'sql.catalog.cached' && d.message.includes(provenance.capturedAt)));
    assert.ok(h.diagnostics().every(d => d.severity === h.vscode.DiagnosticSeverity.Information));
    const position = h.doc.positionAt(source.indexOf('p.id') + 2);
    assert.match(h.providers.hover.provideHover(h.doc, position).contents[0].value, /Cached metadata captured/);
    assert.throws(() => h.api.prepareRename(h.doc, position), /refresh live metadata/);
    h.connection.fire({ mysql: true, metadata: catalog });
    assert.equal(h.api.analyzeDocument(h.doc).state, 'invalid');
    assert.ok(!h.diagnostics().some(d => d.code === 'sql.catalog.cached'));
  } finally { h.api.dispose(); }
});
