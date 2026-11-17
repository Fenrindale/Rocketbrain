'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {ObserverClient}=require('../src/jpa/observer-client');
const token='a'.repeat(64);
async function server(action){const host=http.createServer(action);await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));return {url:'http://127.0.0.1:'+host.address().port,close:()=>new Promise(resolve=>{host.close(resolve);host.closeAllConnections();})};}
test('observer requires loopback, root URL, bounded options and private token',()=>{
  for(const url of ['http://example.com','http://127.0.0.1/x','http://u:p@127.0.0.1','http://127.0.0.1/?x=1'])assert.throws(()=>new ObserverClient({url,token}));
  for(const value of ['', 'x'.repeat(31), 'a'.repeat(32)+'\n'])assert.throws(()=>new ObserverClient({url:'http://localhost:1',token:value}));
  assert.throws(()=>new ObserverClient({url:'http://localhost:1',token,timeoutMs:99}));
});
test('authenticated observer normalizes snapshots, removes credentials and sends explicit compilation only',async()=>{
  let methods=[];
  const host=await server(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);methods.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){let body='';for await(const bytes of req)body+=bytes;assert.deepEqual(JSON.parse(body),{query:'select 1',factoryId:'factory-1'});res.end(JSON.stringify({state:'known',selectionTypes:[{javaType:'java.lang.Integer'}],sqlExecuted:false}));}
    else res.end(JSON.stringify({factories:[{id:'factory-1'}],events:[{query:token}],bindings:{password:'never retained'},token}));});
  const client=new ObserverClient({url:host.url,token});try{const snapshot=await client.refresh();assert.equal(snapshot.state,'observed');assert.equal(snapshot.events[0].query,'[REDACTED]');assert.equal(snapshot.bindings,undefined);assert.equal(snapshot.token,undefined);assert.equal(snapshot.sameSourceRevisionVerified,false);const result=await client.validate('select 1','factory-1');assert.equal(result.sqlExecuted,false);assert.deepEqual(methods,['GET /snapshot','POST /validate']);}finally{client.dispose();await host.close();}
});
test('observer never forwards a token through redirects or accepts malformed metadata',async()=>{
  for(const mode of ['redirect','malformed','oversize']){
    const host=await server((req,res)=>{if(mode==='redirect'){res.writeHead(302,{Location:'http://example.com'});res.end();}else if(mode==='oversize')res.end('x'.repeat(3000));else res.end('{"factories":{},"events":[]}');});
    const client=new ObserverClient({url:host.url,token,maxResponseBytes:1024});try{await assert.rejects(()=>client.refresh(),error=>error.code===({redirect:'REDIRECT_BLOCKED',malformed:'INVALID_SCHEMA',oversize:'RESPONSE_LIMIT'}[mode]));}finally{client.dispose();await host.close();}
  }
});
test('observer timeout and disposal cancel pending requests',async()=>{
  const host=await server(()=>{}),client=new ObserverClient({url:host.url,token,timeoutMs:100});
  try{await assert.rejects(()=>client.refresh(),error=>error.code==='TIMEOUT');const pending=client.refresh();client.dispose();await assert.rejects(()=>pending);await assert.rejects(()=>client.validate('select 1'),error=>error.code==='DISPOSED');}finally{client.dispose();await host.close();}
});
test('observer refuses invalid, oversized queries before sending requests',async()=>{
  const client=new ObserverClient({url:'http://127.0.0.1:1',token});
  for(const value of ['', 'x'.repeat(16385), '\0select 1'])await assert.rejects(()=>client.validate(value),error=>error.code==='INVALID_QUERY');client.dispose();
});
test('native observer stays offline until explicit connect, rejects trust loss and discards stale replies',async()=>{
  const {registerObserver}=require('../src/jpa/observer-vscode');let calls=0,release;
  const host=await server((req,res)=>{calls++;release=()=>res.end(JSON.stringify({factories:[],events:[]}));});
  class Emitter{event=()=>({dispose(){}});fire(){}dispose(){}}
  const vscode={EventEmitter:Emitter,commands:{registerCommand:()=>({dispose(){}})},workspace:{isTrusted:true}};
  const observer=registerObserver({},vscode,{appendLine(){}},{source:async()=>({revision:1,entities:[]})});
  try{assert.equal(calls,0);assert.equal(observer.snapshot().state,'disconnected');const connected=observer.connect({url:host.url,token});while(!release)await new Promise(resolve=>setImmediate(resolve));observer.disconnect();release();await connected.catch(()=>{});assert.equal(observer.snapshot().state,'disconnected');vscode.workspace.isTrusted=false;await assert.rejects(()=>observer.connect({url:host.url,token}),error=>error.code==='UNTRUSTED');assert.equal(calls,1);}finally{observer.dispose();await host.close();}
});
function nativeObserver(source){
  const {registerObserver}=require('../src/jpa/observer-vscode');class Emitter{event=()=>({dispose(){}});fire(){}dispose(){}}
  return registerObserver({}, {EventEmitter:Emitter,commands:{registerCommand:()=>({dispose(){}})},workspace:{isTrusted:true}}, {appendLine(){}},{source});
}
test('changing the provider during source inspection prevents validation on a different connection',async()=>{
  let posts=0,release,entered;
  const gate=new Promise(resolve=>{entered=resolve;});
  const host=await server((req,res)=>{if(req.method==='POST')posts++;res.end(JSON.stringify({factories:[],events:[]}));});
  const observer=nativeObserver(()=>{entered();return new Promise(resolve=>{release=resolve;});});
  try{await observer.connect({url:host.url,token});const validation=observer.validate('select 1');await gate;observer.disconnect();release({revision:1});await assert.rejects(()=>validation,error=>error.code==='STALE');assert.equal(posts,0);assert.equal(observer.snapshot().lastValidation,undefined);}finally{observer.dispose();await host.close();}
});
test('a late old provider refresh cannot overwrite a newer snapshot',async()=>{
  let connected=false;const responses=[];
  const host=await server((req,res)=>{if(!connected){connected=true;res.end(JSON.stringify({factories:[],events:[]}));}else responses.push(res);});
  const observer=nativeObserver(async()=>({revision:1,entities:[]}));
  try{await observer.connect({url:host.url,token});const old=observer.refresh(),latest=observer.refresh();while(responses.length<2)await new Promise(resolve=>setImmediate(resolve));responses[1].end(JSON.stringify({factories:[{id:'new'}],events:[]}));await latest;responses[0].end(JSON.stringify({factories:[{id:'old'}],events:[]}));await old;assert.equal(observer.snapshot().factories[0].id,'new');}finally{observer.dispose();await host.close();}
});
