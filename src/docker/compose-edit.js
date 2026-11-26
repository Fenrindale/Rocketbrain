'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isMap, isScalar, parseDocument, visit } = require('yaml');
const { dockerEnvironment } = require('./workbench');

const execute = promisify(execFile);
const fileLimit = 256 * 1024;
const stagePrefix = 'rb-compose-review-';
const project = 'rocketbrain-compose-review';
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizeText = text => text.replace(/\r\n/g, '\n');
const equalPath = (one, two) => !path.relative(one, two);

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function sourceIdentity(info) {
  return [info.dev, info.ino, info.nlink, info.size, info.mode, info.mtimeNs, info.ctimeNs].map(String).join(':');
}

async function observe(file) {
  const actual = await fs.realpath(file);
  const before = await fs.lstat(file, { bigint: true });
  if (!equalPath(file, actual) || !before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(fileLimit)) {
    throw Error('Use saved physical Compose YAML files up to 256 KiB.');
  }
  const expected = sourceIdentity(before);
  const handle = await fs.open(file, 'r');
  let raw;
  try {
    if (sourceIdentity(await handle.stat({ bigint: true })) !== expected) throw Error('A Compose file changed while reading it.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('A Compose file changed while reading it.');
      offset += bytesRead;
    }
    if (sourceIdentity(await handle.stat({ bigint: true })) !== expected) throw Error('A Compose file changed while reading it.');
    raw = bytes;
  } finally { await handle.close(); }
  if (sourceIdentity(await fs.lstat(file, { bigint: true })) !== expected || !equalPath(file, await fs.realpath(file))) {
    throw Error('A Compose file changed while reading it.');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw Error('Use UTF-8 Compose files.'); }
  if (text.includes('\0')) throw Error('Use UTF-8 Compose files.');
  return { file, raw, text, sha256: hash(raw), identity: expected };
}

function inspectYaml(text) {
  const doc = parseDocument(text, { logLevel: 'silent' });
  if (doc.errors.length || !isMap(doc.contents)) throw Error('Use a valid Compose YAML mapping in each selected file.');
  let nodes = 0;
  visit(doc, {
    Node(_key, node, parents) {
      if (++nodes > 12000 || parents.length > 50) throw Error('A Compose file exceeds the supported YAML structure limit.');
      if (node.tag && !['!reset', '!override'].includes(node.tag)) throw Error('Use standard Compose YAML and Compose override tags.');
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw Error('Use literal text keys in Compose files.');
      if (['include', 'extends', 'env_file', 'label_file'].includes(pair.key.value)) {
        throw Error('Review explicit Compose files without include, extends, env_file or label_file indirection.');
      }
    }
  });
  try { doc.toJS({ maxAliasCount: 24 }); }
  catch { throw Error('A Compose file exceeds the alias limit.'); }
}

function draftBytes(text, remember) {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > fileLimit) {
    throw Error('Use an edited UTF-8 Compose document up to 256 KiB.');
  }
  const crlf = remember.text.includes('\r\n') && !remember.text.replace(/\r\n/g, '').includes('\n');
  const portable = normalizeText(text);
  const adjusted = crlf ? portable.replace(/\n/g, '\r\n') : portable;
  const hasBom = remember.raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const proposed = Buffer.from((hasBom ? '\uFEFF' : '') + adjusted, 'utf8');
  if (proposed.length > fileLimit) throw Error('The Compose draft exceeds 256 KiB.');
  return { raw: proposed, text: adjusted };
}

