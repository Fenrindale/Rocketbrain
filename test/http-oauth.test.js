'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');

const draft={tokenUrl:'{{issuer}}/token',clientId:'system + module',clientSecret:'{{secret.service}}',scope:'read:items'};
const doc=(options=draft,url='https://resource.example.test/items')=>
  '# @oauth-client '+JSON.stringify(options)+'\nGET '+url;
const ready=async(text=doc(),secret='sample:pass+marker')=>
  resolveRequest(requestAt(text,0),{issuer:'https://issuer.example.test'},()=>secret);
const json=content=>new Response(JSON.stringify(content),{headers:{'content-type':'application/json; charset=utf-8'}});

test('OAuth uses one bounded token exchange and redacts the fresh authorized Bearer value',async()=>{
  const seen=[];
  const fetcher=async(url,options)=>{
    seen.push({origin:url.origin,headers:options.headers,method:options.method,redirect:options.redirect,body:options.body?.toString()});
    if(seen.length===1)return json({access_token:'fixture-bearer-marker',token_type:'bearer',expires_in:15});
    return json({result:7,echo:options.headers.Authorization});
  };
  let freshness=0;
  const reply=await sendRequest(await ready(),{fetcher,beforeAuthenticatedRequest:()=>{freshness++;}});
  assert.equal(freshness,1);
  assert.deepEqual(seen.map(({origin,method,redirect})=>[origin,method,redirect]),[
    ['https://issuer.example.test','POST','error'],['https://resource.example.test','GET','manual']
  ]);
  assert.equal(seen[0].body,'grant_type=client_credentials&scope=read%3Aitems');
  assert.equal(Buffer.from(seen[0].headers.Authorization.slice(6),'base64').toString(),
    'system+%2B+module:sample%3Apass%2Bmarker');
  assert.equal(seen[1].headers.Authorization,'Bearer fixture-bearer-marker');
  assert.equal(reply.authenticated,'oauth-client-credentials');
  assert.deepEqual(JSON.parse(reply.body),{result:7,echo:'Bearer [redacted]'});
});

test('OAuth refuses insecure endpoint pairs before reading a secret and rejects competing authorization',async()=>{
  const resolve=async(options,url)=>resolveRequest(requestAt(doc(options,url),0),{issuer:'https://issuer.example.test'},
    ()=>assert.fail('A secret was read before the route was validated.'));
  await assert.rejects(resolve({...draft,tokenUrl:'http://insecure.example.test/token'}),/Use HTTPS/);
  await assert.rejects(resolve(draft,'http://127.0.0.1:8000/items'),/same literal loopback/);
  await assert.rejects(resolve({...draft,tokenUrl:'http://127.0.0.1:9000/token'},'http://127.0.0.1:8000/items'),/Use HTTPS/);
  assert.throws(()=>requestAt(doc({...draft,clientSecret:'hardcoded'}) ,0),/Secret Storage/);
  assert.throws(()=>requestAt(doc()+'\nAuthorization: Bearer literal',0),/no explicit Authorization/);
});

test('invalid, oversized or stale OAuth exchanges never send the protected request',async()=>{
  const request=await ready();
  for(const rejected of [
    [()=>json({access_token:'unsafe value',token_type:'Bearer'}),/usable Bearer/],
    [()=>json({access_token:'a'.repeat(33*1024),token_type:'Bearer'}),/32 KiB/],
    [()=>new Response('reject',{status:401}),/HTTP 401/]
  ]) {
    let calls=0;
    await assert.rejects(sendRequest(request,{fetcher:async()=>{calls++;return rejected[0]();}}),rejected[1]);
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(sendRequest(request,{fetcher:async()=>{calls++;return json({access_token:'marker',token_type:'Bearer'});},
    beforeAuthenticatedRequest:()=>{throw Error('Request context changed.');}}),/context changed/);
  assert.equal(calls,1);
});
