'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSQLAnalysis}=require('../src/db/sql-vscode');
const catalog={database:'app',dialect:'mysql',sqlMode:[],tableNameCaseSensitive:false,visibility:'current-account',loadedAt:'observed',coverage:{tables:'loaded',columns:'loaded'},tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false}]}],views:[]};
function host(source,fetchCatalog=async()=>catalog,pluginOptions={}){
  const events={};let collection=new Map();const providers={};let calls=0;
  class Emitter{listeners=new Set();event=fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)};};fire(value){for(const fn of this.listeners)fn(value);}dispose(){}}
  class Range{constructor(...args){if(args.length===2){this.start=args[0];this.end=args[1];}else{this.start={line:args[0],character:args[1]};this.end={line:args[2],character:args[3]};}}}
  const uri={toString:()=> 'file:///fixture/query.sql'},doc={uri,languageId:'sql',version:1,isClosed:false,getText:()=>source,positionAt:offset=>{const lines=source.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};},offsetAt:position=>source.split('\n').slice(0,position.line).reduce((sum,line)=>sum+line.length+1,0)+position.character};
  const vscode={EventEmitter:Emitter,Range,DiagnosticSeverity:{Error:0,Warning:1,Information:2},Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},CompletionItemKind:{Field:1,Struct:2},CompletionItem:class{constructor(label){this.label=label;}},MarkdownString:class{value='';appendText(value){this.value+=value;}},Hover:class{constructor(value){this.contents=[value];}},Location:class{constructor(value,range){this.uri=value;this.range=range;}},languages:{createDiagnosticCollection:()=>({clear:()=>collection.clear(),set:(uri,values)=>collection.set(uri.toString(),values),delete:uri=>collection.delete(uri.toString()),dispose(){}})},window:{activeTextEditor:{document:doc},showErrorMessage:async()=>{}},commands:{registerCommand:()=>({dispose(){}})},workspace:{isTrusted:true,textDocuments:[doc],getConfiguration:()=>({get:(key,value)=>value})}};
  for(const name of ['onDidChangeTextDocument','onDidCloseTextDocument','onDidChangeConfiguration']){events[name]=new Emitter();vscode.workspace[name]=events[name].event;}
  for(const [name,key] of [['registerCompletionItemProvider','completion'],['registerHoverProvider','hover'],['registerDefinitionProvider','definition']])vscode.languages[name]=(selector,provider)=>{providers[key]=provider;return {dispose(){}};};
  const connection=new Emitter();const api=registerSQLAnalysis({},vscode,{catalog:async()=>{calls++;return fetchCatalog();},onDidChangeDatabase:connection.event,catalogSnapshot:()=>catalog,...pluginOptions});
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

test('registered JOIN provider uses exact editor ranges and drops changed document versions after remote metadata reads', async () => {
  const people = { name: 'people', kind: 'table', columns: [{ name: 'dept_id', type: 'int' }] };
  const departments = { schema: 'hr', name: 'departments', kind: 'table', columns: [{ name: 'id', type: 'int' }] };
  const active = { ...catalog, tables: [people] };
  const live = { tables: [{ ...people, schema: 'app' }, departments], edges: [
    { name: 'fk_department', kind: 'physical', child: { schema: 'app', table: 'people' }, parent: { schema: 'hr', table: 'departments' },
      parts: [{ column: 'dept_id', parentColumn: 'id', ordinal: 1 }] }
  ] };
  let deferred, release;
  const source = 'SELECT 7;\nSELECT COUNT(*) FROM people p JOIN hr.dep;\nSELECT 8;';
  const h = host(source, async () => active, {
    catalogSnapshot: () => active,
    joinCatalog: () => deferred ? new Promise(resolve => { release = resolve; }) : Promise.resolve(live)
  });
  try {
    const offset = source.indexOf('hr.dep') + 'hr.dep'.length;
    const position = h.doc.positionAt(offset), provide = () => h.providers.completion.provideCompletionItems(h.doc, position, {});
    const [candidate] = await provide();
    assert.match(candidate.detail, /verified foreign key/);
    assert.equal(source.slice(h.doc.offsetAt(candidate.range.start), h.doc.offsetAt(candidate.range.end)), 'hr.dep');
    assert.match(candidate.insertText, /`hr`\.`departments` ON `p`\.`dept_id`/);
    deferred = true;
    const pending = provide();
    h.doc.version++;
    release(live);
    assert.deepEqual(await pending, []);
  } finally { h.api.dispose(); }
});

