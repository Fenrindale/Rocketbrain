'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { vueWorker } = require('./vue-worker');

const maxFile = 256 * 1024;
const maxOutput = 1024 * 1024;
const maxDiagnostics = 250;
const tools = ['@vue/compiler-sfc', 'typescript', 'vue-tsc', 'vite'];

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

async function ordinary(file) {
  const actual = await fs.realpath(file).catch(() => null);
  return actual && (await fs.stat(actual).catch(() => null))?.isFile() ? actual : null;
}

async function smallJson(file) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(maxFile + 1);
    const { bytesRead } = await handle.read(bytes);
    if (bytesRead > maxFile) throw Error('Vue project configuration exceeds 256 KiB.');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
  } finally { await handle.close(); }
}

async function inspectVueProject(workspace, file) {
  const boundary = await fs.realpath(workspace);
  const input = await fs.realpath(file);
  if (!inside(boundary, input)) throw Error('Choose a Vue file inside its VS Code workspace.');
  let root = (await fs.stat(input)).isDirectory() ? input : path.dirname(input);
  while (inside(boundary, root)) {
    const manifest = await ordinary(path.join(root, 'package.json'));
    if (manifest && inside(root, manifest)) {
      const packageJson = await smallJson(manifest);
      if (typeof (packageJson.dependencies?.vue ?? packageJson.devDependencies?.vue) === 'string') {
        const installed = {};
        for (const name of tools) {
          const toolManifest = await ordinary(path.join(root, 'node_modules', name, 'package.json'));
          if (!toolManifest || !inside(root, toolManifest)) continue;
          const item = await smallJson(toolManifest);
          if (item.name === name && typeof item.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(item.version)) {
            installed[name] = { version: item.version, manifest: toolManifest };
          }
        }
        let config;
        for (const name of ['tsconfig.app.json', 'tsconfig.json']) {
          const candidate = await ordinary(path.join(root, name));
          if (candidate && inside(root, candidate)) { config = candidate; break; }
        }
        return { root, manifest, config, installed };
      }
    }
    if (path.relative(root, boundary) === '') break;
    root = path.dirname(root);
  }
  throw Error('No local Vue project with a package.json Vue dependency was found.');
}

async function selectNode(explicit, setting='rocketbrain.vue.nodePath') {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const paths = explicit ? [explicit] : (process.env.PATH ?? '').split(path.delimiter)
    .filter(path.isAbsolute).map(folder => path.join(folder, name));
  for (const file of paths) {
    if (path.isAbsolute(file) && path.basename(file).toLowerCase() === name) {
      const executable = await ordinary(file);
      if (executable) return executable;
    }
  }
  throw Error('Set '+setting+' to the absolute path of a standalone Node.js executable.');
}

function childEnvironment() {
  const names = new Set(['path', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'userprofile', 'home', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key.toLowerCase())));
}

function launch(node, args, cwd, stdio) {
  return spawn(node, args, { cwd, stdio, env: childEnvironment(), windowsHide: true, shell: false });
}

async function runCompiler(node, cli, project, scratch, signal) {
  if (signal?.aborted) throw Error('Vue project check cancelled.');
  const child = launch(node, [cli, '--project', project.config, '--noEmit', '--pretty', 'false',
    '--incremental', '--tsBuildInfoFile', scratch], project.root, ['ignore', 'pipe', 'pipe']);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, finished = false;
    const timer = setTimeout(() => stop('Vue project checking timed out.'), 45000);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    }
    let stopped;
    function stop(message) {
      stopped = Error(message);
      child.kill();
    }
    const abort = () => stop('Vue project check cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > maxOutput) stop('Vue compiler output exceeded 1 MiB.');
      else chunks.push(chunk);
    });
    child.once('error', () => finish(Error('Could not start the Vue project compiler.')));
    child.once('close', code => finish(stopped, { code, output: Buffer.concat(chunks).toString('utf8') }));
    if (signal?.aborted) abort();
  });
}

