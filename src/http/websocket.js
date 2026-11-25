'use strict';

const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

const maxMessageBytes = 1024 * 1024;
const maxSendBytes = 128 * 1024;
const maxPreviewBytes = 8192;
const maxHistoryBytes = 128 * 1024;
const maxHistoryMessages = 64;
const maxActiveSessions = 4;
const maxClosedSessions = 4;

function websocketWorkbench(onChange) {
  const sessions = new Map();
  let disposed = false;

  function snapshot(session) {
    return {
      id:session.id,endpoint:session.endpoint,environment:session.environment,
      state:session.state,protocol:session.protocol,closeCode:session.closeCode,
      closeReason:session.closeReason,error:session.error,dropped:session.dropped,
      messages:session.messages.map(({bytes,...message})=>({...message}))
    };
  }

  function publish(session) {
    if (!disposed) onChange?.(snapshot(session));
  }

  function remember(session,direction,data,isBinary) {
    if (disposed || session.state==='closed') return;
    const size=Buffer.byteLength(data);
    // Redact before truncating so a secret near the preview boundary cannot be split.
    const preview=isBinary?null:Buffer.from(session.redact(data.toString('utf8')));
    const text=preview?.subarray(0,maxPreviewBytes).toString('utf8') ?? null;
    const bytes=Buffer.byteLength(text ?? '');
    const item={direction,kind:isBinary?'binary':'text',text,size,bytes,
      truncated:preview!==null && preview.length>maxPreviewBytes};
    session.historyBytes+=bytes;
    session.messages.push(item);
    while (session.historyBytes>maxHistoryBytes || session.messages.length>maxHistoryMessages) {
      session.historyBytes-=session.messages.shift().bytes;
      session.dropped++;
    }
    publish(session);
  }

  async function connect(request,{signal,owner,environment}={}) {
    if (disposed || signal?.aborted) throw Error('The WebSocket connection was cancelled.');
    if ([...sessions.values()].filter(item=>item.state!=='closed').length>=maxActiveSessions) {
      throw Error('Close a WebSocket connection before opening another.');
    }
    const socket=new WebSocket(request.url,request.protocols,{
      headers:request.headers,followRedirects:false,handshakeTimeout:10000,
      closeTimeout:3000,maxPayload:maxMessageBytes,perMessageDeflate:false
    });
    const session={id:randomUUID(),owner,environment,socket,state:'connecting',redact:request.redact,
      endpoint:request.redact(request.url.origin+request.url.pathname),protocol:'',messages:[],dropped:0,historyBytes:0};
    sessions.set(session.id,session);
    return new Promise((resolve,reject)=>{
      let opened=false;
      const abort=()=>socket.terminate();
      socket.once('open',()=>{
        signal?.removeEventListener('abort',abort);
        opened=true;
        session.state='open';
        session.protocol=request.redact(socket.protocol);
        publish(session);
        resolve(snapshot(session));
      });
      socket.on('message',(data,isBinary)=>remember(session,'in',data,isBinary));
      socket.on('error',error=>{
        session.error=error.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ?'WebSocket message exceeded 1 MiB.'
          :opened?'The WebSocket transport failed.':'The WebSocket handshake failed.';
        if (!opened) {
          sessions.delete(session.id);
          reject(Error(disposed || signal?.aborted?'The WebSocket connection was cancelled.':session.error));
        }
      });
      socket.once('close',(code,reason)=>{
        signal?.removeEventListener('abort',abort);
        session.state='closed';
        if (!opened) {
          sessions.delete(session.id);
          reject(Error(disposed || signal?.aborted?'The WebSocket connection was cancelled.':'The WebSocket handshake failed.'));
          return;
        }
        session.closeCode=code;
        session.closeReason=session.redact(reason.toString('utf8'));
        session.redact=String;
        session.socket=undefined;
        const archived=[...sessions.values()].filter(item=>item.state==='closed');
        for (const item of archived.slice(0,Math.max(0,archived.length-maxClosedSessions))) sessions.delete(item.id);
        publish(session);
      });
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
    });
  }

  function owned(id,owner) {
    const session=sessions.get(id);
    if (!session || session.owner!==owner || disposed) throw Error('Choose a WebSocket connection in this workspace.');
    return session;
  }

  async function send(id,owner,text) {
    const session=owned(id,owner);
    if (session.state!=='open' || session.socket.readyState!==WebSocket.OPEN) throw Error('Choose an open WebSocket connection.');
    if (typeof text!=='string' || Buffer.byteLength(text)>maxSendBytes) throw Error('WebSocket text messages are limited to 128 KiB.');
    if (session.socket.bufferedAmount>maxSendBytes) throw Error('Wait for the WebSocket send queue to drain.');
    const sent=new Promise((resolve,reject)=>session.socket.send(text,{binary:false},
      error=>error?reject(Error('Unable to send the WebSocket message.')):resolve()));
    await sent;
    remember(session,'out',text,false);
    return snapshot(session);
  }

  return {
    connect,send,
    list:owner=>[...sessions.values()].filter(item=>item.owner===owner && item.state!=='connecting').map(snapshot),
    get:(id,owner)=>snapshot(owned(id,owner)),
    close(id,owner) {
      const session=owned(id,owner);
      if (session.state==='open') {
        session.state='closing';
        session.socket.close(1000);
        publish(session);
      }
      return snapshot(session);
    },
    dispose() {
      disposed=true;
      for (const session of sessions.values()) if (session.state!=='closed') session.socket.terminate();
      sessions.clear();
    }
  };
}

module.exports = { websocketWorkbench };
