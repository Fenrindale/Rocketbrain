'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {registerJavaAutostart, registerJavaDefinitionStartup, createDefinitionReadiness}=require('../src/java/startup');

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

test('native definition requested during startup delegates once to the real provider', async () => {
  const document = { version: 1 };
  const position = { line: 2, character: 10 };
  const token = { isCancellationRequested: false };
  const target = { uri: 'file:///Greeter.java' };
  let definition, real, complete;
  let ready = false, starts = 0;
  const starting = new Promise(resolve => { complete = resolve; });
  registerJavaDefinitionStartup({ languages: {
    registerDefinitionProvider(selector, provider) {
      assert.deepEqual(selector, { scheme: 'file', language: 'java' });
      definition = provider.provideDefinition;
    }
  } }, {
    start: async () => { starts++; await starting; ready = true; },
    provider: () => ready && real,
    isAvailable: () => true
  });
  const request = definition(document, position, token);
  assert.equal(starts, 1);
  real = { provideDefinition(...args) {
    assert.deepEqual(args, [document, position, token]);
    return target;
  } };
  complete();
  assert.equal(await request, target);
  assert.equal(await definition(document, position, token), undefined);
  assert.equal(starts, 1);
});

test('native definition abandons requests when setup is missing or source changes during startup', async () => {
  const document = { version: 1 };
  const token = { isCancellationRequested: false };
  let definition, ready, allowed = false, starts = 0;
  registerJavaDefinitionStartup({ languages: {
    registerDefinitionProvider(_selector, provider) { definition = provider.provideDefinition; }
  } }, {
    start: async () => { starts++; document.version++; ready = true; },
    provider: () => ready && { provideDefinition: assert.fail },
    isAvailable: () => allowed
  });
  assert.equal(await definition(document, {}, token), undefined);
  assert.equal(starts, 0);
  allowed = true;
  assert.equal(await definition(document, {}, token), undefined);
  assert.equal(starts, 1);
});

test('Java definitions wait for the project import signal and stop waiting on cancellation', async () => {
  const readiness = createDefinitionReadiness();
  let cancel, live = 0, settled = false;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback) {
      live++;
      cancel = callback;
      return { dispose() { live--; } };
    }
  };
  const request = readiness.wait(token).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  cancel();
  await request;
  assert.equal(live, 0);

  settled = false;
  const next = readiness.wait(token).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  readiness.complete();
  await next;
  await readiness.wait(token);
  assert.equal(live, 0);
});
