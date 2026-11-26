'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const { maxFileBytes, hash } = require('./reviewed-file');
const maxListingBytes = 256 * 1024;
const maxReplyBytes = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hostname = value => typeof value === 'string' && (net.isIP(value) ||
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(value));
const segment = value => value && value !== '.' && value !== '..' && value.isWellFormed() &&
  Buffer.byteLength(value) <= 255 && !/[\\/:"\x00-\x1f\x7f]/u.test(value) && value.trim() === value;

function relativePath(value, allowRoot = false) {
  if (allowRoot && value === '') return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 ||
      value.split('/').length > 16 || value.split('/').some(part => !segment(part))) {
    throw Error('Choose a relative FTPS path with ordinary directory and file names.');
  }
  return value;
}

function profileFor(value) {
  const { label, host, port = 21, user, root, tlsServerName = host, caFile } = value ?? {};
  if (typeof label !== 'string' || !label.trim() || Buffer.byteLength(label) > 80 || /[\x00-\x1f]/u.test(label) ||
      !hostname(host) || !hostname(tlsServerName) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof user !== 'string' || !/^[\w.@+\\\/-]{1,80}$/u.test(user) || typeof root !== 'string' || !root.startsWith('/')) {
    throw Error('Configure an FTPS label, host, port, account, TLS identity, and absolute remote root.');
  }
  if (root !== '/') relativePath(root.slice(1));
  if (caFile !== undefined && (typeof caFile !== 'string' || !path.isAbsolute(caFile) || /[\x00-\x1f]/u.test(caFile))) {
    throw Error('Choose an absolute local path to a trusted CA PEM file.');
  }
  return { label: label.trim(), host, port, user, root, tlsServerName, ...(caFile && { caFile }) };
}

async function trustFor(profile) {
  if (!profile.caFile) return { digest: null };
  const file = await fs.open(profile.caFile, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(), limit = 128 * 1024;
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw Error('Choose one CA PEM file of at most 128 KiB.');
    const bytes = Buffer.alloc(stat.size + 1);
    const result = await file.read(bytes);
    if (result.bytesRead !== stat.size) throw Error('The FTPS CA file changed while reading it.');
    const ca = bytes.subarray(0, stat.size);
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw Error('Choose a PEM file containing a trusted CA certificate.');
    return { digest: hash(ca), ca };
  } finally { await file.close(); }
}

