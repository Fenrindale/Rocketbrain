'use strict';

const http=require('node:http');
const { once }=require('node:events');
const { setTimeout:delay }=require('node:timers/promises');
const { buildSchema,graphql }=require('graphql');
const { WebSocketServer }=require('ws');

async function apiProtocolsFixture(token,{reflectToken=false}={}) {
  const schema=buildSchema(`type Query { greet(name: String!): String!, echoedToken: String!, failure: String }
    type Mutation { setMessage(text: String!): String! }`);
  const rootValue={greet:({name})=>'Hello '+name,echoedToken:()=>token,
    failure:()=>{throw Error('Fixture refused this field');},setMessage:({text})=>text};
  const requests=[],frames=[];
  let redirectedConnections=0;
  const server=http.createServer(async(request,response)=>{
    if (request.url!=='/graphql' || request.method!=='POST') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks=[];
      for await (const chunk of request) chunks.push(chunk);
      const envelope=JSON.parse(Buffer.concat(chunks));
      const authorized=request.headers.authorization==='Bearer '+token;
      requests.push({method:request.method,contentType:request.headers['content-type'],accept:request.headers.accept,
        authorized,operationName:envelope.operationName});
      if (!authorized) {
        response.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({errors:[{message:'Unauthorized'}]}));
        return;
      }
      const result=await graphql({schema,source:envelope.query,operationName:envelope.operationName,
        variableValues:envelope.variables,rootValue});
      response.writeHead(200,{'content-type':'application/graphql-response+json'}).end(JSON.stringify(result));
    } catch {
      response.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({errors:[{message:'Bad HTTP envelope'}]}));
    }
  });
  const websocket=new WebSocketServer({noServer:true,perMessageDeflate:false});
  server.on('upgrade',(request,socket,head)=>{
    const end=message=>socket.end('HTTP/1.1 '+message+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (request.url==='/redirect') {
      end('302 Found\r\nLocation: ws://127.0.0.1:'+server.address().port+'/redirect-target');
      return;
    }
    if (request.url==='/redirect-target') redirectedConnections++;
    if (request.url==='/wait') return; // The focused test cancels this handshake.
    if (request.headers.authorization!=='Bearer '+token) { end('401 Unauthorized'); return; }
    websocket.handleUpgrade(request,socket,head,client=>{
      if (request.url==='/large') {
        client.send(Buffer.alloc(1024*1024+1,65));
        return;
      }
      if (request.url==='/many') {
        for (let index=0;index<80;index++) client.send('Message '+index);
        return;
      }
      client.on('message',(data,binary)=>{
        frames.push({text:data.toString('utf8'),binary,protocol:client.protocol});
        const received={received:data.toString('utf8')};
        if (reflectToken) received.token=token;
        client.send(JSON.stringify(received));
        client.send(Buffer.from([0x00,0x84,0xff]),{binary:true});
      });
      client.on('close',()=>socket.destroy());
    });
  });
  const sockets=new Set();
  server.on('connection',socket=>{
    sockets.add(socket);
    socket.once('close',()=>sockets.delete(socket));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {
    http:'http://127.0.0.1:'+server.address().port, websocket:'ws://127.0.0.1:'+server.address().port,
    requests,frames,redirectedConnections:()=>redirectedConnections,
    async close() {
      for (const client of websocket.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise(resolve=>websocket.close(resolve)),new Promise(resolve=>server.close(resolve))]);
    }
  };
}

async function waitForProtocol(read,accept) {
  const deadline=performance.now()+5000;
  do {
    const result=read();
    if (accept(result)) return result;
    await delay(20);
  } while (performance.now()<deadline);
  throw Error('The loopback protocol response did not reach its expected state.');
}

module.exports={apiProtocolsFixture,waitForProtocol};
