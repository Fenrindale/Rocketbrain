'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestAt, resolveRequest, sendRequest } = require('../src/http/client');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  });
  return 'http://127.0.0.1:'+server.address().port;
}

test('selects one .http block and keeps its exact body and typed response assertions',()=>{
  const text='@base = {{service}}\r\nGET {{base}}/index HTTP/1.1\r\n\r\n### Other\r\n'+
    '# @expect status 201\r\nPOST {{base}}/items\r\nContent-Type: application/json\r\n'+
    '# @expect json $.items[0].name == "ok"\r\n\r\n{"name":"ok"}\r\n';
  const request=requestAt(text,text.indexOf('POST'));
  assert.equal(request.method,'POST');
  assert.equal(request.url,'{{base}}/items');
  assert.equal(request.variables.get('base'),'{{service}}');
  assert.equal(request.body,'{"name":"ok"}\r\n');
  assert.deepEqual(request.assertions,[{kind:'status',value:201},{kind:'json',name:'$.items[0].name',value:'ok'}]);
  assert.equal(requestAt(text,text.indexOf('GET')).method,'GET');
});

test('explicit headers and environment variables send to a real HTTP server and hide echoed credentials',async t=>{
  const secret=randomUUID();
  let observed;
  const base=await fixture(t,async(req,res)=>{
    const buffer=[];
    for await(const part of req)buffer.push(part);
    observed={headers:req.headers,body:Buffer.concat(buffer).toString('utf8')};
    res.writeHead(202,{'content-type':'application/json','x-fixture':'verified','set-cookie':'local='+secret});
    res.end(JSON.stringify({ok:true,echo:secret,user:'Rocketbrain'}));
  });
  const text='# @expect status 202\n# @expect header x-fixture == "verified"\n# @expect json $.ok == true\n'+
    'POST {{base}}/verify\nAuthorization: Bearer {{secret.token}}\nContent-Type: application/json\n\n{"active":true}';
  const ready=await resolveRequest(requestAt(text,text.indexOf('POST')),{base},async name=>{
    assert.equal(name,'token');
    return secret;
  });
  const result=await sendRequest(ready);
  assert.equal(observed.headers.authorization,'Bearer '+secret);
  assert.equal(observed.body,'{"active":true}');
  assert.equal(result.status,202);
  assert.ok(result.assertions.every(item=>item.passed));
  assert.equal(new Map(result.headers).get('set-cookie'),'[redacted]');
  assert.equal(JSON.parse(result.body).echo,'[redacted]');
  assert.equal(JSON.stringify(result).includes(secret),false);
});

test('redirect targets are not requested and a failed assertion remains visible',async t=>{
  let targetHits=0;
  const target=await fixture(t,(_,response)=>{targetHits++;response.end('target');});
  const source=await fixture(t,(_,response)=>{response.writeHead(302,{Location:target});response.end();});
  const result=await sendRequest(await resolveRequest(requestAt('# @expect status 200\nGET '+source,0),{},()=>{}));
  assert.equal(result.status,302);
  assert.equal(result.assertions[0].passed,false);
  assert.equal(targetHits,0);
});

test('refuses stale input forms, recursive variables and credentials interpolated into a URL',async()=>{
  assert.throws(()=>requestAt('GET https://example.test\nCookie: item\nCOOKIE: item2',0),/distinct/);
  assert.throws(()=>requestAt('PATCH https://example.test\nHost: other.test',0),/permitted/);
  assert.throws(()=>requestAt('# @expect json $.people.nope => false\nGET https://example.test',0),/equality/);
  assert.throws(()=>requestAt('POST https://example.test\n'+('x'.repeat(530000)),0),/512 KiB/);
  await assert.rejects(resolveRequest(requestAt('GET {{cyclic}}',0),{cyclic:'{{cyclic}}'},()=>{}),/recursive/);
  await assert.rejects(resolveRequest(requestAt('GET https://example.test/{{secret.token}}',0),{},()=>{}),/headers or body/);
  await assert.rejects(resolveRequest(requestAt('GET file:///fixture.txt',0),{},()=>{}),/HTTP or HTTPS/);
  await assert.rejects(resolveRequest(requestAt('POST https://example.test\nAuthorization: Bearer {{secret.name}}',0),
    {},()=> 'a\r\nb'),/invalid characters/);
});

test('response reads have a hard limit and respect cancellation',async t=>{
  const base=await fixture(t,(request,response)=>{
    if(request.url==='/large') response.end(Buffer.alloc(2*1024*1024+800,65));
    // No response while the caller cancels this deliberately slow request.
  });
  const send = async (path,options)=>sendRequest(await resolveRequest(requestAt('GET '+base+path,0),{},()=>{}),options);
  const large=await send('/large');
  assert.equal(large.truncated,true);
  assert.equal(Buffer.byteLength(large.body),2*1024*1024);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),30);
  try { await assert.rejects(send('/slow',{signal:controller.signal}),/cancelled/); }
  finally { clearTimeout(timer); }
});
