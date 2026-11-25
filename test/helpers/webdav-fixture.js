'use strict';

const http=require('node:http');
const {createHash}=require('node:crypto');

async function webDavFixture() {
  const files=new Map(), observed=[];
  const directory='/dav/deploy/';
  const authorization='Basic '+Buffer.from('fixture:owned-password','utf8').toString('base64');
  function set(name,content,{weak=false}={}) {
    const bytes=Buffer.from(content);
    const sha=createHash('sha256').update(bytes).digest('hex');
    files.set(name,{bytes,etag:(weak?'W/':'')+'"'+sha+'"'});
  }
  const server=http.createServer(async(request,response)=>{
    try {
      const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
      if(request.headers.authorization!==authorization){response.writeHead(401).end();return;}
      if(!pathname.startsWith(directory)){response.writeHead(404).end();return;}
      const name=pathname.slice(directory.length);
      observed.push({method:request.method,name,ifMatch:request.headers['if-match'],ifNoneMatch:request.headers['if-none-match']});
      if(request.method==='OPTIONS' && !name){response.writeHead(200,{DAV:'1',Allow:'OPTIONS, GET, PUT'}).end();return;}
      const current=files.get(name);
      if(request.method==='GET') {
        if(!current){response.writeHead(404).end();return;}
        response.writeHead(200,{ETag:current.etag,'Content-Length':current.bytes.length}).end(current.bytes);
        return;
      }
      if(request.method==='PUT') {
        if(current && request.headers['if-match']!==current.etag || !current && request.headers['if-none-match']!=='*') {
          request.resume();response.writeHead(412).end();return;
        }
        const chunks=[];
        for await (const chunk of request) chunks.push(chunk);
        set(name,Buffer.concat(chunks));
        response.writeHead(current?204:201).end();
        return;
      }
      response.writeHead(405).end();
    } catch {response.writeHead(500).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return { url:'http://127.0.0.1:'+server.address().port+'/dav', remoteDirectory:'deploy', user:'fixture', password:'owned-password',
    files,observed,set,async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});} };
}

module.exports={webDavFixture};
