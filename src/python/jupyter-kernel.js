'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const source = require('./jupyter-bridge-source.json');
const { localPython, pythonEnvironment } = require('./local-python');

function openJupyterKernel({ python, directory }) {
  const executable = localPython(python);
  if (!fs.statSync(directory).isDirectory()) throw Error('Choose a local notebook directory.');
  const worker = spawn(executable, ['-I', '-u', '-c', source, directory], {
    cwd: directory, env: pythonEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let running = null;
  let buffer = Buffer.alloc(0);
  let startupError = '';
  let stopped = false;
  let closing;
  let readyResolve;
  let readyReject;
  let exitedResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => { exitedResolve = resolve; });
  void ready.catch(() => {});
  const startup = setTimeout(() => { fail(Error('The Python notebook kernel did not start within 26 seconds.')); void close(); }, 26000);

  function fail(error) {
    clearTimeout(startup);
    readyReject(error);
    running?.reject(error);
    running?.pending?.reject(error);
  }

  function receive(line) {
    let data;
    try { data = JSON.parse(line.toString('utf8')); }
    catch { fail(Error('The Python notebook kernel returned invalid bridge data.')); void close(); return; }
    if (data?.ready === true && data.language === 'python' && typeof data.version === 'string') {
      clearTimeout(startup);
      readyResolve({ language: data.language, version: data.version, debugger: data.debugger === true });
      return;
    }
    const control = running?.pending;
    if (control && data?.id === control.id) {
      if (typeof data.error === 'string') control.reject(Error(data.error));
      else if (control.action === 'locals' && data.debug?.state === 'paused' && data.debug.pause === running.paused?.pause &&
          Array.isArray(data.debug.variables) && data.debug.variables.length <= 80 && data.debug.variables.every(value =>
            typeof value?.name === 'string' && typeof value.value === 'string' && typeof value.type === 'string')) {
        control.resolve(data.debug);
      } else if (control.action !== 'locals' && data.debug?.state === 'running') {
        running.paused = null;
        control.resolve({ state: 'running' });
      } else control.reject(Error('The Python notebook debugger returned an incomplete action result.'));
      return;
    }
    if (!running || data?.id !== running.id) return;
    if (running.debug && data.debug?.state === 'paused' && data.debug.pause === running.pauses + 1 &&
        Number.isSafeInteger(data.debug.line) && data.debug.line >= 1 && data.debug.line <= running.lines &&
        ['breakpoint', 'step'].includes(data.debug.reason)) {
      running.pauses++;
      running.paused = data.debug;
      try { running.onDebug?.({ ...data.debug }); }
      catch { fail(Error('The Python notebook debugger could not display its current cell.')); void close(); }
    } else if (typeof data.error === 'string') running.reject(Error(data.error));
    else if (Array.isArray(data.outputs) && typeof data.success === 'boolean') running.resolve(data);
    else running.reject(Error('The Python notebook kernel returned an incomplete cell result.'));
  }

  worker.stdout.on('data', part => {
    if (buffer.length + part.length > 3 * 1024 * 1024) {
      fail(Error('The Python notebook kernel exceeded its bridge output limit.'));
      void close();
      return;
    }
    buffer = Buffer.concat([buffer, part]);
    for (let end; (end = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      receive(line);
    }
  });
  worker.stderr.on('data', part => {
    if (startupError.length < 2000) startupError += part.toString('utf8').slice(0, 2000 - startupError.length);
  });
  worker.stdin.on('error', () => fail(Error('The Python notebook kernel input closed.')));
  worker.on('error', () => fail(Error('Could not start the configured Python interpreter.')));
  worker.on('close', () => {
    stopped = true;
    exitedResolve();
    const missing = /No module named ['"]?(jupyter_client|ipykernel)/.exec(startupError)?.[1];
    fail(Error(missing ? 'Install ' + missing + ' in the configured notebook Python environment.' : 'The Python notebook kernel has exited.'));
  });

  function request(message) {
    if (stopped || closing || !worker.stdin.writable) throw Error('The Python notebook kernel has stopped.');
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024) throw Error('The notebook cell exceeds the bridge input limit.');
    worker.stdin.write(line);
  }

  async function runCell(code, { cancellation, line, onDebug } = {}) {
    if (typeof code !== 'string' || Buffer.byteLength(code) > 384 * 1024) throw Error('Run a notebook cell up to 384 KiB.');
    const debug = line !== undefined;
    const lines = code.split('\n').length;
    if (debug && (!Number.isSafeInteger(line) || line < 1 || line > lines)) throw Error('Choose a Python breakpoint line in the selected cell.');
    const options = await ready;
    if (debug && !options.debugger) throw Error('Install debugpy in the selected notebook Python environment.');
    if (running) throw Error('Wait for this notebook cell to finish.');
    if (cancellation?.aborted || cancellation?.isCancellationRequested) throw Error('The notebook cell was cancelled.');
    const id = randomUUID();
    let listener;
    const interrupt = () => {
      try { request({ id: randomUUID(), op: 'cancel', for: id }); }
      catch (error) { running?.reject(error); }
    };
    const timer = setTimeout(() => {
      fail(Error(debug ? 'The notebook debug session exceeded its time limit.' : 'The notebook cell did not finish within 68 seconds.'));
      void close();
    }, debug ? 224000 : 68000);
    try {
      const result = await new Promise((resolve, reject) => {
        running = { id, resolve, reject, debug, lines, onDebug, pauses: 0, paused: null };
        request({ id, op: debug ? 'debug' : 'execute', code: debug ? code.replace(/\r\n/gu, '\n') : code, ...(debug && { line }) });
        if (cancellation?.onCancellationRequested) listener = cancellation.onCancellationRequested(interrupt);
        else cancellation?.addEventListener('abort', interrupt, { once: true });
        if (cancellation?.aborted || cancellation?.isCancellationRequested) interrupt();
      });
      if (result.kernelStopped) await close();
      return result;
    } finally {
      clearTimeout(timer);
      running?.pending?.reject(Error('The notebook debug session ended.'));
      running = null;
      listener?.dispose();
      cancellation?.removeEventListener?.('abort', interrupt);
    }
  }

  async function debugControl(action, pause) {
    const session = running;
    if (!session?.debug || !session.paused || pause !== session.paused.pause || !['locals', 'next', 'continue'].includes(action)) {
      throw Error('Select the current paused Python notebook cell.');
    }
    if (session.pending) throw Error('Wait for the current notebook debugger action.');
    const id = randomUUID();
    const timer = setTimeout(() => {
      fail(Error('The notebook debugger action exceeded its time limit.'));
      void close();
    }, 18000);
    try {
      return await new Promise((resolve, reject) => {
        session.pending = { id, action, resolve, reject };
        request({ id, op: 'debug-action', for: session.id, pause, action });
      });
    } finally {
      clearTimeout(timer);
      session.pending = null;
    }
  }

  function close() {
    if (closing) return closing;
    if (stopped) return exited;
    worker.stdin.end(JSON.stringify({ id: randomUUID(), op: 'shutdown' }) + '\n');
    const timer = setTimeout(() => worker.kill(), 9000);
    closing = exited.finally(() => clearTimeout(timer));
    return closing;
  }

  return { ready, execute: (code, options) => runCell(code, { cancellation: options?.cancellation }),
    async debug(code, line, options) {
      if (line === undefined) throw Error('Choose a Python breakpoint line in the selected cell.');
      return runCell(code, { ...options, line });
    },
    debugControl, close, get stopped() { return stopped; } };
}

module.exports = { openJupyterKernel };
