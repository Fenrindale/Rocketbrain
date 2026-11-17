'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerJPAFeatures } = require('../src/jpa/vscode');

function fakeWorkspace(catalog,options={}) {
  const collections = new Map(), commands = new Map(), dispose = () => ({ dispose() {} });
  class Emitter { constructor() { this.listeners = new Set(); this.event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; }; } fire(value) { for (const listener of this.listeners) listener(value); } dispose() { this.listeners.clear(); } }
  class Range { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } }
  const uri = { toString: () => 'file:///fixture/Guard.java' };
  const mappingUri={toString:()=> 'file:///fixture/META-INF/orm.xml'};
  const changes=new Emitter();
  const source = options.source||'package fixture; import jakarta.persistence.*; @Entity @Table(name="guard_entity") public class Guard { @Id @Column(name="id") private long id; }';
  let hoverProvider;
  class Position {constructor(line,character){this.line=line;this.character=character;}}
  const vscode = {
    EventEmitter: Emitter, Range,Position,MarkdownString:class{constructor(){this.value='';}appendText(value){this.value+=value;return this;}},Hover:class{constructor(content){this.contents=[content];}},
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Uri: { parse: value => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
    commands: { registerCommand: (id, action) => { commands.set(id, action); return dispose(); } },
    languages: {
      createDiagnosticCollection(name) { const entries = new Map(); collections.set(name, entries); return { clear: () => entries.clear(), set: (key, values) => entries.set(key.toString(), values), dispose: () => entries.clear() }; },
      registerCompletionItemProvider: dispose, registerDefinitionProvider: dispose,registerHoverProvider:(selector,provider)=>{hoverProvider=provider;return dispose();}
    },
    workspace: {
      isTrusted: true, textDocuments: [], findFiles: async pattern => pattern.includes('orm.xml')?options.mapping?[mappingUri]:[]:[uri],
      fs: { stat: async value => {if(value===mappingUri&&options.unreadableMapping)throw new Error('unreadable');return { size: Buffer.byteLength(value===mappingUri?options.mapping:source) };}, readFile: async value => Buffer.from(value===mappingUri?options.mapping:source) },
      getConfiguration: () => ({ get: (key, fallback) => key === 'physicalNaming' ? 'standard' : key==='namingStrategy'?options.namingStrategy||fallback:fallback }),
      onDidChangeTextDocument: changes.event, onDidCreateFiles: dispose, onDidDeleteFiles: dispose,
      onDidRenameFiles: dispose, onDidChangeWorkspaceFolders: dispose, onDidChangeConfiguration: dispose
    }
  };
  const api = registerJPAFeatures({ subscriptions: [] }, vscode, { catalog });
  return { api, vscode, collections, commands,mappingUri,fireChange:event=>changes.fire(event),getHover:()=>hoverProvider,source,uri };
}
const metadata = { database: 'guard', tables: [{ name: 'guard_entity', columns: [{ name: 'id', type: 'bigint', primaryKey: true, nullable: false }] }], views: [] };
async function reached(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Metadata callback did not start.'); }

test('JPA invalidation prevents a delayed database comparison from republishing stale diagnostics', async t => {
  let complete;
  const { api, collections } = fakeWorkspace(() => new Promise(resolve => { complete = resolve; })); t.after(() => api.dispose());
  await api.snapshot();
  const waiting = api.compareCatalog(); await reached(() => complete);
  api.invalidateCatalog(); complete(metadata);
  await assert.rejects(waiting, /changed during metadata/);
  assert.equal(api.catalogComparison(), undefined);
  assert.equal(collections.get('rocketbrain-jpa-catalog').size, 0);
});
test('a newer JPA comparison wins even when an older metadata request finishes later', async t => {
  const completions = [];
  const { api } = fakeWorkspace(() => new Promise(resolve => completions.push(resolve))); t.after(() => api.dispose());
  await api.snapshot();
  const older = api.compareCatalog(); await reached(() => completions.length === 1);
  const newer = api.compareCatalog(); await reached(() => completions.length === 2);
  completions[1](metadata); const expected = await newer;
  completions[0]({ ...metadata, database: 'older' });
  await assert.rejects(older, /changed during metadata/);
  assert.equal(api.catalogComparison(), expected);
  assert.equal(api.catalogComparison().database, 'guard');
});
test('JPA comparison checks workspace trust again after the metadata await', async t => {
  let complete;
  const { api, vscode } = fakeWorkspace(() => new Promise(resolve => { complete = resolve; })); t.after(() => api.dispose());
  await api.snapshot();
  const waiting = api.compareCatalog(); await reached(() => complete);
  vscode.workspace.isTrusted = false; complete(metadata);
  await assert.rejects(waiting, /no longer trusted/);
  assert.equal(api.catalogComparison(), undefined);
});

test('workspace ORM XML overrides are indexed, unsaved XML changes invalidate the catalog and the native model refreshes',async t=>{
  const mapping='<entity-mappings xmlns="https://jakarta.ee/xml/ns/persistence/orm" version="3.2"><entity class="fixture.Guard"><table name="xml_guard"/></entity></entity-mappings>';
  const state=fakeWorkspace(async()=>({...metadata,tables:[{...metadata.tables[0],name:'xml_guard'}]}),{mapping});t.after(()=>state.api.dispose());
  let model=await state.api.snapshot();assert.equal(model.entities[0].table.physicalName,'xml_guard');assert.equal(model.sourceCoverage.mappingFiles,1);assert.equal(model.sourceCoverage.complete,true);
  const comparison=await state.api.compareCatalog();assert.equal(comparison.mismatches.length,0);assert.equal(comparison.matches.length,1);
  const document={uri:state.mappingUri,languageId:'xml',getText:()=>mapping.replace('xml_guard','changed_guard')};state.vscode.workspace.textDocuments.push(document);state.fireChange({document});
  assert.equal(state.api.catalogComparison(),undefined);model=await state.api.snapshot();assert.equal(model.entities[0].table.physicalName,'changed_guard');
});

test('an unreadable discovered ORM mapping suppresses false annotation-default table absence findings',async t=>{
  const state=fakeWorkspace(async()=>({...metadata,tables:[]}),{mapping:'unreadable',unreadableMapping:true});t.after(()=>state.api.dispose());
  const model=await state.api.snapshot();assert.equal(model.sourceCoverage.complete,false);assert.equal(model.entities[0].providerMappingUnknown,true);
  const compared=await state.api.compareCatalog();assert.equal(compared.mismatches.length,0);assert.ok(compared.unknowns.length>0);
});

test('an explicitly configured but unavailable naming strategy stays uncertain instead of comparing guessed defaults',async t=>{
  const state=fakeWorkspace(async()=>({...metadata,tables:[]}),{namingStrategy:{physical:'missing.CustomNaming'}});t.after(()=>state.api.dispose());
  const model=await state.api.snapshot();assert.equal(model.entities[0].table.certainty,'unknown');
  const result=await state.api.compareCatalog();assert.equal(result.mismatches.length,0);assert.ok(result.unknowns.length>0);
});

test('query type hover converts source positions to native Position objects required by the editor API',async t=>{
  const source='package fixture; import jakarta.persistence.*; @Entity @NamedQuery(name="all",query="select g.id from Guard g") class Guard { @Id Long id; }';
  const state=fakeWorkspace(async()=>metadata,{source});t.after(()=>state.api.dispose());await state.api.snapshot();
  const document={uri:state.uri,offsetAt(position){assert.ok(position instanceof state.vscode.Position,'Native APIs require Position instances.');return position.character;}};
  const result=await state.getHover().provideHover(document,new state.vscode.Position(0,source.indexOf('select g.id')+8),{isCancellationRequested:false});assert.ok(result);assert.match(result.contents[0].value,/JPQL source types: known/);assert.match(result.contents[0].value,/java.lang.Long/);
});
