'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSQLAnalysis}=require('../src/db/sql-vscode');
const catalog={database:'app',dialect:'mysql',sqlMode:[],tableNameCaseSensitive:false,loadedAt:'observed',coverage:{tables:'loaded',columns:'loaded'},tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false}]}],views:[]};
function host(initial){
  let source=initial,calls=0;const providers={},events={};
  class Emitter{listeners=new Set();event=fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)};};fire(v){for(const fn of this.listeners)fn(v);}dispose(){}}
  class Range{constructor(start,end){this.start=start;this.end=end;}}
  class WorkspaceEdit{changes=[];replace(uri,range,newText,metadata){this.changes.push({uri,range,newText,metadata});}}
  const uri={toString:()=> 'file:///fixture/rename.sql'},doc={uri,languageId:'sql',version:1,isClosed:false,getText:()=>source,positionAt:offset=>{const lines=source.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};},offsetAt:position=>source.split('\n').slice(0,position.line).reduce((sum,line)=>sum+line.length+1,0)+position.character};
  const vscode={EventEmitter:Emitter,Range,WorkspaceEdit,DiagnosticSeverity:{Error:0,Warning:1,Information:2},Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},languages:{createDiagnosticCollection:()=>({clear(){},set(){},delete(){},dispose(){}})},window:{showErrorMessage:async()=>{}},commands:{registerCommand:()=>({dispose(){}})},workspace:{isTrusted:true,textDocuments:[doc],getConfiguration:()=>({get:(key,value)=>value})}};
  for(const name of ['onDidChangeTextDocument','onDidCloseTextDocument','onDidChangeConfiguration']){events[name]=new Emitter();vscode.workspace[name]=events[name].event;}
  for(const [name,key]of [['registerCompletionItemProvider','completion'],['registerHoverProvider','hover'],['registerDefinitionProvider','definition'],['registerRenameProvider','rename']])vscode.languages[name]=(selector,provider)=>{providers[key]=provider;return{dispose(){}};};
  const connection=new Emitter(),api=registerSQLAnalysis({},vscode,{catalog:async()=>{calls++;return catalog;},catalogSnapshot:()=>catalog,onDidChangeDatabase:connection.event});
  const update=value=>{source=value;doc.version++;events.onDidChangeTextDocument.fire({document:doc});};
  return {api,vscode,doc,providers,connection,update,calls:()=>calls,apply:edit=>{for(const change of [...edit.changes].sort((a,b)=>doc.offsetAt(b.range.start)-doc.offsetAt(a.range.start))){const start=doc.offsetAt(change.range.start),end=doc.offsetAt(change.range.end);source=source.slice(0,start)+change.newText+source.slice(end);}doc.version++;return source;}};
}
test('native RenameProvider returns exact statement-local WorkspaceEdits without reading or changing the server',async()=>{
  const source='SELECT p.id FROM people p;\n-- p stays a comment\nSELECT p.name FROM people p WHERE p.name=\'p\'',h=host(source);
  try{const pos=h.doc.positionAt(source.indexOf('p.name'));const prepared=h.providers.rename.prepareRename(h.doc,pos);assert.equal(prepared.placeholder,'p');assert.equal(prepared.range.start.line,2);const edit=await h.providers.rename.provideRenameEdits(h.doc,pos,'from');assert.equal(edit.changes.length,3);assert.equal(h.calls(),0);assert.equal(h.doc.getText(),source);const result=h.apply(edit);assert.equal(result,"SELECT p.id FROM people p;\n-- p stays a comment\nSELECT `from`.name FROM people `from` WHERE `from`.name='p'");assert.equal(h.api.analyzeDocument(h.doc).state,'known');}finally{h.api.dispose();}
});
test('prepare snapshot rejects stale text and connection, then a new preparation can proceed',async()=>{
  const source='SELECT p.id FROM people p',h=host(source),pos=h.doc.positionAt(source.indexOf('p.id'));
  try{h.api.prepareRename(h.doc,pos);h.update(source+' ');await assert.rejects(()=>h.api.renameDocument(h.doc,pos,'person'),/changed after preparation/);h.api.prepareRename(h.doc,pos);h.connection.fire({metadata:catalog});await assert.rejects(()=>h.api.renameDocument(h.doc,pos,'person'),/changed after preparation/);h.api.prepareRename(h.doc,pos);const edit=await h.api.renameDocument(h.doc,pos,'person');assert.equal(edit.changes.length,2);}finally{h.api.dispose();}
});
test('rename checks cancellation, document closure and a concurrent edit before building edits',async()=>{
  const source='SELECT p.id FROM people p',h=host(source),pos=h.doc.positionAt(source.indexOf('p.id'));
  try{await assert.rejects(()=>h.api.renameDocument(h.doc,pos,'person',{isCancellationRequested:true}),/cancelled/);const work=h.api.renameDocument(h.doc,pos,'person');h.update(source+' ');await assert.rejects(()=>work,/source or connection changed/);h.doc.isClosed=true;assert.throws(()=>h.api.prepareRename(h.doc,pos),/closed/);}finally{h.api.dispose();}
});
test('rename refuses catalog objects, preceding DDL and untrusted source',async()=>{
  const h=host('SELECT p.id FROM people p'),pos=h.doc.positionAt(9);
  try{assert.throws(()=>h.api.prepareRename(h.doc,pos),/separate schema migration/);h.update('ALTER TABLE people ADD x int; SELECT p.id FROM people p');assert.throws(()=>h.api.prepareRename(h.doc,h.doc.positionAt(h.doc.getText().lastIndexOf('p.id'))),/Open the live statement separately.*preceding DDL/);assert.equal(h.calls(),0);h.vscode.workspace.isTrusted=false;assert.throws(()=>h.api.prepareRename(h.doc,pos),/Trust/);}finally{h.api.dispose();}
});
