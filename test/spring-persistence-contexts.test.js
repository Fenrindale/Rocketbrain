'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { normalizePersistenceContexts, comparePersistenceBuild } = require('../src/jpa/persistence-contexts');
const { registerObserver } = require('../src/jpa/observer-vscode');

const bytes = Buffer.from('cafebabe00000002010203','hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const uri = file => ({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
const javaType = 'sample.ManagedRow', digest = hash(bytes);
const build = { state:'known', classes:[{javaType,sha256:digest}], fingerprint:hash(javaType + ' ' + digest + '\n') };
const parent = { key:'context-1', id:'duplicated', parentState:'root', factories:[{
  factoryId:'factory-1',beanName:'entityManagerFactory',persistenceUnit:'main',build
}] };
const child = { key:'context-2', id:'duplicated', parentState:'observed', parentKey:parent.key, factories:[{
  factoryId:'factory-2',beanName:'entityManagerFactory',persistenceUnit:'child',build
}] };
const snapshot = { processId:777, state:'observed', contexts:[parent,child], unassignedFactoryIds:[],
  observerExecutedSql:false,applicationCallbacksInvoked:false };

test('context ownership is proven by keys and parent edges despite equal display names', () => {
  assert.deepEqual(normalizePersistenceContexts(snapshot),snapshot);
  assert.throws(()=>normalizePersistenceContexts({...snapshot,contexts:[{...parent,parentState:'observed',parentKey:child.key},child]}),/hierarchy/);
  assert.throws(()=>normalizePersistenceContexts({...snapshot,contexts:[{...child,parentKey:'context-900'}]}),/hierarchy/);
  assert.throws(()=>normalizePersistenceContexts({...snapshot,contexts:[parent,{...child,factories:parent.factories}]}),/ownership/);
  assert.throws(()=>normalizePersistenceContexts({...snapshot,applicationCallbacksInvoked:true}),/metadata/);
});

async function output(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-persistence-build-'));
  const buildRoot = path.join(root,'classes'), file = path.join(buildRoot,'sample','ManagedRow.class');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,bytes);
  t.after(async()=>{
    const local = path.relative(await fs.realpath(os.tmpdir()),await fs.realpath(root));
    assert.match(local,/^rb-persistence-build-[A-Za-z0-9]+$/u);
    await fs.rm(root,{recursive:true,force:true});
  });
  return { folders:[{uri:uri(root)}], directory:uri(buildRoot), file };
}

test('compiled bytes distinguish match, different class and unavailable evidence in a bounded local output', async t => {
  const { folders,directory,file } = await output(t);
  const verified = await comparePersistenceBuild(build,directory,folders);
  assert.equal(verified.state,'matched');
  assert.equal(verified.verifiedFingerprint,build.fingerprint);
  assert.equal(verified.sameSourceRevisionVerified,false);
  await fs.writeFile(file,Buffer.from('cafebabe00000002ff0203','hex'));
  assert.equal((await comparePersistenceBuild(build,directory,folders)).state,'different');
  await fs.unlink(file);
  assert.equal((await comparePersistenceBuild(build,directory,folders)).state,'unavailable');
  assert.equal((await comparePersistenceBuild({state:'partial',classes:[{javaType}]},directory,folders)).reason,'incomplete_runtime_fingerprint');
  await assert.rejects(comparePersistenceBuild(build,uri(path.dirname(folders[0].uri.fsPath)),folders),/workspace/);
});

test('the registered comparison refuses stale ownership and opens an exact fresh report', async t => {
  const { folders,directory } = await output(t);
  let stale = true, scopes = 0;
  const server = http.createServer((request,response)=>{
    if(request.url==='/snapshot') { response.end(JSON.stringify({ processId:777,
      capabilities:{springPersistenceContexts:true},factories:[],events:[] }));return; }
    assert.equal(request.method,'GET');
    assert.equal(request.url,'/spring-persistence-contexts');
    scopes++;
    response.end(JSON.stringify(stale&&scopes===2?{...snapshot,contexts:[parent]}:snapshot));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  class Emitter { event(){return {dispose(){}};} fire(){} dispose(){} }
  const commands = new Map(), documents = [];
  const vscode = {
    EventEmitter:Emitter, workspace:{isTrusted:true,workspaceFolders:folders,async openTextDocument(value){return value;}},
    commands:{registerCommand(name,action){commands.set(name,action);return {dispose(){}};}},
    window:{async showErrorMessage(message){throw Error(message);},async showTextDocument(document){documents.push(document);}}
  };
  const model = registerObserver({},vscode,{appendLine(){}},{source:async()=>({entities:[]})});
  t.after(()=>model.dispose());
  await model.connect({url:'http://127.0.0.1:'+server.address().port,token:'c'.repeat(64)});
  await assert.rejects(model.inspectPersistenceContexts({factoryId:'factory-2',directory},true),error=>error.code==='STALE_CONTEXT');
  assert.equal(documents.length,0);
  stale=false;
  const compare = commands.get('rocketbrain.jpa.observer.comparePersistenceBuild');
  const report = await compare({factoryId:'factory-2',directory});
  assert.deepEqual(JSON.parse(documents[0].content),report);
  assert.equal(report.comparison.state,'matched');
  assert.equal(report.comparison.factoryId,'factory-2');
});
