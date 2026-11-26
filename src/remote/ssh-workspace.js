'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { remoteCommand } = require('./ssh-files-worker');
const { createPinnedSshPeer, createSshProcesses } = require('./ssh-processes');

const maxFileBytes = 2 * 1024 * 1024;
const maxFrameBytes = 4 * 1024 * 1024;
const maximumWatchPaths = 64;
const uriScheme = 'rocketbrain-ssh';
const digest = data => createHash('sha256').update(data).digest('hex');
const sourceErrors = {
  'invalid-path': 'The remote path contains an unsupported segment.',
  'changed-root': 'The remote workspace root moved. Reopen the connection.',
  'no-root': 'Choose an existing absolute remote directory.',
  'changed-file': 'The remote file changed after review. Review the latest version.',
  'too-many-files': 'The remote directory exceeds the 2,000-entry limit.',
  'too-large': 'The remote file exceeds the 2 MiB limit.',
  permission: 'The remote account lacks permission for this file.',
  indirection: 'The remote path contains file system indirection.',
  unsupported: 'The remote object is outside the supported regular files and directories.',
  missing: 'The remote file no longer exists.'
};

function partsFor(value) {
  if (typeof value !== 'string') throw Error('The remote path contains an unsupported segment.');
  const parts = value === '/' ? [] : value.split('/').slice(1);
  if (!value.startsWith('/') || parts.length > 32 || parts.some(part =>
    !part || part === '.' || part === '..' || part.length > 255 || /[\\:\x00-\x1f]/.test(part))) {
    throw Error('The remote path contains an unsupported segment.');
  }
  return parts;
}

function profileFor(value) {
  if (!value || typeof value !== 'object' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(value.id || '') ||
      typeof value.root !== 'string' || value.root.length > 1024 ||
      !/^(?:\/|[A-Za-z]:[\\/])/.test(value.root) || /[\x00-\x1f]/.test(value.root)) {
    throw Error('Configure an SSH workspace ID and the absolute directory on the remote host.');
  }
  const { id, host, port, user, root, privateKeyPath, knownHostsPath } = value;
  return { id, host, port, user, root, privateKeyPath, knownHostsPath, python: value.python ?? 'python3' };
}

async function connectWorkspace(raw) {
  const profile = profileFor(raw);
  const command = remoteCommand(profile.python);
  const peer = await createPinnedSshPeer(profile);
  const ssh = peer.target;
  let resolvedRoot;
  let closed = false;
  const active = new Set();

  async function request(operation, parts = [], fields = {}) {
    if (closed) throw Error('Reopen the SSH workspace connection.');
    await peer.verify();
    if (closed) throw Error('The SSH workspace connection closed.');
    const body = JSON.stringify({ root: profile.root, resolvedRoot, operation, parts, ...fields }) + '\n';
    if (Buffer.byteLength(body) >= maxFrameBytes) throw Error('The SSH file request exceeds its size limit.');
    const args = [...ssh.options, ...ssh.destination, command];
    return new Promise((resolve, reject) => {
      const child = spawn(ssh.executable, args, { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      active.add(child);
      const stdout = [];
      let size = 0;
      let stderr = '';
      let problem;
      const stop = message => {
        problem ||= message;
        child.kill();
      };
      const timer = setTimeout(() => stop('The SSH file operation timed out.'), 18000);
      child.stdin.on('error', () => {});
      child.once('error', () => { problem ||= 'The local OpenSSH executable could not start.'; });
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size >= maxFrameBytes) stop('The SSH file response exceeded its limit.');
        else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
      });
      child.once('close', code => {
        clearTimeout(timer);
        active.delete(child);
        try {
          if (closed) throw Error('The SSH workspace connection closed.');
          if (problem) throw Error(problem);
          if (code !== 0) {
            if (/host key verification failed|REMOTE HOST IDENTIFICATION/i.test(stderr)) throw Error('Verify the SSH host key in the configured known_hosts file.');
            if (/permission denied|authentication/i.test(stderr)) throw Error('SSH key or agent authentication failed.');
            throw Error('SSH could not complete the file operation. Check that the selected remote Python launcher works.');
          }
          const response = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (response.error) {
            const error = Error(sourceErrors[response.error] || 'The remote file operation failed.');
            error.remoteCode = response.error;
            throw error;
          }
          if (!Object.hasOwn(response, 'value')) throw Error('The remote file response was incomplete.');
          resolve(response.value);
        } catch (error) { reject(error); }
      });
      child.stdin.end(body);
    });
  }

  try {
    const opened = await request('connect');
    if (typeof opened?.root !== 'string' || !opened.root) throw Error('The remote file root could not be resolved.');
    resolvedRoot = opened.root;
  } catch (error) {
    await peer.close();
    throw error;
  }
  const processes = createSshProcesses(profile, resolvedRoot, ssh, () => request('stat'));
  return Object.freeze({
    id: profile.id, host: profile.host, root: resolvedRoot,
    inspectProcess: (kind, requested) => processes.inspect(kind, requested),
    openProcess: (kind, approval) => processes.open(kind, approval),
    stat(value) { return request('stat', partsFor(value)); },
    list(value) { return request('list', partsFor(value)); },
    async observe(values) {
      if (!Array.isArray(values) || !values.length || values.length > maximumWatchPaths) {
        throw Error('Watch up to 64 exact SSH paths together.');
      }
      const result = await request('observe', [], { targets: values.map(partsFor) });
      if (!Array.isArray(result) || result.length !== values.length || result.some(state=>
        state !== null && state !== false &&
        (!['file','directory'].includes(state?.kind) || !/^[a-f0-9]{64}$/u.test(state?.stamp || '')))) {
        throw Error('The remote SSH file observation was incomplete.');
      }
      return result;
    },
    async read(value) {
      const { content, sha256 } = await request('read', partsFor(value));
      const data = Buffer.from(content, 'base64');
      if (data.length > maxFileBytes || digest(data) !== sha256) throw Error('The remote bytes failed verification.');
      return { data, sha256 };
    },
    async replace(value, data, expected) {
      if (!Buffer.isBuffer(data) || data.length > maxFileBytes || !/^[a-f0-9]{64}$/.test(expected)) {
        throw Error('The remote file update needs a reviewed digest and at most 2 MiB of data.');
      }
      const { sha256 } = await request('replace', partsFor(value), { expected, content: data.toString('base64') });
      if (sha256 !== digest(data)) throw Error('The remote upload result could not be verified. Read the file before retrying.');
      return sha256;
    },
    close() {
      closed = true;
      processes.close();
      for (const child of active) child.kill();
      void peer.close().catch(() => {});
    }
  });
}

module.exports = { connectWorkspace, maxFileBytes, maximumWatchPaths, uriScheme, digest, partsFor };
