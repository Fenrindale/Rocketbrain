'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function startLocalModel({ parallel = 1 } = {}) {
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 3) throw Error('Use one to three fixture inference slots.');
  const executable = process.env.ROCKETBRAIN_LOCAL_MODEL_BIN;
  const weights = process.env.ROCKETBRAIN_LOCAL_MODEL_GGUF;
  if (!executable || !weights || !path.isAbsolute(executable) || !path.isAbsolute(weights) ||
      !/^llama-server(?:\.exe)?$/i.test(path.basename(executable)) || !/\.gguf$/i.test(weights) ||
      !(await fs.stat(executable)).isFile() || !(await fs.stat(weights)).isFile()) {
    throw Error('Provide the absolute, independently verified llama-server executable and GGUF paths.');
  }
  const model = 'rocketbrain-qwen-fixture-' + randomBytes(5).toString('hex');
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(executable, ['--model', weights, '--alias', model, '--host', '127.0.0.1', '--port', String(port),
    '--ctx-size', '4096', '--threads', '4', '--parallel', String(parallel), '--gpu-layers', '0', '--no-webui', '--no-webui-mcp-proxy', '--log-disable'],
  { cwd: path.dirname(executable), windowsHide: true, shell: false, stdio: 'ignore' });
  let stopped = false;
  const exited = new Promise(resolve => {
    child.once('error', () => { stopped = true; resolve(); });
    child.once('close', () => { stopped = true; resolve(); });
  });
  async function close() {
    if (!stopped) child.kill();
    await Promise.race([exited, delay(4500, undefined, { ref: false })]);
    if (!stopped) throw Error('The owned local model process did not stop.');
  }
  try {
    const until = Date.now() + 30000;
    while (!stopped && Date.now() < until) {
      const response = await fetch(origin + '/v1/models', { redirect: 'error', signal: AbortSignal.timeout(750) }).catch(() => null);
      if (response?.ok) {
        const inventory = await response.json().catch(() => null);
        if (inventory?.data?.some(row => row.id === model)) return { model, endpoint: origin + '/v1/chat/completions', close };
      } else await response?.body?.cancel().catch(() => {});
      await delay(250);
    }
    throw Error('The owned loopback llama.cpp model did not become ready.');
  } catch (error) { await close(); throw error; }
}

module.exports = { startLocalModel };
