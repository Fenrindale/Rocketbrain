'use strict';

const assert=require('node:assert/strict');
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {createKotlinEditorScope}=require('../src/java/kotlin-editor-scope');

test('a Kotlin client sends only its selected physical module and closes only admitted documents',async t=>{
  const parent=await fs.realpath(os.tmpdir()),folder=await fs.mkdtemp(path.join(parent,'rb-kotlin-scope-'));
  t.after(async()=>{
    const owned=await fs.realpath(folder);
    assert.equal(owned,folder);
    assert.equal(path.dirname(owned),parent);
    await fs.rm(owned,{recursive:true,force:true});
  });
  const module=path.join(folder,'app'),outside=path.join(folder,'app-sibling');
  await fs.mkdir(module);
  await fs.mkdir(outside);
  const record=(dir,name,languageId='kotlin')=>{
    const fsPath=path.join(dir,name);
    return {uri:{scheme:'file',fsPath,toString:()=>pathToFileURL(fsPath).href},languageId};
  };
  const selected=record(module,'OrderSummary.kt'),stale=record(outside,'KotlinWatchInspection.kt'),
    siblingScript=record(outside,'build.gradle.kts'),sameModuleScript=record(module,'build.gradle.kts');
  for (const item of [selected,stale,siblingScript,sameModuleScript]) await fs.writeFile(item.uri.fsPath,'fixture');
  let isActive=true;
  const scope=createKotlinEditorScope(module,()=>isActive),m=scope.middleware,events=[];
  function capture(name) { return data=>events.push([name,path.basename((data.document||data).uri.fsPath)]); }
  for (const doc of [stale,siblingScript,sameModuleScript,selected,selected]) {
    await m.didOpen(doc,capture('open'));
    await m.didChange({document:doc},capture('change'));
    await m.didSave(doc,capture('save'));
  }
  assert.deepEqual(events,[['open','OrderSummary.kt'],['change','OrderSummary.kt'],['save','OrderSummary.kt'],
    ['change','OrderSummary.kt'],['save','OrderSummary.kt']]);
  assert.equal(scope.request(stale,()=>assert.fail('outside requests must stay local')),undefined);
  assert.equal(scope.request(selected,7,(_doc,position)=>position),7);
  m.handleDiagnostics(stale.uri,[],()=>assert.fail('outside diagnostics cannot reach the client'));
  m.handleDiagnostics(selected.uri,[{message:'type mismatch'}],(_uri,diagnostics)=>assert.equal(diagnostics.length,1));
  await fs.unlink(selected.uri.fsPath);
  assert.equal(scope.owns(selected.uri,true),true);
  assert.equal(scope.owns(stale.uri,true),false);
  isActive=false;
  await m.didClose(stale,capture('close'));
  await m.didClose(selected,capture('close'));
  await m.didClose(selected,capture('close'));
  assert.deepEqual(events.filter(([name])=>name==='close'),[['close','OrderSummary.kt']]);
});
