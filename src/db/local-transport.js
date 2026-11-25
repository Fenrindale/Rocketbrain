'use strict';

const { posix } = require('node:path');
const { createHash } = require('node:crypto');

const pipePrefix = '\\\\.\\pipe\\';
const descriptions = { 'unix-socket': 'Unix socket', 'named-pipe': 'Windows named pipe' };
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_LOCAL_TRANSPORT' });

function normalizeLocalTransport(value, { allowUnconfigured = false } = {}) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.hasOwn(descriptions, value.kind) || Object.keys(value).some(key => !['kind', 'address'].includes(key))) {
    throw fail('Choose a Unix socket or Windows named pipe for this local connection.');
  }
  const { kind, address } = value;
  if (allowUnconfigured && address === undefined) return { kind };
  if (typeof address !== 'string' || address.length > 256 || !address.trim() || /[\x00-\x1f\x7f]/.test(address) ||
      Buffer.from(address, 'utf8').toString('utf8') !== address) {
    throw fail('Enter the local socket path or pipe name for this connection.');
  }
  if (kind === 'named-pipe') {
    const name = address.toLowerCase().startsWith(pipePrefix) ? address.slice(pipePrefix.length) : address;
    if (!name.trim() || ['.', '..'].includes(name) || /[\\/]/.test(name) || pipePrefix.length + name.length > 256) {
      throw fail('Use a pipe name on this Windows host, such as MySQL or ' + pipePrefix + 'MySQL.');
    }
    return { kind, address: name };
  }
  if (!posix.isAbsolute(address) || address === '/' || address.startsWith('//') || posix.normalize(address) !== address ||
      address.endsWith('/') || Buffer.byteLength(address) > 103) {
    throw fail('Enter a normalized absolute Unix socket path of at most 103 UTF-8 bytes.');
  }
  return { kind, address };
}

function localDriverOptions(config, platform = process.platform) {
  const transport = normalizeLocalTransport(config.transport);
  if (!transport) return undefined;
  if (config.host !== undefined || config.port !== undefined || config.ssl !== undefined || config.ssh != null) {
    throw fail('Use one local transport or a TCP connection with its own TLS and SSH settings.');
  }
  if (transport.kind === 'named-pipe' && platform !== 'win32') throw fail('Windows named pipes require a Windows extension host.');
  if (transport.kind === 'unix-socket' && platform === 'win32') throw fail('Unix sockets require a Unix-like extension host.');
  return { socketPath: transport.kind === 'named-pipe' ? pipePrefix + transport.address : transport.address };
}

function transportLabel(value) {
  return value && descriptions[value.kind];
}

function transportKey(value) {
  if (!value?.address) return undefined;
  return [value.kind, value.kind === 'named-pipe' ? value.address.toLowerCase() : value.address];
}

function connectionEndpoint(options) {
  const { socketPath } = options;
  if (!socketPath) return { host: options.host, port: options.port };
  const kind = socketPath.toLowerCase().startsWith(pipePrefix) ? 'named-pipe' : 'unix-socket';
  const path = kind === 'named-pipe' ? socketPath.toLowerCase() : socketPath;
  return { transport: kind, addressHash: createHash('sha256').update(path).digest('hex') };
}

module.exports = { normalizeLocalTransport, localDriverOptions, transportLabel, transportKey, connectionEndpoint };
