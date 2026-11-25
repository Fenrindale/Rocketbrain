'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const source = require('./jupyter-bridge-source.json');

function openJupyterKernel({ python, directory }) {
  if (typeof python !== 'string' || !path.isAbsolute(python) || /^[\\/]{2}/.test(python)) {
    throw Error('Configure the absolute path to a local Python interpreter with jupyter_client and ipykernel.');
  }
  const executable = fs.realpathSync(python);
  if (!fs.statSync(executable).isFile() || /^[\\/]{2}/.test(executable) || !fs.statSync(directory).isDirectory()) {
    throw Error('Choose an installed local Python executable and a local notebook directory.');
  }
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:PYTHONPATH|PYTHONHOME|JUPYTER_PATH|IPYTHONDIR|JUPYTER_CONFIG_DIR)$/i.test(key)) delete environment[key];
  }
  const worker = spawn(executable, ['-I', '-u', '-c', source, directory], {
    cwd: directory, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
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
  }

  function receive(line) {
    let data;
    try { data = JSON.parse(line.toString('utf8')); }
    catch { fail(Error('The Python notebook kernel returned invalid bridge data.')); void close(); return; }
    if (data?.ready === true && data.language === 'python' && typeof data.version === 'string') {
      clearTimeout(startup);
      readyResolve({ language: data.language, version: data.version });
      return;
    }
    if (!running || data?.id !== running.id) return;
    if (typeof data.error === 'string') running.reject(Error(data.error));
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

  async function execute(code, { cancellation } = {}) {
    if (typeof code !== 'string' || Buffer.byteLength(code) > 384 * 1024) throw Error('Run a notebook cell up to 384 KiB.');
    await ready;
    if (running) throw Error('Wait for this notebook cell to finish.');
    if (cancellation?.aborted || cancellation?.isCancellationRequested) throw Error('The notebook cell was cancelled.');
    const id = randomUUID();
    let listener;
    const interrupt = () => {
      try { request({ id: randomUUID(), op: 'cancel', for: id }); }
      catch (error) { running?.reject(error); }
    };
    const timer = setTimeout(() => {
      fail(Error('The notebook cell did not finish within 68 seconds.'));
      void close();
    }, 68000);
    try {
      const result = await new Promise((resolve, reject) => {
        running = { id, resolve, reject };
        request({ id, op: 'execute', code });
        if (cancellation?.onCancellationRequested) listener = cancellation.onCancellationRequested(interrupt);
        else cancellation?.addEventListener('abort', interrupt, { once: true });
        if (cancellation?.aborted || cancellation?.isCancellationRequested) interrupt();
      });
      if (result.kernelStopped) await close();
      return result;
    } finally {
      clearTimeout(timer);
      running = null;
      listener?.dispose();
      cancellation?.removeEventListener?.('abort', interrupt);
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

  return { ready, execute, close, get stopped() { return stopped; } };
}

module.exports = { openJupyterKernel };