async function checkedPaths(files, override, roots) {
  if (!Array.isArray(files) || files.length < 2 || files.length > 8 ||
      files.some(file => typeof file !== 'string' || file.length > 2048 || !path.isAbsolute(file) ||
        !/\.ya?ml$/iu.test(file) || /[\x00-\x1f\x7f]/u.test(file))) {
    throw Error('Select one base Compose file followed by one to seven override YAML files.');
  }
  const resolved = files.map(file => path.resolve(file));
  if (resolved.some((file, index) => resolved.slice(0, index).some(previous => equalPath(previous, file)))) {
    throw Error('Each reviewed Compose file must appear once in the stack.');
  }
  if (!Number.isInteger(override) || override <= 0 || override >= resolved.length) {
    throw Error('Choose one override to edit and keep the base file as the first input.');
  }
  const physicalRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => undefined)));
  if (!physicalRoots.some(root => root && resolved.every(file => inside(root, file)))) {
    throw Error('Keep the Compose stack inside one opened local workspace folder.');
  }
  return resolved;
}

function composeEnvironment() {
  const env = dockerEnvironment();
  for (const key of Object.keys(env)) {
    if (/^COMPOSE_/iu.test(key)) delete env[key];
  }
  return env;
}

async function resolveDocker(args, { cwd, signal }) {
  try {
    const { stdout } = await execute('docker', args, { cwd, signal, env: composeEnvironment(),
      timeout: 18000, maxBuffer: 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    if (signal?.aborted) throw Error('The Compose model review was cancelled.');
    if (error.code === 'ENOENT') throw Error('Install the Docker CLI and Compose plugin to review this stack.');
    throw Error('Docker Compose could not resolve the selected stack. Check the YAML and local Compose plugin.');
  }
}

const mapForms = new Set(['labels', 'annotations', 'environment', 'args']);

function stable(value, field) {
  if (Array.isArray(value)) {
    if (mapForms.has(field) && value.every(item => typeof item === 'string')) {
      const entries = value.map(item => {
        const separator = item.indexOf('=');
        return separator < 0 ? [item, null] : [item.slice(0, separator), item.slice(separator + 1)];
      });
      if (entries.every(([key]) => key.length) && new Set(entries.map(([key]) => key)).size === entries.length) {
        return stable(Object.fromEntries(entries));
      }
    }
    return value.map(item => stable(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key], key)]));
  }
  return value;
}

async function resolveModel(entries, run, signal) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, stagePrefix));
  const owner = await fs.lstat(directory, { bigint: true });
  try {
    const args = ['compose', '--project-name', project, '--profile', '*', '--env-file', 'compose-empty.env'];
    await fs.writeFile(path.join(directory, 'compose-empty.env'), '', { flag: 'wx', mode: 0o600 });
    for (const [index, input] of entries.entries()) {
      const name = 'compose-' + index + '.yaml';
      await fs.writeFile(path.join(directory, name), input.raw, { flag: 'wx', mode: 0o600 });
      args.push('-f', name);
    }
    args.push('config', '--format', 'json', '--no-interpolate', '--no-env-resolution', '--no-path-resolution');
    const output = await run(args, { cwd: directory, signal });
    let model;
    try { model = JSON.parse(output); } catch { throw Error('Docker Compose did not return a valid model.'); }
    if (model?.name !== project || !model.services || typeof model.services !== 'object' || Array.isArray(model.services)) {
      throw Error('Docker Compose did not return the reviewed named service model.');
    }
    return stable(model);
  } finally {
    const real = await fs.realpath(directory);
    const stat = await fs.lstat(real, { bigint: true });
    if (!equalPath(directory, real) || !equalPath(path.dirname(real), parent) || !path.basename(real).startsWith(stagePrefix) ||
        owner.dev !== stat.dev || owner.ino !== stat.ino) throw Error('The temporary Compose stage changed ownership.');
    await fs.rm(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const hidden = new Set(['environment', 'args', 'secrets', 'credential_spec']);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, hidden.has(key) ? '[redacted]' : redact(child)]));
  }
  return value;
}

function differences(before, after) {
  const paths = [];
  function expand(old, next, prefix) {
    if (JSON.stringify(old) === JSON.stringify(next) || paths.length >= 100) return;
    if (old && next && typeof old === 'object' && typeof next === 'object' &&
        !Array.isArray(old) && !Array.isArray(next) && !hidden.has(prefix.at(-1))) {
      for (const key of [...new Set([...Object.keys(old), ...Object.keys(next)])].sort()) {
        expand(Object.hasOwn(old, key) ? old[key] : undefined, Object.hasOwn(next, key) ? next[key] : undefined, [...prefix, key]);
      }
    } else paths.push(prefix);
  }
  expand(before, after, []);
  return paths;
}

