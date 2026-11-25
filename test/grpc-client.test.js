'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { definition, sendGrpc } = require('../src/http/grpc');
const { requestAt, resolveRequest } = require('../src/http/client');
const { echoProto, grpcFixture } = require('./helpers/grpc-fixture');

test('gRPC runs unary, server, client and bidirectional streaming on a real authenticated loopback server', async () => {
  const token = 'fixture-grpc-token';
  const fixture = await grpcFixture(token);
  const value = { text:'sample', id:'9007199254740995' };
  const make = async (method,body=value) => {
    const source = ['GRPC '+fixture.endpoint+method,'Proto: api/echo.proto','Authorization: Bearer {{secret.token}}','',JSON.stringify(body)].join('\n');
    const ready = await resolveRequest(requestAt(source,0),{},async()=>token);
    assert.equal(ready.proto,'api/echo.proto');
    assert.deepEqual(Object.keys(ready.headers),['Authorization']);
    return sendGrpc(ready,echoProto);
  };
  try {
    const unary=await make('One');
    assert.equal(unary.grpc.mode,'unary');
    assert.deepEqual(JSON.parse(unary.body),value);
    const server=await make('Many');
    assert.deepEqual(server.grpc,{method:'/rocket.fixture.Echo/Many',mode:'server-stream',sent:1,received:2});
    assert.deepEqual(JSON.parse(server.body).map(item=>item.text),['one','two']);
    const client=await make('Collect',[value,{...value,text:'next'}]);
    assert.equal(client.grpc.mode,'client-stream');
    assert.deepEqual(JSON.parse(client.body),{...value,text:'sample/next'});
    const duplex=await make('Mirror',[value,{...value,text:'next'}]);
    assert.equal(duplex.grpc.mode,'bidirectional-stream');
    assert.deepEqual(JSON.parse(duplex.body),[value,{...value,text:'next'}]);
    const redacted=await make('One',{...value,text:'redact'});
    assert.equal(JSON.parse(redacted.body).text,'[redacted]');
    assert.equal(fixture.observed.authenticated,5);
  } finally {fixture.dispose();}
});

test('gRPC rejects unobserved methods, unsafe proto imports and request/response boundary violations', async () => {
  const token='fixture-token';
  const fixture=await grpcFixture(token);
  const request=(method,body='{}')=>({url:fixture.endpoint+method,body,headers:{ authorization:'Bearer '+token }});
  try {
    assert.throws(()=>definition('syntax="proto3"; import "outside.proto";'),/self-contained/);
    await assert.rejects(sendGrpc(request('DoesNotExist'),echoProto),/exact service and method/);
    await assert.rejects(sendGrpc(request('One','[]'),echoProto),/one JSON object/);
    await assert.rejects(sendGrpc({...request('One'),headers:{authorization:'wrong'}},echoProto),/UNAUTHENTICATED/);
    await assert.rejects(sendGrpc(request('Flood'),echoProto),/message or byte limit/);
    await assert.rejects(sendGrpc(request('Wait'),echoProto,{timeoutMs:120}),/DEADLINE_EXCEEDED/);
    const aborted = AbortSignal.abort();
    await assert.rejects(sendGrpc(request('Wait'),echoProto,{signal:aborted}),/cancelled/);
  } finally {fixture.dispose();}
});
