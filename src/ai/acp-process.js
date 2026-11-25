'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const maxFrame = 64 * 1024;
const maxReview = 64 * 1024;
const aborted = () => Object.assign(Error('The ACP session was cancelled.'), { code: 'ACP_CANCELLED' });

async function agentProgram(profile) {
  if (!profile || typeof profile.label !== 'string' || !profile.label.trim() || profile.label.length > 80 ||
      typeof profile.executable !== 'string' || !path.isAbsolute(profile.executable) ||
      (process.platform === 'win32' && !/\.exe$/i.test(profile.executable))) {
    throw Error('Configure a label and absolute path to a local ACP executable.');
  }
  const args = profile.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg =>
    typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f]/.test(arg))) throw Error('Use up to 32 literal ACP arguments.');
  const executable = await fs.realpath(profile.executable);
  if (!(await fs.stat(executable)).isFile()) throw Error('Select a local ACP executable file.');
  return { label: profile.label.trim(), executable, args: [...args] };
}

async function runAgent(profile, { cwd, text, signal, onUpdate, promptTimeout = 90000 }) {
  const { label, executable, args } = await agentProgram(profile);
  if (!path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw Error('Open a local workspace folder.');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16 * 1024) {
    throw Error('Enter a request of up to 16 KiB.');
  }
  if (signal?.aborted) throw aborted();
  const child = spawn(executable,args,{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending = new Map();
  let unusable;
  let sessionId;
  let nextId = 1;
  let fragment = Buffer.alloc(0);
  let output = '';
  let outputBytes = 0;
  let denied = 0;
  let closed = false;
  let completed = false;

  const stop = new Promise(resolve => child.once('close', () => {
    closed = true;
    fail(Error('The ACP executable closed the session.'));
    resolve();
  }));
  child.once('error', () => fail(Error('The local ACP executable could not start.')));
  child.stdin.on('error', () => fail(Error('The ACP executable closed its input.')));
  child.stderr.resume();

  function fail(error) {
    if (unusable) return;
    unusable = error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }
  function send(message) {
    child.stdin.write(JSON.stringify({ jsonrpc:'2.0',...message }) + '\n');
  }
  function request(method, params, duration = 12000) {
    if (unusable) return Promise.reject(unusable);
    const id = nextId++;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => fail(Error('The ACP agent did not reply in time.')), duration);
      pending.set(id,{ resolve,reject,timer });
      send({ method, params, id });
    });
  }
  function response(message) {
    if (message?.jsonrpc !== '2.0') throw Error('The ACP agent returned an invalid frame.');
    const { id, method, params } = message;
    if (method && id !== undefined) {
      if (!Number.isSafeInteger(id) && (typeof id !== 'string' || Buffer.byteLength(id) > 256)) throw Error('Invalid ACP request ID.');
      if (method === 'session/request_permission' && sessionId && params?.sessionId === sessionId) {
        denied++;
        send({ id,result:{ outcome:{ outcome:'cancelled' } } });
      } else {
        send({ id,error:{ code:-32601,message:'Editor capabilities are unavailable.' } });
      }
      return;
    }
    if (method === 'session/update' && sessionId && params?.sessionId === sessionId) {
      const update = params.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' &&
          typeof update.content.text === 'string') {
        outputBytes += Buffer.byteLength(update.content.text);
        if (outputBytes > maxReview) throw Error('The ACP reply exceeded its review limit.');
        output += update.content.text;
        onUpdate?.(outputBytes);
      }
      return;
    }
    const call = pending.get(id);
    if (!call || method) return;
    pending.delete(id);
    clearTimeout(call.timer);
    if (message.error) call.reject(Error('The ACP agent rejected a ' + (sessionId ? 'session' : 'setup') + ' request.'));
    else call.resolve(message.result);
  }
  child.stdout.on('data', chunk => {
    if (unusable || completed) return;
    try {
      const lines = Buffer.concat([fragment,chunk]);
      let cursor = 0;
      for (let index = lines.indexOf(10); index !== -1; index = lines.indexOf(10,cursor)) {
        if (index - cursor > maxFrame) throw Error('The ACP frame exceeded its limit.');
        const line = lines.subarray(cursor,index).toString('utf8').trim();
        cursor = index + 1;
        if (line) response(JSON.parse(line));
      }
      fragment = lines.subarray(cursor);
      if (fragment.length > maxFrame) throw Error('The ACP frame exceeded its limit.');
    } catch (error) {
      fail(error instanceof SyntaxError ? Error('The ACP agent returned malformed JSON.') : error);
      child.kill();
    }
  });
  const cancel = () => {
    if (sessionId && !unusable) send({ method:'session/cancel',params:{ sessionId } });
    fail(aborted());
  };
  signal?.addEventListener('abort',cancel,{ once:true });
  if (signal?.aborted) cancel();
  try {
    const support = await request('initialize',{ protocolVersion:1,
      clientInfo:{ name:'rocketbrain',version:'1.0.0' },clientCapabilities:{ fs:{ readTextFile:false,writeTextFile:false },terminal:false } });
    if (support?.protocolVersion !== 1) throw Error('Choose a peer supporting stable ACP version 1.');
    const session = await request('session/new',{ cwd,mcpServers:[] });
    if (typeof session?.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 256) {
      throw Error('The ACP peer returned an invalid session ID.');
    }
    sessionId = session.sessionId;
    const reply = await request('session/prompt',{ sessionId,prompt:[{ type:'text',text }] },promptTimeout);
    if (typeof reply?.stopReason !== 'string' || !/^[a-z_]{1,40}$/.test(reply.stopReason)) {
      throw Error('The ACP peer returned an invalid stop reason.');
    }
    completed = true;
    return { label,output,stopReason:reply.stopReason,denied };
  } finally {
    signal?.removeEventListener('abort',cancel);
    child.stdin.end();
    if (!closed) await Promise.race([stop,delay(250,undefined,{ ref:false })]);
    if (!closed) child.kill();
    if (!closed) await Promise.race([stop,delay(2000,undefined,{ ref:false })]);
    if (!closed) throw Error('The owned ACP process did not close.');
  }
}

module.exports = { agentProgram, runAgent };