async function parseVueDiagnostics(project, { code, output }) {
  const diagnostics = [], projectDiagnostics = [];
  let seen = 0, skipped = 0, current;
  for (const line of output.split(/\r?\n/)) {
    const match = /^(?:(.*)\((\d+),(\d+)\): )?(error|warning|message) TS(\d+): (.+)$/.exec(line);
    if (match) {
      current = undefined;
      if (++seen > maxDiagnostics) { skipped++; continue; }
      const [, name, lineNo, column, severity, number, message] = match;
      const item = { severity, code: 'TS' + number, message: message.slice(0, 2048) };
      if (name) {
        const file = path.resolve(project.root, name);
        const existing = inside(project.root, file) ? await ordinary(file) : null;
        if (!existing || !inside(project.root, existing)) { skipped++; continue; }
        item.file = existing;
        item.line = Number(lineNo) - 1;
        item.column = Number(column) - 1;
        if (!Number.isSafeInteger(item.line) || !Number.isSafeInteger(item.column) || item.line < 0 || item.column < 0) {
          skipped++;
          continue;
        }
        diagnostics.push(item);
      } else projectDiagnostics.push(item);
      current = item;
    } else if (current && /^\s+\S/.test(line)) current.message = (current.message + '\n' + line.trim()).slice(0, 2048);
    else if (line.trim()) current = undefined;
  }
  if (code !== 0 && diagnostics.length + projectDiagnostics.length + skipped === 0) {
    throw Error('vue-tsc exited without recognised diagnostics. Check the project tool versions and TypeScript configuration.');
  }
  return { diagnostics, projectDiagnostics, skipped, clean: code === 0 && diagnostics.length + projectDiagnostics.length + skipped === 0 };
}

async function checkVueProject(project, node, { signal } = {}) {
  if (!project.config || !project.installed.typescript || !project.installed['vue-tsc']) {
    throw Error('Install project-local TypeScript and vue-tsc, and include a tsconfig.app.json or tsconfig.json.');
  }
  const cliRoot = path.dirname(project.installed['vue-tsc'].manifest);
  const cli = await ordinary(path.join(cliRoot, 'bin', 'vue-tsc.js'));
  if (!cli || !inside(cliRoot, cli)) throw Error('The project-local Vue compiler CLI is unavailable.');
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-vue-check-'));
  const scratch = path.join(temp, 'checked.tsbuildinfo');
  try { return await parseVueDiagnostics(project, await runCompiler(node, cli, project, scratch, signal)); }
  finally {
    await fs.unlink(scratch).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(temp);
  }
}

function workerCode(worker) {
  return `process.once('message', input => {
    (${worker.toString()})(input).then(value => {
      process.send({ value }, () => { if (input.action !== 'serve' && process.connected) process.disconnect(); });
    }, () => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  });`;
}

async function runWorker(project, node, input, signal, {worker=vueWorker,label='Vue',timeoutMs}={}) {
  if (signal?.aborted) throw Error(label+' operation cancelled.');
  const child = launch(node, ['-e', workerCode(worker)], project.root, ['ignore', 'ignore', 'ignore', 'ipc']);
  const closed = new Promise(resolve => child.once('close', resolve));
  const serve = input.action === 'serve';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error(label+' tooling did not respond in time.')), timeoutMs ?? (serve ? 25000 : 3500));
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.removeListener('message', respond);
      if (error) { child.kill(); reject(error); }
      else resolve(result);
    }
    const abort = () => finish(Error(label+' operation cancelled.'));
    const respond = message => finish(null, message?.value);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(Error('Could not launch the project-local '+label+' tools.')));
    child.once('close', () => finish(Error('The project-local '+label+' tools exited before responding.')));
    child.once('message', respond);
    child.send({ ...input, root: project.root }, error => { if (error) finish(Error('Could not initialize the '+label+' tools.')); });
    if (signal?.aborted) abort();
  });
  return { ready, closed, stop: async () => {
    if (child.connected) child.send({ action: 'stop' }, () => {});
    const stopped = await Promise.race([closed.then(() => true), delay(3000, false, { ref: false })]);
    if (!stopped) { child.kill(); await closed; }
  } };
}

async function vueDefinition(project, node, { file, source, offset, signal }) {
  const sourceFile = await ordinary(file);
  if (!project.installed.typescript || !project.installed['@vue/compiler-sfc'] || Buffer.byteLength(source) > maxFile ||
      !Number.isInteger(offset) || offset < 0 || offset >= source.length || !sourceFile || !inside(project.root, sourceFile)) return null;
  const { ready } = await runWorker(project, node, { action: 'definition', file: sourceFile, source, offset }, signal);
  if (!ready || typeof ready.file !== 'string' || !inside(project.root, ready.file) ||
      ![ready.origin, ready.target].every(range => Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) &&
        range.start >= 0 && range.start <= range.end && range.end <= source.length)) return null;
  return ready;
}

async function startVueServer(project, node, { signal } = {}) {
  if (!project.installed.vite) throw Error('Install Vite in this Vue project before launching it.');
  const worker = await runWorker(project, node, { action: 'serve' }, signal);
  const { ready, stop, closed } = worker;
  if (ready?.ready !== true || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 ||
      typeof ready.base !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(ready.base)) {
    await stop();
    throw Error('Vite did not return a supported local URL.');
  }
  return { url: 'http://127.0.0.1:' + ready.port + ready.base, stop, closed };
}

module.exports = { inspectVueProject, selectNode, checkVueProject, parseVueDiagnostics, vueDefinition, startVueServer, inside, runWorker };