function controlReplies(socket, signal) {
  let pending = Buffer.alloc(0), group, waiter, failure;
  const queue = [];
  function reject(error) {
    failure ??= error;
    waiter?.reject(failure);
    waiter = undefined;
  }
  function emit(reply) {
    if (waiter) { waiter.resolve(reply); waiter = undefined; }
    else if (queue.length < 8) queue.push(reply);
    else reject(Error('The FTPS server sent too many unsolicited replies.'));
  }
  function line(bytes) {
    const value = utf8.decode(bytes);
    if (group) {
      group.bytes += bytes.length + 2;
      if (group.bytes > maxReplyBytes || group.lines.length >= 256) throw Error('The FTPS reply was too large.');
      group.lines.push(value);
      if (value.startsWith(group.code + ' ')) {
        emit({ code: Number(group.code), message: value.slice(4), lines: group.lines });
        group = undefined;
      }
      return;
    }
    const match = /^([1-5]\d\d)([ -])(.*)$/u.exec(value);
    if (!match) throw Error('The FTPS server sent an invalid reply.');
    if (match[2] === '-') group = { code: match[1], bytes: bytes.length + 2, lines: [value] };
    else emit({ code: Number(match[1]), message: match[3], lines: [value] });
  }
  function receive(bytes) {
    if (failure) return;
    try {
      if (pending.length + bytes.length > maxReplyBytes) throw Error('The FTPS reply was too large.');
      pending = Buffer.concat([pending, bytes]);
      for (let end = pending.indexOf('\r\n'); end >= 0; end = pending.indexOf('\r\n')) {
        line(pending.subarray(0, end));
        pending = pending.subarray(end + 2);
      }
    } catch (error) { reject(error); }
  }
  const stopped = () => reject(Error('The FTPS control connection closed.'));
  const canceled = () => reject(signal.reason);
  socket.on('data', receive);
  socket.on('error', stopped);
  socket.on('close', stopped);
  signal.addEventListener('abort', canceled, { once: true });
  return {
    assertOpen() { signal.throwIfAborted(); if (failure) throw failure; },
    async next() {
      this.assertOpen();
      if (queue.length) return queue.shift();
      if (waiter) throw Error('An FTPS command is already awaiting a reply.');
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    detach() {
      socket.removeListener('data', receive);
      socket.removeListener('error', stopped);
      socket.removeListener('close', stopped);
      signal.removeEventListener('abort', canceled);
    },
  };
}

async function tcp(host, port, signal) {
  const socket = net.createConnection({ host, port });
  try {
    await once(socket, 'connect', { signal });
    socket.setNoDelay(true);
    return socket;
  } catch {
    socket.destroy();
    signal.throwIfAborted();
    throw Error('The owned FTPS endpoint could not be reached.');
  }
}

async function encrypted(socket, profile, trust, signal, expectedCertificate) {
  const servername = profile.tlsServerName;
  const secure = tls.connect({ socket, host: servername, ...(net.isIP(servername) === 0 && { servername }),
    rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(trust.ca && { ca: trust.ca }),
    checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(servername, certificate),
  });
  try {
    await once(secure, 'secureConnect', { signal });
    const peer = secure.getPeerCertificate();
    if (!secure.authorized || !peer?.raw) throw Error('Certificate was not verified.');
    const certificate = hash(peer.raw);
    if (expectedCertificate && certificate !== expectedCertificate) throw Error('Certificate changed.');
    return { socket: secure, certificate };
  } catch {
    secure.destroy();
    signal.throwIfAborted();
    throw Error('FTPS TLS identity verification failed. Review the trusted CA and server name.');
  }
}

function expect(reply, allowed, operation) {
  if (!allowed.includes(reply.code)) throw Object.assign(
    Error('The FTPS server rejected ' + operation + ' with reply ' + reply.code + '.'), { code: reply.code });
  return reply;
}

function command(socket, replies, line) {
  replies.assertOpen();
  socket.write(line + '\r\n');
  return replies.next();
}

async function transfer(control, replies, line, requested, profile, trust, certificate, signal) {
  const passive = expect(await command(control, replies, 'EPSV'), [229], 'passive data negotiation');
  const port = Number(/\(\|\|\|(\d{1,5})\|\)/u.exec(passive.message)?.[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === control.remotePort) {
    throw Error('The FTPS server did not provide a valid separate passive data port.');
  }
  const raw = await tcp(control.remoteAddress, port, signal);
  let data;
  try {
    await requested.beforeCommand?.();
    const ready = expect(await command(control, replies, line), [125,150], 'a protected data transfer');
    requested.onStart?.(ready);
    data = (await encrypted(raw, profile, trust, signal, certificate)).socket;
    await requested.beforeData?.();
    signal.throwIfAborted();
    let output;
    if (requested.bytes) {
      const end = finished(data, { cleanup: true, signal, writable: false });
      data.resume();
      data.end(requested.bytes);
      await end;
    } else {
      const chunks = [];
      let size = 0;
      const abort = () => data.destroy(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        for await (const chunk of data) {
          size += chunk.length;
          if (size > requested.limit) throw Error('The protected FTPS data exceeded the reviewed size limit.');
          chunks.push(chunk);
        }
      } finally { signal.removeEventListener('abort', abort); }
      output = Buffer.concat(chunks, size);
    }
    expect(await replies.next(), [226,250], 'completion of the protected data transfer');
    return output;
  } finally { data?.destroy(); raw.destroy(); }
}

function entriesOf(bytes) {
  if (bytes.length === 0) return [];
  const rows = [];
  for (const line of utf8.decode(bytes).split('\r\n').filter(Boolean)) {
    const parsed = /^((?:[\w.\-]+=[^;\r\n]*;)+) (.*)$/u.exec(line);
    if (!parsed) throw Error('The FTPS server sent an invalid MLSD entry.');
    const [, list, name] = parsed;
    const facts = Object.fromEntries(list.slice(0, -1).split(';').map(value => {
      const split = value.indexOf('=');
      return [value.slice(0, split).toLowerCase(), value.slice(split + 1)];
    }));
    const type = facts.type?.toLowerCase();
    if (['cdir','pdir'].includes(type) || !segment(name)) continue;
    const kind = type === 'dir' ? 'directory' : type === 'file' ? 'file' : 'other';
    const size = /^\d+$/u.test(facts.size) ? Number(facts.size) : null;
    rows.push({ name, kind, ...(kind === 'file' && { bytes: size }), unique: facts.unique, modified: facts.modify });
    if (rows.length > 256) throw Error('Choose an FTPS directory with at most 256 listed entries.');
  }
  if (new Set(rows.map(row => row.name)).size !== rows.length) throw Error('The FTPS directory listed an ambiguous file name.');
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function channel(control, replies, profile, trust, certificate, signal) {
  const send = line => command(control, replies, line);
  const data = (line, request) => transfer(control, replies, line, request, profile, trust, certificate, signal);
  const scoped = relative => path.posix.join(profile.root, relativePath(relative, true));
  async function directory(relative) {
    const absolute = scoped(relative);
    expect(await send('CWD ' + absolute), [250], 'selection of the scoped directory');
    const location = expect(await send('PWD'), [257], 'confirmation of the scoped directory');
    if (/^"([^"]*)"/u.exec(location.message)?.[1] !== absolute) throw Error('The FTPS directory resolved to a different location.');
  }

  async function list(relative) {
    await directory(relative);
    return entriesOf(await data('MLSD', { limit: maxListingBytes }));
  }
  async function inspect(relative) {
    const filename = relativePath(relative), parent = path.posix.dirname(filename);
    return (await list(parent === '.' ? '' : parent)).find(row => row.name === path.posix.basename(filename));
  }
  return { trust: { certificate, ca: trust.digest }, list, inspect,
    async file(relative) {
      const before = await inspect(relative);
      if (!before) return { sha256: null };
      if (before.kind !== 'file' || !Number.isSafeInteger(before.bytes) || before.bytes < 0 || before.bytes > maxFileBytes) {
        throw Error('Choose a regular FTPS file of at most 2 MiB with a reported byte size.');
      }
      const bytes = await data('RETR ' + path.posix.basename(relative), { limit: maxFileBytes });
      if (before.bytes !== bytes.length || JSON.stringify(before) !== JSON.stringify(await inspect(relative))) {
        throw Error('The FTPS file changed while reading it.');
      }
      return { bytes, sha256: hash(bytes) };
    },
    async mkdir(relative) {
      expect(await send('MKD ' + scoped(relative)), [257], 'folder creation');
    },
    async publishUnique(directoryName, prefix, bytes, { onGenerated, beforeCommand, beforeData }) {
      await directory(directoryName);
      return data('STOU ' + prefix, { bytes, beforeCommand, beforeData, onStart(reply) {
        const name = /^FILE:\s+([^\r\n]+)$/u.exec(reply.message)?.[1];
        if (!name || !name.startsWith(prefix + '.') || name.length > prefix.length + 80 || !/^[\w.\-]+$/u.test(name) || !segment(name)) {
          throw Error('The FTPS server did not report a safe unique filename before publication.');
        }
        onGenerated([directoryName, name].filter(Boolean).join('/'));
      } });
    },
  };
}

async function withFtps(profile, credential, signal, action, binding) {
  if (typeof credential !== 'string' || !credential || Buffer.byteLength(credential) > 4096 || /[\x00-\x1f\x7f]/u.test(credential)) {
    throw Error('Enter an FTPS password without control characters.');
  }
  const limit = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  limit.throwIfAborted();
  const trust = await trustFor(profile);
  if (binding && trust.digest !== binding.ca) throw Error('The FTPS trusted CA file changed. Review the route again.');
  const raw = await tcp(profile.host, profile.port, limit);
  let control, reader = controlReplies(raw, limit);
  try {
    expect(await reader.next(), [220], 'the session greeting');
    expect(await command(raw, reader, 'AUTH TLS'), [234], 'explicit TLS negotiation');
    reader.detach();
    const { socket, certificate } = await encrypted(raw, profile, trust, limit, binding?.certificate);
    control = socket;
    reader = controlReplies(control, limit);
    const send = line => command(control, reader, line);
    expect(await send('USER ' + profile.user), [331], 'password authentication');
    expect(await send('PASS ' + credential), [230], 'the supplied account credential');
    credential = undefined;
    expect(await send('PBSZ 0'), [200], 'the TLS protection buffer');
    expect(await send('PROT P'), [200], 'private data protection');
    expect(await send('TYPE I'), [200], 'binary transfer mode');
    return await action(channel(control, reader, profile, trust, certificate, limit));
  } finally { reader.detach(); control?.destroy(); raw.destroy(); }
}

module.exports = { profileFor, relativePath, withFtps, hash, maxFileBytes };
