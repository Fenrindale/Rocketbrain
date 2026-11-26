'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } = require('node:crypto');

const maxSessions = 8;
const maxTurns = 8;
const maxPeerBytes = 8 * 1024 * 1024;
const maxEnvelopeBytes = 12 * 1024 * 1024;
const magic = Buffer.from('RBACP1');
const sessionIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const stateNames = ['opencode.db', 'opencode.db-wal', 'opencode.db-journal'];
const hash = value => createHash('sha256').update(value).digest('hex');

function peerBinding(agent) {
  return hash(JSON.stringify([agent.adapter, agent.executable, agent.sha256, agent.args, agent.localModel.endpoint, agent.localModel.model]));
}

function dataScope(scope, id) { return Buffer.from(`rocketbrain-acp-checkpoint-v1\0${scope}\0${id}`); }

function encrypt(key, scope, id, data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(dataScope(scope, id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const output = Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext]);
  if (output.length > maxEnvelopeBytes) throw Error('The reviewed ACP checkpoint exceeds its 12 MiB limit.');
  return output;
}

function decrypt(key, scope, id, raw) {
  if (raw.length <= magic.length + 28 || raw.length > maxEnvelopeBytes || !raw.subarray(0, magic.length).equals(magic)) {
    throw Error('The saved ACP checkpoint is malformed.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(magic.length, magic.length + 12));
    decipher.setAAD(dataScope(scope, id));
    decipher.setAuthTag(raw.subarray(magic.length + 12, magic.length + 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(magic.length + 28)), decipher.final()]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch { throw Error('The saved ACP checkpoint cannot be authenticated for this workspace.'); }
}

async function lstatFound(file) {
  return fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function establishedDirectory(folder) {
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(folder) !== folder) throw Error('The private ACP storage directory moved or is a link.');
  return folder;
}

async function readBounded(file, maximum) {
  const stat = await lstatFound(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw Error('The private ACP checkpoint exceeded its file boundary.');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) {
      throw Error('The source of the private ACP checkpoint changed while opening.');
    }
    const value = Buffer.alloc(opened.size);
    for (let offset = 0; offset < value.length;) {
      const { bytesRead } = await handle.read(value, offset, value.length - offset, offset);
      if (!bytesRead) throw Error('The source of the private ACP checkpoint changed while reading.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Error('The source of the private ACP checkpoint changed while reading.');
    return value;
  } finally { await handle.close(); }
}

async function clearOwned(folder, parent, name) {
  const stat = await lstatFound(folder);
  if (!stat) return;
  const real = await establishedDirectory(folder);
  if (path.dirname(real) !== parent || path.basename(real) !== name) throw Error('The private ACP directory no longer belongs to this workspace session.');
  await fs.rm(real, { recursive: true, maxRetries: 6, retryDelay: 150 });
}

async function readState(folder) {
  const directory = await establishedDirectory(path.join(folder, 'opencode'));
  let size = 0;
  const files = [];
  for (const name of stateNames) {
    const data = await readBounded(path.join(directory, name), maxPeerBytes - size);
    if (!data?.length) continue;
    size += data.length;
    files.push({ name, bytes: data.toString('base64') });
  }
  if (!files.some(file => file.name === stateNames[0])) throw Error('The approved OpenCode peer did not leave a recoverable SQLite checkpoint.');
  return files;
}

async function restoreState(folder, files) {
  if (!Array.isArray(files) || !files.length || files.length > stateNames.length || new Set(files.map(file => file.name)).size !== files.length ||
      files.some(file => !stateNames.includes(file.name) || typeof file.bytes !== 'string') || !files.some(file => file.name === stateNames[0])) {
    throw Error('The approved OpenCode checkpoint has unsupported state files.');
  }
  const dest = path.join(folder, 'opencode');
  await fs.mkdir(dest, { mode: 0o700 });
  let size = 0;
  for (const { name, bytes } of files) {
    const data = Buffer.from(bytes, 'base64');
    if (!data.length || (size += data.length) > maxPeerBytes || data.toString('base64') !== bytes) {
      throw Error('The saved OpenCode data exceeds the checkpoint boundary.');
    }
    await fs.writeFile(path.join(dest, name), data, { flag: 'wx', mode: 0o600 });
  }
}

function metadata(data) {
  const { id, label, turns, createdAt, updatedAt } = data;
  return { id, label, turns, createdAt, updatedAt };
}

function createAcpCheckpointStore({ location, scope, secrets }) {
  if (!path.isAbsolute(location) || typeof scope !== 'string' || !scope || !secrets) throw Error('Use the private storage of an open local workspace.');
  const keyName = 'rocketbrain.acp.checkpoints.v1.' + hash(scope);

  async function root() {
    await fs.mkdir(location, { mode: 0o700, recursive: true });
    const parent = await fs.realpath(location);
    const folder = path.join(parent, 'acp-checkpoints-v1');
    await fs.mkdir(folder, { mode: 0o700, recursive: true });
    return establishedDirectory(folder);
  }

  async function sessions(base) {
    return (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && sessionIdPattern.test(entry.name)).map(entry => entry.name);
  }

  async function key(base, create = false) {
    let secret = await secrets.get(keyName);
    if (secret === undefined && create && !(await sessions(base)).length) {
      secret = randomBytes(32).toString('base64url');
      await secrets.store(keyName, secret);
    }
    if (secret === undefined && !create && !(await sessions(base)).length) return undefined;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw Error('The private key for saved ACP sessions is unavailable.');
    return Buffer.from(secret, 'base64url');
  }

  async function leased(action) {
    const base = await root();
    const name = path.join(base, 'active.lock');
    let lock;
    try { lock = await fs.open(name, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Error('The private ACP workspace storage is currently in use.'); throw error; }
    async function mark(phase, peerPid) {
      const bytes = Buffer.from(JSON.stringify({ pid: process.pid, phase, ...(peerPid && { peerPid }) }));
      await lock.truncate(0);
      await lock.write(bytes, 0, bytes.length, 0);
      await lock.sync();
    }
    try {
      await mark('idle');
      return await action(base, mark);
    }
    finally { await lock.close(); await fs.unlink(name); }
  }

  async function load(base, secret, id) {
    if (typeof id !== 'string' || !sessionIdPattern.test(id)) throw Error('Choose a saved ACP session from this workspace.');
    const folder = await establishedDirectory(path.join(base, id));
    const bytes = await readBounded(path.join(folder, 'session.v1.enc'), maxEnvelopeBytes);
    if (!bytes) throw Error('The reviewed ACP checkpoint is unavailable.');
    const data = decrypt(secret, scope, id, bytes);
    if (data?.id !== id || typeof data.label !== 'string' || typeof data.binding !== 'string' || typeof data.sessionId !== 'string' ||
        !Number.isInteger(data.turns) || data.turns < 1 || data.turns > maxTurns) throw Error('The saved ACP session metadata is invalid.');
    return { folder, data };
  }

  async function turn(folder, secret, data, input, agent, execute, signal, mark) {
    const nextFile = path.join(folder, randomUUID() + '.state');
    const work = path.join(folder, 'peer');
    try {
      await clearOwned(work, folder, 'peer');
      await fs.mkdir(work, { mode: 0o700 });
      if (data.files) await restoreState(work, data.files);
      await mark('starting');
      const result = await execute(agent, { folder: work, text: input, sessionId: data.sessionId, signal,
        onStarted: pid => mark('peer', pid) });
      await mark('idle');
      signal?.throwIfAborted();
      if (result?.stopReason !== 'end_turn' || !result.output?.trim() || !result.recovery?.sessionId ||
          data.sessionId && result.recovery.sessionId !== data.sessionId) throw Error('The reviewed ACP turn did not produce a complete recoverable response.');
      const updated = { ...data, turns: data.turns + 1, sessionId: result.recovery.sessionId, updatedAt: new Date().toISOString(), files: await readState(work) };
      const envelope = encrypt(secret, scope, data.id, updated);
      const output = await fs.open(nextFile, 'wx', 0o600);
      try { await output.writeFile(envelope); await output.sync(); }
      finally { await output.close(); }
      await clearOwned(work, folder, 'peer');
      await fs.rename(nextFile, path.join(folder, 'session.v1.enc'));
      return { ...metadata(updated), output: result.output, replay: result.recovery.replay, resumed: result.recovery.resumed };
    } finally {
      await fs.unlink(nextFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await clearOwned(work, folder, 'peer');
    }
  }

  return {
    async list() {
      const base = await root(), secret = await key(base);
      if (!secret) return [];
      const available = [];
      for (const id of (await sessions(base)).slice(0, maxSessions)) {
        if (await lstatFound(path.join(base, id, 'session.v1.enc'))) available.push(metadata((await load(base, secret, id)).data));
      }
      return available;
    },
    create({ agent, input, label, signal }, execute) {
      return leased(async (base, mark) => {
        if ((await sessions(base)).length >= maxSessions) throw Error('Remove a saved ACP session before creating another.');
        const secret = await key(base, true), id = randomUUID(), folder = path.join(base, id);
        await fs.mkdir(folder, { mode: 0o700 });
        try { return await turn(folder, secret, { id, label, turns: 0, binding: peerBinding(agent), createdAt: new Date().toISOString() }, input, agent, execute, signal, mark); }
        catch (error) { await clearOwned(folder, base, id); throw error; }
      });
    },
    continue(id, { agent, input, signal, expected }, execute) {
      return leased(async (base, mark) => {
        const secret = await key(base), { folder, data } = await load(base, secret, id);
        if (data.binding !== peerBinding(agent)) throw Error('The saved ACP executable or loopback model changed. Reopen with the reviewed peer and model.');
        if (expected && (data.turns !== expected.turns || data.updatedAt !== expected.updatedAt)) throw Error('The saved conversation changed after review. Review the latest checkpoint.');
        if (data.turns >= maxTurns) throw Error('The saved ACP session reached eight completed turns. Start a new review.');
        return turn(folder, secret, data, input, agent, execute, signal, mark);
      });
    },
    remove(id) {
      return leased(async base => {
        const secret = await key(base), { folder } = await load(base, secret, id);
        await clearOwned(folder, base, id);
      });
    },
    async recoverAbandonedLease() {
      const base = await root();
      const recovery = path.join(base, 'recovery.lock');
      const handle = await fs.open(recovery, 'wx', 0o600);
      try {
        const active = path.join(base, 'active.lock');
        const raw = await readBounded(active, 1024);
        if (!raw) return { recovered: false };
        const { pid, phase, peerPid } = JSON.parse(raw.toString('utf8'));
        if (!['idle', 'peer'].includes(phase)) throw Error('The saved ACP lease owner could not be verified.');
        const owners = phase === 'peer' ? [pid, peerPid] : [pid];
        for (const owner of owners) {
          if (!Number.isSafeInteger(owner) || owner < 1) throw Error('The saved ACP lease owner could not be verified.');
          try { process.kill(owner, 0); }
          catch (error) {
            if (error.code === 'ESRCH') continue;
            throw Error('The saved ACP lease owner could not be verified.');
          }
          throw Error('The private ACP workspace storage is still in use by its recorded owner.');
        }
        for (const id of await sessions(base)) {
          const folder = await establishedDirectory(path.join(base, id));
          if (await lstatFound(path.join(folder, 'session.v1.enc'))) await clearOwned(path.join(folder, 'peer'), folder, 'peer');
          else await clearOwned(folder, base, id);
        }
        await fs.unlink(active);
        return { recovered: true };
      } finally { await handle.close(); await fs.unlink(recovery); }
    }
  };
}

module.exports = { createAcpCheckpointStore };
