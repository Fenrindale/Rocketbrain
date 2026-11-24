'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');

const frameHeaderBytes = 4;
const tagBytes = 16;
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_TABLE_TRANSFER' });
const statIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), size: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function writeAll(file, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw fail('The source spool could not be written.');
    offset += bytesWritten;
  }
}

async function readAll(file, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesRead) throw fail('The encrypted source snapshot is incomplete.');
    offset += bytesRead;
  }
}

async function createRowSpool({ columns, maxRows, maxRowBytes, maxBytes, directoryRoot = os.tmpdir(), directory, recovery }) {
  const managed = directory !== undefined;
  if (!managed) directory = await fs.mkdtemp(path.join(directoryRoot, 'rocketbrain-table-copy-'));
  const file = path.join(directory, 'rows.bin'), original = await fs.lstat(directory);
  if (!original.isDirectory()) throw fail('The encrypted source directory is invalid.');
  const cleanup = async () => {
    const owner = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!owner?.isDirectory() || owner.ino !== original.ino || owner.dev !== original.dev) return;
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory);
  };
  if (recovery && (!managed || !/^[0-9a-f]{64}$/.test(recovery.key) || !/^[0-9a-f]{16}$/.test(recovery.prefix) ||
      !Number.isSafeInteger(recovery.sealed?.rowCount) || recovery.sealed.rowCount < 1 || recovery.sealed.rowCount > maxRows ||
      !Number.isSafeInteger(recovery.sealed.bytes) || recovery.sealed.bytes > maxBytes || recovery.sealed.bytes < 22 ||
      !/^[0-9a-f]{64}$/.test(recovery.sealed.sourceHash))) throw fail('The encrypted source recovery record is invalid.');
  const key = recovery ? Buffer.from(recovery.key, 'hex') : randomBytes(32);
  const prefix = recovery ? Buffer.from(recovery.prefix, 'hex') : randomBytes(8);
  let writer;
  try { if (!recovery) writer = await fs.open(file, 'wx', 0o600); }
  catch (error) { key.fill(0); if (!managed) await cleanup(); throw error; }
  const hashRows = () => createHash('sha256').update(JSON.stringify(columns) + '\n');
  const observed = hashRows();
  let size = 0, rows = 0, maxFrameBytes = 0, readers = 0, writing = false, sealed = recovery?.sealed;
  let disposed = false, disposal, disposeResolve, disposeReject;
  const nonce = index => {
    const value = Buffer.alloc(12);
    prefix.copy(value);
    value.writeUInt32BE(index, 8);
    return value;
  };
  function check(signal) {
    if (disposed) throw fail('The source snapshot was released.');
    if (signal?.aborted || signal?.isCancellationRequested) throw fail('Table copy cancelled.');
  }
  function cleanIfIdle() {
    if (!disposed || readers || writing || !disposeResolve) return;
    const resolve = disposeResolve, reject = disposeReject;
    disposeResolve = disposeReject = undefined;
    key.fill(0);
    void (async () => {
      try { if (writer) await writer.close(); }
      finally { if (!managed) await cleanup(); }
    })().then(resolve, reject);
  }

  return {
    recoveryRecord() {
      check();
      if (!managed || !sealed) throw fail('The source snapshot cannot be retained across restarts.');
      return { key: key.toString('hex'), prefix: prefix.toString('hex'), sealed: structuredClone(sealed) };
    },
    async append(row, signal) {
      check(signal);
      if (sealed || !writer) throw fail('The source snapshot is sealed.');
      if (writing) throw fail('The source snapshot writer is already active.');
      if (!Array.isArray(row) || row.length !== columns.length || row.some(value => value !== null && typeof value !== 'string')) {
        throw fail('The source row shape changed.');
      }
      const clear = Buffer.from(JSON.stringify(row), 'utf8');
      const length = clear.length + frameHeaderBytes + tagBytes;
      if (rows >= maxRows || clear.length > maxRowBytes || size + length > maxBytes) {
        clear.fill(0);
        throw fail('The source exceeds the bounded row or encrypted snapshot size.');
      }
      writing = true;
      try {
        const header = Buffer.alloc(frameHeaderBytes);
        header.writeUInt32BE(clear.length);
        const cipher = createCipheriv('aes-256-gcm', key, nonce(rows));
        cipher.setAAD(header);
        const frame = Buffer.concat([header, cipher.update(clear), cipher.final(), cipher.getAuthTag()], length);
        await writeAll(writer, frame, size);
        observed.update(header).update(clear);
        size += length;
        rows++;
        maxFrameBytes = Math.max(maxFrameBytes, length);
      } finally {
        clear.fill(0);
        writing = false;
        cleanIfIdle();
      }
    },
    async seal(signal) {
      check(signal);
      if (!rows || sealed) throw fail('The selected source contains no streamable rows.');
      if (writing || !writer) throw fail('The source snapshot writer is unavailable.');
      writing = true;
      try {
        await writer.sync();
        const stat = await writer.stat();
        await writer.close();
        writer = undefined;
        check(signal);
        if (stat.size !== size) throw fail('The encrypted snapshot length changed before sealing.');
        sealed = { rowCount: rows, bytes: size, maxFrameBytes, sourceHash: observed.digest('hex'), identity: statIdentity(stat) };
        return structuredClone(sealed);
      } finally { writing = false; cleanIfIdle(); }
    },
    async scan({ cancellation, onStart, onRow }) {
      check(cancellation);
      if (!sealed) throw fail('Capture the source table before reviewing it.');
      readers++;
      let reader;
      try {
        reader = await fs.open(file, 'r');
        const before = await reader.stat();
        if (!before.isFile() || !same(statIdentity(before), sealed.identity)) throw fail('The encrypted source snapshot changed.');
        await onStart?.(structuredClone(sealed));
        const hash = hashRows(), header = Buffer.alloc(frameHeaderBytes);
        let position = 0, count = 0;
        while (position < sealed.bytes) {
          check(cancellation);
          if (count >= sealed.rowCount) throw fail('The encrypted source snapshot has extra rows.');
          await readAll(reader, header, position);
          const length = header.readUInt32BE(), end = position + frameHeaderBytes + length + tagBytes;
          if (length < 2 || length > maxRowBytes || end > sealed.bytes) throw fail('The encrypted source row size changed.');
          const payload = Buffer.alloc(length + tagBytes);
          await readAll(reader, payload, position + frameHeaderBytes);
          let clear, authenticated, row;
          try {
            const decipher = createDecipheriv('aes-256-gcm', key, nonce(count));
            decipher.setAAD(header);
            decipher.setAuthTag(payload.subarray(length));
            clear = decipher.update(payload.subarray(0, length));
            authenticated = decipher.final();
            if (authenticated.length) throw fail('An encrypted source row is invalid.');
            hash.update(header).update(clear);
            row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear));
          } catch {
            throw fail('An encrypted source row failed authentication.');
          } finally { clear?.fill(0); authenticated?.fill(0); }
          if (!Array.isArray(row) || row.length !== columns.length || row.some(value => value !== null && typeof value !== 'string')) {
            throw fail('The source row shape changed.');
          }
          check(cancellation);
          await onRow?.(row, count);
          count++;
          position = end;
        }
        if (count !== sealed.rowCount || hash.digest('hex') !== sealed.sourceHash) throw fail('The authenticated source rows differ from the sealed snapshot.');
        if (!same(statIdentity(await reader.stat()), sealed.identity)) throw fail('The encrypted source snapshot changed during the read.');
        check(cancellation);
        return structuredClone(sealed);
      } finally {
        try { await reader?.close(); }
        finally { readers--; cleanIfIdle(); }
      }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = new Promise((resolve, reject) => { disposeResolve = resolve; disposeReject = reject; });
      cleanIfIdle();
      return disposal;
    }
  };
}

module.exports = { createRowSpool };
