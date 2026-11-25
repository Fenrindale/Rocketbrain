'use strict';

const grpc = require('@grpc/grpc-js');
const { definition } = require('../../src/http/grpc');

const echoProto = `syntax = "proto3";
package rocket.fixture;
message Value { string text = 1; int64 id = 2; }
service Echo {
  rpc One(Value) returns (Value);
  rpc Many(Value) returns (stream Value);
  rpc Collect(stream Value) returns (Value);
  rpc Mirror(stream Value) returns (stream Value);
  rpc Wait(Value) returns (Value);
  rpc Flood(Value) returns (stream Value);
}`;

async function grpcFixture(token) {
  const server = new grpc.Server();
  const observed = { calls:0, authenticated:0, cancelled:0 };
  const Echo = grpc.loadPackageDefinition(definition(echoProto)).rocket.fixture.Echo;
  function authorize(call, respond) {
    observed.calls++;
    if (call.metadata.get('authorization')[0] === 'Bearer '+token) { observed.authenticated++; return true; }
    const error = { code:grpc.status.UNAUTHENTICATED, details:'Fixture did not accept the token.' };
    if (respond) respond(error); else call.emit('error',error);
    return false;
  }
  server.addService(Echo.service, {
    One(call,respond) {
      if (authorize(call,respond)) respond(null,{ ...call.request,text:call.request.text === 'redact' ? token : call.request.text });
    },
    Many(call) {
      if (!authorize(call)) return;
      call.write({ ...call.request,text:'one' });
      call.write({ ...call.request,text:'two' });
      call.end();
    },
    Collect(call,respond) {
      if (!authorize(call,respond)) return;
      const values=[];
      call.on('data',value=>values.push(value));
      call.on('end',()=>respond(null,{text:values.map(value=>value.text).join('/'),id:values.at(-1)?.id||'0'}));
    },
    Mirror(call) {
      if (!authorize(call)) return;
      call.on('data',value=>call.write(value));
      call.on('end',()=>call.end());
    },
    Wait(call,respond) {
      if (authorize(call,respond)) call.on('cancelled',()=>{observed.cancelled++;});
    },
    Flood(call) {
      if (!authorize(call)) return;
      for (let i=0;i<70;i++) call.write({text:'row',id:String(i)});
      call.end();
    }
  });
  const port = await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),
    (error,value)=>error ? reject(error) : resolve(value)));
  return { observed,endpoint:'grpc://127.0.0.1:'+port+'/rocket.fixture.Echo/',dispose(){server.forceShutdown();} };
}

module.exports = { echoProto, grpcFixture };
