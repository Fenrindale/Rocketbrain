'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const { distroArgs, osWslPath } = require('./wsl-workspace');
const { sameWslPath, wslUnc } = require('./wsl-paths');

const execute = promisify(execFile);
const maxBytes = 256 * 1024;
const sourceExtension = /\.(?:java|kt|kts|groovy|scala|xml|properties|yaml|yml|sql|json|gradle|md)$/iu;

const readSource = String.raw`
import hashlib, os, stat, sys

root, identity, relative, limit = sys.argv[1:]
limit = int(limit)
parts = relative.split('/')
assert parts and all(part and part not in ('.', '..') for part in parts)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open(root, directory_flags)
assert os.readlink('/proc/self/fd/' + str(fd)) == root
root_info = os.fstat(fd)
assert f'{root_info.st_dev}:{root_info.st_ino}' == identity
for part in parts[:-1]:
    following = os.open(part, directory_flags, dir_fd=fd)
    os.close(fd)
    fd = following
source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)

def signature(item):
    return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)

before = os.fstat(source)
assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit
with os.fdopen(source, 'rb') as handle:
    data = handle.read(limit + 1)
    current = os.fstat(handle.fileno())
    resolved = os.readlink('/proc/self/fd/' + str(handle.fileno()))
    following = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
    current_root = os.stat(root, follow_symlinks=False)
    assert len(data) == before.st_size and resolved == root + '/' + relative
    assert (current_root.st_dev, current_root.st_ino) == (root_info.st_dev, root_info.st_ino)
    assert signature(before) == signature(current) == signature(following)
os.close(fd)
fingerprint = ':'.join(str(part) for part in signature(before))
header = f'{fingerprint} {hashlib.sha256(data).hexdigest()}\n'.encode('ascii')
sys.stdout.buffer.write(header + data)
`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function selectedSource(scope, file) {
  const parsed = wslUnc(file);
  if (scope?.storage !== 'wsl' || !parsed || parsed.distribution !== scope.distribution ||
      !parsed.linux.startsWith(scope.linux + '/') || !sourceExtension.test(parsed.linux)) {
    throw Error('Choose a supported source file in the exact open WSL project.');
  }
  const relative = parsed.linux.slice(scope.linux.length + 1);
  if (relative.split('/').some(part => part.startsWith('.'))) {
    throw Error('Choose an ordinary WSL source file outside hidden folders.');
  }
  return relative;
}

function parseSnapshot(stdout) {
  const bytes = Buffer.from(stdout), separator = bytes.indexOf(10);
  const header = separator > 0 && separator < 180 && /^(\d+:\d+:(\d+):-?\d+:-?\d+) ([a-f0-9]{64})$/u
    .exec(bytes.subarray(0, separator).toString('ascii'));
  const data = bytes.subarray(separator + 1);
  if (!header || data.length > maxBytes || Number(header[2]) !== data.length || sha256(data) !== header[3] || data.includes(0)) {
    throw Error('WSL did not return an intact bounded text source.');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw Error('WSL source review supports UTF-8 text.'); }
  if (/\r(?!\n)/u.test(text)) throw Error('WSL source review supports LF and CRLF line endings.');
  return { fingerprint: header[1] + ':' + header[3], sha256: header[3], text };
}

function createWslSourceReader({ platform = process.platform, run = execute, fileSystem = fs } = {}) {
  async function read(scope, file, { signal, verifyWindows = false } = {}) {
    const relative = selectedSource(scope, file);
    let result;
    try {
      result = await run(osWslPath(platform), distroArgs(scope.distribution,
        ['/usr/bin/python3', '-I', '-S', '-c', readSource, scope.linux, scope.directoryIdentity, relative, String(maxBytes)]),
      { encoding: 'buffer', timeout: 7000, windowsHide: true, maxBuffer: maxBytes + 256, signal });
    } catch {
      if (signal?.aborted) throw Error('WSL source observation stopped.');
      throw Error('WSL could not read an unchanged physical source. Check the file, project identity and /usr/bin/python3.');
    }
    const snapshot = parseSnapshot(result.stdout);
    if (verifyWindows) await verifyMirror(file, snapshot.sha256);
    return snapshot;
  }

  async function verifyMirror(file, hash) {
    const resolved = await fileSystem.realpath(file);
    if (!sameWslPath(wslUnc(file), wslUnc(resolved))) throw Error('Windows resolved the WSL source to a different path.');
    const handle = await fileSystem.open(resolved, 'r');
    try {
      const info = await handle.stat();
      const { size } = info;
      if (!info.isFile() || size > maxBytes) throw Error('The Windows view of the WSL file must be a bounded regular source.');
      const bytes = Buffer.alloc(size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== size || sha256(bytes.subarray(0, bytesRead)) !== hash) {
        throw Error('Windows and Linux did not read the same WSL source bytes.');
      }
    } finally { await handle.close(); }
  }
  return { read };
}

module.exports = { createWslSourceReader, selectedSource };
