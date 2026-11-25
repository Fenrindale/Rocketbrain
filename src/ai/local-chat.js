'use strict';

const http = require('node:http');
const net = require('node:net');

const modelName = /^[A-Za-z0-9][A-Za-z0-9_./:+-]{0,127}$/;
const maxRequestBytes = 32 * 1024;
const maxResponseBytes = 64 * 1024;
const timeoutMs = 30000;
const cancelled = 'ROCKETBRAIN_LOCAL_CHAT_CANCELLED';

function failure(message, code = 'ROCKETBRAIN_LOCAL_CHAT') {
  return Object.assign(new Error(message), { code });
}

function normalizeLocalChatTarget(endpoint, model) {
  const url = typeof endpoint === 'string' && /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/v1\/chat\/completions$/.exec(endpoint);
  if (!url || Number(url[2]) > 65535 || typeof model !== 'string' || !modelName.test(model)) {
    throw failure('Configure a numeric loopback Chat Completions endpoint with its port and a local model name.');
  }
  return { endpoint, host: url[1] === '[::1]' ? '::1' : url[1], port: Number(url[2]), model };
}

async function requestLocalChat(target, body, { signal } = {}) {
  const destination = normalizeLocalChatTarget(target.endpoint, target.model);
  if (!body || Array.isArray(body) || typeof body !== 'object' || ['tools', 'functions', 'tool_choice', 'function_call'].some(key => Object.hasOwn(body, key))) {
    throw failure('Provide a bounded Chat Completions request without tool calls.');
  }
  const payload = JSON.stringify({ ...body, model: destination.model, stream: false });
  const bytes = Buffer.byteLength(payload);
  if (bytes > maxRequestBytes) throw failure('The local model request exceeded 32 KiB.');
  if (signal?.aborted) throw failure('The local model request was cancelled.', cancelled);
  const timeout = AbortSignal.timeout(timeoutMs);
  const cancel = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal?.aborted ? failure('The local model request was cancelled.', cancelled) :
      timeout.aborted ? failure('The local model did not respond within 30 seconds.') : failure('The configured local model could not complete the request.'));
    const call = http.request({ hostname: destination.host, port: destination.port, path: '/v1/chat/completions', method: 'POST',
      createConnection: () => net.connect({ host: destination.host, port: destination.port }), signal: cancel,
      headers: { 'Content-Type': 'application/json', 'Content-Length': bytes } }, response => {
      if (response.statusCode === 404) {
        reject(failure('The configured local model or Chat Completions endpoint is unavailable.'));
        response.destroy();
        return;
      }
      if (response.statusCode !== 200 || !/^application\/json\b/i.test(response.headers['content-type'] ?? '')) {
        fail();
        response.destroy();
        return;
      }
      const chunks = [];
      let received = 0;
      response.once('error', fail);
      response.once('aborted', fail);
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maxResponseBytes) {
          reject(failure('The local model response exceeded 64 KiB.'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.once('end', () => {
        if (cancel.aborted) { fail(); return; }
        try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { reject(failure('The local model did not return a valid JSON response.')); }
      });
    });
    call.once('error', fail);
    call.end(payload);
  });
}

module.exports = { normalizeLocalChatTarget, requestLocalChat, cancelled };
