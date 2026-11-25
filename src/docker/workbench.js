'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const listFormat = '{{json .}}';
const contextName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const containerId = /^[a-f0-9]{64}$/;
const projectName = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const registryReference = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::[1-9]\d{0,4})?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;
const endpointPattern = /^(?:unix|npipe|ssh|tcp):\/\/[^\s\x00-\x1f\x7f]{1,240}$/;
const daemonId = /^[a-zA-Z0-9:-]{16,128}$/;
const lifecycle = new Map([['start', new Set(['created', 'exited'])],
  ['stop', new Set(['running'])], ['restart', new Set(['running'])]]);

function dockerEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']
      .includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

async function dockerCli(args, { signal, maxBuffer = 1024 * 1024, timeout = 18000 } = {}) {
  try {
    return await execute('docker', args, { signal, maxBuffer, timeout, env: dockerEnvironment(), windowsHide: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') throw Error('Install the Docker CLI and make it available on PATH.');
    if (cause.code === 'ABORT_ERR') throw Error('Docker operation cancelled.');
    if (cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('Docker output exceeded the workbench limit.');
    if (cause.killed) throw Error('Docker did not respond within the workbench limit.');
    throw Object.assign(Error('Docker rejected the command. Check the selected context and daemon permissions.'), { code: 'DOCKER_COMMAND_FAILED' });
  }
}

const display = (value, max = 200) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, max) : '';

function json(text) {
  try { return JSON.parse(text); }
  catch { throw Error('Docker did not return the requested JSON.'); }
}

function rows(text, array = false) {
  const raw = text.trim();
  if (!raw) return [];
  const result = array ? json(raw) : raw.split(/\r?\n/).map(json);
  if (!Array.isArray(result) || result.length > 500 || result.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw Error('Docker inventory must contain at most 500 objects.');
  }
  return result;
}

function containerRows(text) {
  return rows(text).map(item => {
    if (!containerId.test(item.ID || '')) throw Error('Docker did not return a full container ID.');
    return { id: item.ID, name: display(item.Names), image: display(item.Image), state: display(item.State), status: display(item.Status) };
  });
}

function createDockerWorkbench({ run = dockerCli, trusted = () => true } = {}) {
  let target, current, revision = 0, disposed = false;
  const reviews = new Map();

  function assertTrusted() {
    if (disposed || !trusted()) throw Error('Trust the workspace before connecting to Docker.');
  }

  async function cli(args, options) {
    assertTrusted();
    const result = await run(args, options);
    assertTrusted();
    return result;
  }

  async function contexts(options) {
    const result = await cli(['context', 'ls', '--format', listFormat], options);
    return rows(result.stdout).filter(row => contextName.test(row.Name || '')).map(row => ({ name: row.Name }));
  }

  async function inspectContext(name, options) {
    if (!contextName.test(name || '')) throw Error('Choose an existing Docker context.');
    const result = await cli(['context', 'inspect', '--format', listFormat, name], options);
    const data = json(result.stdout);
    const endpoint = data.Endpoints?.docker;
    if (data.Name !== name || !endpointPattern.test(endpoint?.Host || '')) throw Error('Docker returned an unsupported context endpoint.');
    const address = new URL(endpoint.Host);
    if (address.password || address.search || address.hash) throw Error('Docker context endpoints must omit credentials and query options.');
    return { name, endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify === true };
  }

  async function identity(name, options) {
    const { stdout } = await cli(['--context', name, 'info', '--format', '{{.ID}}'], options);
    const id = stdout.trim();
    if (!daemonId.test(id)) throw Error('Docker did not report the expected daemon identity.');
    return id;
  }

  async function selectContext({ name, endpoint, skipTlsVerify }, options) {
    const ticket = ++revision;
    const selected = await inspectContext(name, options);
    if (selected.endpoint !== endpoint || selected.skipTlsVerify !== skipTlsVerify) throw Error('The Docker context changed. Choose it again.');
    const daemon = await identity(name, options);
    if (ticket !== revision) throw Error('The Docker selection was superseded.');
    target = { ...selected, daemon };
    current = undefined;
    reviews.clear();
    return { ...target };
  }

  async function contextRun(expected, args, options) {
    if (!expected || target !== expected) throw Error('Choose a Docker context first.');
    const observed = await inspectContext(expected.name, options);
    if (target !== expected || observed.endpoint !== expected.endpoint || observed.skipTlsVerify !== expected.skipTlsVerify) {
      throw Error('The reviewed Docker context changed. Select it again.');
    }
    const daemon = await identity(expected.name, options);
    if (target !== expected || daemon !== expected.daemon) throw Error('The Docker daemon changed. Select the context again.');
    return cli(['--context', expected.name, ...args], options);
  }

  async function inventory(options) {
    const selected = target, ticket = ++revision;
    const containers = containerRows((await contextRun(selected, ['container', 'ls', '--all', '--no-trunc', '--format', listFormat], options)).stdout);
    const result = await contextRun(selected, ['image', 'ls', '--no-trunc', '--digests', '--format', listFormat], options);
    const images = rows(result.stdout).map(item => ({ id: display(item.ID), repository: display(item.Repository), tag: display(item.Tag),
      digest: display(item.Digest), size: display(item.Size) }));
    let compose, composeError;
    try {
      const result = await contextRun(selected, ['compose', 'ls', '--all', '--format', 'json'], options);
      compose = rows(result.stdout, true).filter(item => projectName.test(item.Name || ''))
        .map(item => ({ name: item.Name, status: display(item.Status) }));
    } catch (error) {
      if (error.code !== 'DOCKER_COMMAND_FAILED' || options?.signal?.aborted || selected !== target) throw error;
      composeError = 'Compose project listing unavailable for the selected context.';
    }
    if (selected !== target || ticket !== revision) throw Error('The Docker inventory was superseded.');
    current = { context: { ...selected }, containers, images, compose, composeError };
    return structuredClone(current);
  }

  function known(id) {
    const entry = current?.containers.find(item => item.id === id);
    if (!entry) throw Error('Refresh the Docker inventory and select the exact container.');
    return entry;
  }

  async function composeContainers(name, options) {
    if (!current?.compose?.some(project => project.name === name)) throw Error('Refresh and select a Compose project.');
    const result = await contextRun(target, ['container', 'ls', '--all', '--no-trunc', '--filter',
      'label=com.docker.compose.project=' + name, '--format', listFormat], options);
    return containerRows(result.stdout);
  }

  async function logs(id, options = {}) {
    known(id);
    return contextRun(target, ['container', 'logs', '--tail', '200', '--timestamps', id], { ...options, maxBuffer: 128 * 1024 });
  }

  async function state(targetContext, id, options) {
    const result = await contextRun(targetContext, ['container', 'inspect', '--format', '{{json .State.Status}}', id], options);
    return json(result.stdout);
  }

  async function review(id, action, options) {
    const entry = known(id), selected = target, allowed = lifecycle.get(action);
    if (!allowed?.has(entry.state) || await state(selected, id, options) !== entry.state) {
      throw Error('The container state does not allow this Docker action. Refresh its inventory.');
    }
    const token = randomUUID();
    reviews.clear();
    reviews.set(token, { id, action, selected, state: entry.state, expiresAt: Date.now() + 60000 });
    return { token, id, action, name: entry.name, context: { ...selected } };
  }

  async function apply(token, { approved, signal } = {}) {
    const request = reviews.get(token);
    if (!request || approved !== true || request.expiresAt <= Date.now()) throw Error('Approve a current Docker container action.');
    reviews.delete(token);
    const { id, action, selected } = request;
    if (await state(selected, id, { signal }) !== request.state) throw Error('The container state changed after review.');
    revision++;
    current = undefined;
    await contextRun(selected, ['container', action, id], { signal, timeout: 35000 });
  }

  async function manifest(reference, { approved, signal } = {}) {
    if (approved !== true || typeof reference !== 'string' || reference.length > 300 || !registryReference.test(reference)) {
      throw Error('Use an approved registry-qualified image reference with a tag or digest.');
    }
    return json((await contextRun(target, ['manifest', 'inspect', reference], { signal })).stdout);
  }

  return { contexts, inspectContext, selectContext, inventory, composeContainers, logs, review, apply, manifest,
    dispose() { disposed = true; target = current = undefined; reviews.clear(); } };
}

module.exports = { createDockerWorkbench, dockerEnvironment };
