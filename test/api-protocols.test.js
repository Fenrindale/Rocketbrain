'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { randomUUID }=require('node:crypto');
const { requestAt,resolveRequest,sendRequest }=require('../src/http/client');
const { websocketWorkbench }=require('../src/http/websocket');
const { apiProtocolsFixture,waitForProtocol }=require('./helpers/api-protocols-fixture');

test('GraphQL executes selected operations with variables, exposes errors and introspects its schema',async t=>{
  const token=randomUUID();
  const fixture=await apiProtocolsFixture(token);
  t.after(()=>fixture.close());
  const raw=fixture.http+'/graphql\nAuthorization: Bearer {{secret.token}}\n\n';
  const source='GRAPHQL '+raw+JSON.stringify({
    query:'query Other { greet(name: "other") } mutation Edit($text: String!) { setMessage(text: $text) }',
    operationName:'Edit',variables:{text:'{{quoted}}'}
  });
  const readSecret=()=>token;
  const environment={quoted:'A string with a quote " and newline\nnext line'};
  const response=await sendRequest(await resolveRequest(requestAt(source,0),environment,readSecret));
  assert.deepEqual(response.graphql,{kind:'operation',graphqlResponse:true,hasData:true,errors:0});
  assert.equal(JSON.parse(response.body).data.setMessage,environment.quoted);
  assert.deepEqual(fixture.requests[0],{method:'POST',contentType:'application/json',
    accept:'application/graphql-response+json, application/json',authorized:true,operationName:'Edit'});
  const partial='# @expect json $.data.greet == "Hello Zoe"\nGRAPHQL '+raw+
    '{ greet(name: "Zoe") echoedToken failure }';
  const result=await sendRequest(await resolveRequest(requestAt(partial,0),{},readSecret));
  assert.deepEqual(result.graphql,{kind:'operation',graphqlResponse:true,hasData:true,errors:1});
  assert.deepEqual(JSON.parse(result.body).data,{greet:'Hello Zoe',echoedToken:'[redacted]',failure:null});
  assert.equal(result.assertions[0].passed,true);
  const inspection=await sendRequest(await resolveRequest(requestAt(source,0),{},readSecret,{schema:true}));
  assert.equal(inspection.graphql.kind,'schema');
  const schema=JSON.parse(inspection.body).data.__schema;
  assert.equal(schema.mutationType.name,'Mutation');
  assert.ok(schema.types.find(type=>type.name==='Query').fields.some(field=>field.name==='greet'));
});

test('GraphQL rejects malformed JSON inputs and WebSocket protects handshake fields',async()=>{
  const resolve=async(text,opts)=>resolveRequest(requestAt(text,0),{},()=> 'private',opts);
  await assert.rejects(resolve('GRAPHQL https://example.test\n\n'),/operation/);
  await assert.rejects(resolve('GRAPHQL https://example.test\n\n{"query":false}'),/query string/);
  await assert.rejects(resolve('GRAPHQL https://example.test\n\n{"query":"{ x }","variables":[]}'),/JSON object/);
  await assert.rejects(resolve('GRAPHQL https://example.test\n\n{"query":"{ x }","variables":{"value":9007199254740993}}'),/large integer/);
  await assert.rejects(resolve('GRAPHQL https://example.test\nContent-Type: text/plain\n\n{x}'),/application\/json/);
  await assert.rejects(resolve('GET https://example.test',{schema:true}),/Select a GRAPHQL/);
  await assert.rejects(resolve('WEBSOCKET https://example.test'),/ws:\/\//);
  await assert.rejects(resolve('WEBSOCKET wss://example.test\nSec-WebSocket-Key: unchanged'),/handshake/);
  await assert.rejects(resolve('WEBSOCKET wss://example.test\nSec-WebSocket-Protocol: a, a'),/distinct/);
  await assert.rejects(resolve('WEBSOCKET wss://example.test\nSec-WebSocket-Protocol: {{secret.token}}'),/headers or body/);
  await assert.rejects(resolve('WEBSOCKET wss://example.test\n\nfirst message'),/Open the WebSocket/);
});

test('WebSocket receives text and binary frames, bounds messages and closes real connections',async t=>{
  const token=randomUUID();
  const fixture=await apiProtocolsFixture(token,{reflectToken:true});
  const client=websocketWorkbench();
  t.after(async()=>{client.dispose();await fixture.close();});
  const request=path=>resolveRequest(requestAt('WEBSOCKET '+fixture.websocket+path+
    '\nAuthorization: Bearer {{secret.token}}\nSec-WebSocket-Protocol: rocketbrain.echo, secondary',0),{},()=>token);
  const connect=async(path,signal)=>client.connect(await request(path),{owner:'fixture',environment:'local',signal});
  const connection=await connect('/echo?private=query');
  assert.equal(connection.state,'open');
  assert.equal(connection.protocol,'rocketbrain.echo');
  assert.equal(connection.endpoint,fixture.websocket+'/echo');
  assert.throws(()=>client.get(connection.id,'other'),/workspace/);
  await assert.rejects(client.send(connection.id,'fixture','x'.repeat(128*1024+1)),/128 KiB/);
  await client.send(connection.id,'fixture','Unicode 안녕');
  const get=()=>client.get(connection.id,'fixture');
  const echoed=await waitForProtocol(get,state=>state.messages.length===3);
  assert.equal(fixture.frames[0].text,'Unicode 안녕');
  assert.equal(fixture.frames[0].protocol,'rocketbrain.echo');
  assert.deepEqual(JSON.parse(echoed.messages.find(message=>message.kind==='text' && message.direction==='in').text),
    {received:'Unicode 안녕',token:'[redacted]'});
  assert.ok(echoed.messages.some(message=>message.kind==='binary' && message.size===3 && message.text===null));
  client.close(connection.id,'fixture');
  assert.equal((await waitForProtocol(get,state=>state.state==='closed')).closeCode,1000);
  const oversized=await connect('/large');
  const failed=await waitForProtocol(()=>client.get(oversized.id,'fixture'),state=>state.state==='closed');
  assert.match(failed.error,/exceeded 1 MiB/);
  assert.equal(failed.messages.length,0);
  const flooded=await connect('/many');
  const retained=await waitForProtocol(()=>client.get(flooded.id,'fixture'),state=>state.dropped===16);
  assert.equal(retained.messages.length,64);
  assert.equal(retained.messages[0].text,'Message 16');
  await assert.rejects(connect('/redirect'),/handshake failed/);
  assert.equal(fixture.redirectedConnections(),0);
  await assert.rejects(connect('/wait',AbortSignal.timeout(40)),/cancelled/);
});