function createComposeEdit({ trusted = () => true, workspaceRoots = () => [], run = resolveDocker } = {}) {
  const drafts = new Map(), reviews = new Map();
  let closed = false;
  function trust(signal) {
    if (closed || !trusted()) throw Error('Use a trusted local workspace to edit a Compose stack.');
    if (signal?.aborted) throw Error('The Compose model review was cancelled.');
  }
  async function unchanged(draft, signal) {
    const files = await checkedPaths(draft.files, draft.override, workspaceRoots());
    for (const [index, file] of files.entries()) {
      trust(signal);
      const current = await observe(file);
      const expected = draft.initial[index];
      if (current.identity !== expected.identity || current.sha256 !== expected.sha256) {
        throw Error('A reviewed Compose source changed. Open a new draft from the saved files.');
      }
    }
    trust(signal);
  }
  return {
    async prepare(files, override, { signal } = {}) {
      trust(signal);
      const paths = await checkedPaths(files, override, workspaceRoots());
      const initial = [];
      for (const file of paths) {
        trust(signal);
        const snapshot = await observe(file);
        inspectYaml(snapshot.text);
        initial.push(snapshot);
      }
      trust(signal);
      drafts.clear();
      reviews.clear();
      const id = randomUUID();
      drafts.set(id, { initial, files: paths, override, expires: Date.now() + 900000 });
      return { id, files: [...paths], selected: paths[override], text: initial[override].text };
    },
    async review(id, text, { signal } = {}) {
      trust(signal);
      const draft = drafts.get(id);
      if (!draft || draft.expires <= Date.now()) throw Error('Open a current Compose override draft.');
      await unchanged(draft, signal);
      const original = draft.initial[draft.override];
      const candidate = draftBytes(text, original);
      if (candidate.raw.equals(original.raw)) throw Error('Edit the selected override before reviewing the model.');
      inspectYaml(candidate.text);
      const before = await resolveModel(draft.initial, run, signal);
      const proposed = draft.initial.slice();
      proposed[draft.override] = candidate;
      const after = await resolveModel(proposed, run, signal);
      await unchanged(draft, signal);
      if (drafts.get(id) !== draft) throw Error('Open a current Compose override draft.');
      const token = randomUUID();
      reviews.clear();
      reviews.set(token, { id, draft, candidate, expires: Date.now() + 90000 });
      return { token, selected: original.file, files: [...draft.files], changes: differences(before, after),
        before: redact(before), after: redact(after) };
    },
    async apply(token, { approved, signal, edit } = {}) {
      trust(signal);
      const review = reviews.get(token);
      if (approved !== true || !review || review.expires <= Date.now() || typeof edit !== 'function') {
        throw Error('Approve a current Compose override review before applying it.');
      }
      reviews.delete(token);
      if (drafts.get(review.id) !== review.draft) throw Error('Open a current Compose override draft.');
      await unchanged(review.draft, signal);
      if (drafts.get(review.id) !== review.draft) throw Error('Open a current Compose override draft.');
      const { file, text: beforeText } = review.draft.initial[review.draft.override];
      if (!await edit({ file, beforeText, text: review.candidate.text })) {
        throw Error('The Compose editor changed before the reviewed edit could be applied.');
      }
      drafts.delete(review.id);
      return { state: 'applied-to-editor', selected: file };
    },
    discard(id) {
      drafts.delete(id);
      for (const [token, review] of reviews) if (review.id === id) reviews.delete(token);
    },
    dispose() { closed = true; drafts.clear(); reviews.clear(); }
  };
}

module.exports = { createComposeEdit, inspectYaml, normalizeText };