test('SQL Definition opens scoped paths on demand and keeps hover and cached scopes offline', async () => {
  const source = 'SELECT p.id FROM other.people p';
  const remote = { schema: 'other', name: 'people', kind: 'table', columns: [{ name: 'id', type: 'int', nullable: false }] };
  let graphReads = 0, ddlReads = 0, release, waitForDdl = false;
  const h = host(source, async () => catalog, {
    joinCatalog: async request => {
      graphReads++;
      assert.deepEqual(request, { endpoints: [{ schema: 'other', table: 'people' }], includeEdges: false });
      return { tables: [remote] };
    },
    objectDefinition: async (target, assertCurrent) => {
      ddlReads++;
      assert.deepEqual(target.object, { schema: 'other', kind: 'table', name: 'people' });
      assert.deepEqual(target.member, { name: 'id', kind: 'column' });
      assertCurrent();
      if (waitForDdl) await new Promise(resolve => { release = resolve; });
      return { uri: 'rocketbrain-object-source:exact' };
    }
  });
  try {
    const position = h.doc.positionAt(source.indexOf('id') + 1);
    h.providers.hover.provideHover(h.doc, position);
    assert.equal(graphReads + ddlReads, 0);
    assert.deepEqual(await h.providers.definition.provideDefinition(h.doc, position), [{ uri: 'rocketbrain-object-source:exact' }]);
    assert.equal(graphReads + ddlReads, 2);
    assert.match(h.providers.hover.provideHover(h.doc, position).contents[0].value, /other\.people\.id.*NOT NULL/);
    assert.equal(graphReads + ddlReads, 2);
    waitForDdl = true;
    const pending = h.providers.definition.provideDefinition(h.doc, position);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    h.connection.fire({ mysql: false, metadata: { ...catalog, cachedMetadata: { capturedAt: 'fixture' } } });
    release();
    assert.deepEqual(await pending, []);
    assert.deepEqual(await h.providers.definition.provideDefinition(h.doc, position), []);
    assert.equal(graphReads + ddlReads, 4);
  } finally { h.api.dispose(); }
});

test('DML providers keep local aliases local and use live scoped DDL for remote write/read columns', async () => {
  const source='UPDATE archive.people AS p SET p.id = p.id + ? WHERE p.id > ?';
  const snapshot = {...catalog,tables:[{...catalog.tables[0],kind:'table'}]};
  const visible={schema:'archive',name:'people',kind:'table',columns:[{name:'id',type:'int',nullable:false}]};
  let read=0, ddl=0;
  const h=host(source, async()=>snapshot, {
    catalogSnapshot:()=>snapshot,
    joinCatalog:async input=>{read++;assert.deepEqual(input,{endpoints:[{schema:'archive',table:'people'}],includeEdges:false});return{tables:[visible]};},
    objectDefinition:async target=>{ddl++;assert.deepEqual(target.object,{schema:'archive',name:'people',kind:'table'});return{uri:'remote-source',usage:target.usage};}
  });
  try{
    const position=(first)=>h.doc.positionAt((first?source.indexOf('p.id'):source.lastIndexOf('p.id'))+3);
    const dfn=at=>h.providers.definition.provideDefinition(h.doc,at,{});
    assert.deepEqual(await dfn(position(true)),[{uri:'remote-source',usage:'write'}]);
    assert.deepEqual(await dfn(position(false)),[{uri:'remote-source',usage:'read'}]);
    const hover=h.providers.hover.provideHover(h.doc,position(false)).contents[0].value;
    assert.match(hover,/UPDATE read reference · table column archive\.people\.id/);
    assert.equal(read,2);
    assert.equal(ddl,2);
    const alias=h.doc.positionAt(source.indexOf('p.id'));
    const [local]=await dfn(alias);
    assert.equal(local.uri,h.doc.uri);
    assert.equal(local.range.start.character,source.indexOf('AS p')+3);
    assert.equal(ddl,2);
  }finally{h.api.dispose();}
});
