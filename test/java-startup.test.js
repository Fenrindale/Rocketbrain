'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {registerJavaAutostart}=require('../src/java/startup');

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('global extension startup leaves unrelated workspaces idle and admits local JVM context',async () => {
  const events=new Map(),errors=[];
  const event=name=>callback=>{events.set(name,callback);return {dispose(){events.delete(name);}};};
  let starts=0, scans=0, matches=[];
  const start=async()=>{starts++;};
  const workspace={
    isTrusted:true,workspaceFolders:[],textDocuments:[],
    async findFiles(_query,_exclude,limit){assert.equal(limit,1);scans++;return matches;},
    onDidOpenTextDocument:event('open'),onDidChangeWorkspaceFolders:event('folders'),onDidGrantWorkspaceTrust:event('trust')
  };
  const disposable=registerJavaAutostart({workspace},start,error=>errors.push(error));
  try {
    await tick();
    assert.equal(scans,0);
    assert.equal(starts,0);
    workspace.workspaceFolders=[{}];
    events.get('folders')();
    await tick();
    assert.equal(scans,1);
    assert.equal(starts,0);
    events.get('open')({languageId:'java',uri:{scheme:'untitled'}});
    events.get('open')({languageId:'sql',uri:{scheme:'file'}});
    assert.equal(starts,0);
    workspace.isTrusted=false;
    events.get('open')({languageId:'java',uri:{scheme:'file'}});
    assert.equal(starts,0);
    workspace.isTrusted=true;
    matches=[{scheme:'file'}];
    events.get('trust')();
    await tick();
    assert.equal(starts,1);
    events.get('open')({languageId:'java',uri:{scheme:'file'}});
    await tick();
    assert.equal(starts,1);
    assert.deepEqual(errors,[]);
  } finally {
    disposable.dispose();
  }
  assert.equal(events.size,0);
});

test('opening a local Java document starts support and explicit commands remain available',async () => {
  let callback,starts=0;
  const start=async()=>{starts++;};
  const workspace={
    isTrusted:true,workspaceFolders:[],textDocuments:[],
    onDidOpenTextDocument(fn){callback=fn;return {dispose(){}};},
    onDidChangeWorkspaceFolders:()=>({dispose(){}}),onDidGrantWorkspaceTrust:()=>({dispose(){}})
  };
  const registered=registerJavaAutostart({workspace},start,assert.fail);
  try {
    await tick();
    assert.equal(starts,0);
    await start();
    assert.equal(starts,1);
    callback({languageId:'java',uri:{scheme:'file'}});
    assert.equal(starts,2);
  } finally {registered.dispose();}
});
