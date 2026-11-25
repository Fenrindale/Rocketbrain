'use strict';

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const protobuf = require('protobufjs');

const MAX_MESSAGES = 64;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PROTO = 128 * 1024;
const protocolPath = /^\/(?:[a-z_]\w*\.)*[a-z_]\w*\/[a-z_]\w*$/i;

function definition(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_PROTO) throw Error('Choose a Protocol Buffer source file up to 128 KiB.');
  let parsed;
  try { parsed = protobuf.parse(source); }
  catch { throw Error('The selected Protocol Buffer source could not be parsed.'); }
  if (parsed.imports?.length || parsed.weakImports?.length) throw Error('Choose a single self-contained Protocol Buffer source file.');
  try {
    parsed.root.resolveAll();
    return protoLoader.fromJSON(parsed.root.toJSON(), { keepCase:true, longs:String, enums:String, oneofs:true });
  } catch { throw Error('The Protocol Buffer services or message types could not be resolved.'); }
}

function parseEndpoint(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw Error('Use grpc://host:port/package.Service/Method or grpcs://.'); }
  if (!['grpc:', 'grpcs:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || !url.hostname ||
      !url.port || Number(url.port) < 1 || !protocolPath.test(url.pathname)) throw Error('Use a complete gRPC host, port, service and method.');
  return url;
}

function selectedMethod(source, endpoint) {
  const [,service,rpc] = endpoint.pathname.split('/');
  const packageDef = definition(source);
  const methods = Object.hasOwn(packageDef,service) ? packageDef[service] : null;
  const method = methods && Object.hasOwn(methods,rpc) ? methods[rpc] : null;
  if (!method || method.path !== endpoint.pathname || typeof method.requestSerialize !== 'function') {
    throw Error('The selected proto does not declare this exact service and method.');
  }
  return method;
}

function metadata(headers) {
  const result = new grpc.Metadata();
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(key) || key.startsWith('grpc-') || ['content-type','te','host'].includes(key)) {
      throw Error('Use application-defined gRPC metadata keys.');
    }
    if (key.endsWith('-bin')) {
      if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(value)) throw Error('Encode binary gRPC metadata as base64.');
      result.add(key, Buffer.from(value,'base64'));
    } else {
      if (/[^\x20-\x7e]/.test(value)) throw Error('Use printable ASCII in gRPC text metadata.');
      result.add(key,value);
    }
  }
  return result;
}

function payloads(method, body) {
  let value;
  try { value = JSON.parse(body || (method.requestStream ? '[]' : '{}')); }
  catch { throw Error('Use a JSON request body.'); }
  const messages = method.requestStream ? value : [value];
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
    throw Error(method.requestStream ? 'Use a JSON array of up to 64 objects for the request stream.' : 'Use one JSON object for this gRPC request.');
  }
  let size = 0;
  try { for (const message of messages) size += method.requestSerialize(message).length; }
  catch { throw Error('The request does not match the selected Protocol Buffer message.'); }
  if (size > MAX_BYTES) throw Error('The encoded gRPC request exceeds 2 MiB.');
  return messages;
}

function collect(client, endpoint, method, messages, headers, deadline, signal, redact) {
  return new Promise((resolve,reject) => {
    let call, complete = false, bytes = 0;
    const responses = [];
    const cancel = () => finish(Error('The gRPC request was cancelled.'),true);
    function finish(error, shouldCancel = false) {
      if (complete) return;
      complete = true;
      signal?.removeEventListener('abort',cancel);
      if (shouldCancel) call?.cancel();
      if (error) return reject(error);
      resolve(responses);
    }
    function failure(error) {
      const status = grpc.status[error?.code] || 'UNKNOWN';
      const detail = typeof error?.details === 'string' ? redact(error.details).slice(0,2048) : '';
      finish(Error('gRPC '+status+(detail ? ' · '+detail : '')));
    }
    function receive(message) {
      if (complete) return;
      try { bytes += Buffer.byteLength(JSON.stringify(message)); }
      catch { return finish(Error('The gRPC response could not be represented as JSON.'),true); }
      if (responses.length === MAX_MESSAGES || bytes > MAX_BYTES) return finish(Error('The gRPC response exceeded its message or byte limit.'),true);
      responses.push(message);
    }
    function callback(error,response) {
      if (error) failure(error);
      else { receive(response); finish(); }
    }
    const args = [endpoint.pathname,method.requestSerialize,method.responseDeserialize];
    const options = { deadline };
    try {
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort',cancel,{ once:true });
      if (method.requestStream && method.responseStream) call = client.makeBidiStreamRequest(...args,headers,options);
      else if (method.requestStream) call = client.makeClientStreamRequest(...args,headers,options,callback);
      else if (method.responseStream) call = client.makeServerStreamRequest(...args,messages[0],headers,options);
      else call = client.makeUnaryRequest(...args,messages[0],headers,options,callback);
      if (method.responseStream) {
        call.on('data',receive);
        call.on('end',() => finish());
      }
      call.on('error',failure);
      if (method.requestStream) {
        for (const message of messages) call.write(message);
        call.end();
      }
    } catch { finish(Error('The gRPC client could not start this request.'),true); }
  });
}

async function sendGrpc(request, source, { signal, timeoutMs = 10000 } = {}) {
  const started = performance.now(), redact = request.redact || (value => value);
  const endpoint = parseEndpoint(request.url);
  const method = selectedMethod(source,endpoint);
  const messages = payloads(method,request.body);
  const headers = metadata(request.headers);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw Error('Choose a gRPC deadline from 100 ms to 30 seconds.');
  const options = { 'grpc.enable_retries':0, 'grpc.max_send_message_length':MAX_BYTES, 'grpc.max_receive_message_length':MAX_BYTES };
  const credentials = endpoint.protocol === 'grpcs:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  const client = new grpc.Client(endpoint.host,credentials,options);
  try {
    const responses = await collect(client,endpoint,method,messages,headers,new Date(Date.now()+timeoutMs),signal,redact);
    const mode = method.requestStream ? (method.responseStream ? 'bidirectional-stream' : 'client-stream') :
      (method.responseStream ? 'server-stream' : 'unary');
    return { grpc:{ method:endpoint.pathname, mode, sent:messages.length, received:responses.length },
      body:redact(JSON.stringify(method.responseStream ? responses : responses[0],null,2)), durationMs:Math.round(performance.now()-started) };
  } finally { client.close(); }
}

module.exports = { definition, parseEndpoint, sendGrpc };
