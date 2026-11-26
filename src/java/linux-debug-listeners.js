'use strict';

const { execFile } = require('node:child_process');

const maxPid = 0xffffffff;
const exactLoopback = '127.0.0.1';

function parseLinuxListeners(output) {
  const listeners = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const socket = /^\s*LISTEN\s+\d+\s+\d+\s+(\S+):(\d{1,5})\s+\S+(?:\s+(.*))?\s*$/u.exec(line);
    if (!socket) throw Error('Linux returned an unrecognized local TCP listener record.');
    const [, address, rawPort, owner] = socket;
    const port = Number(rawPort);
    if (port < 1 || port > 65535) throw Error('Linux returned an invalid local TCP port.');
    const ownerMatch = /^users:\(\("[^"\r\n]+",pid=([1-9]\d{0,9}),fd=\d+\)\)$/u.exec(owner?.trim() || '');
    const pid = ownerMatch && Number(ownerMatch[1]);
    const listener = { pid: address === exactLoopback && pid && pid <= maxPid ? pid : null };
    listeners.set(port, listeners.has(port) ? { pid: null } : listener);
  }
  return listeners;
}

function readLinuxListeners({ signal, port } = {}) {
  const filter = port === undefined ? [] : ['sport', '=', ':' + port];
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/ss', ['-H', '-O', '-l', '-t', '-n', '-p', ...filter], {
      encoding: 'utf8', timeout: 2500, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' }, signal
    }, (error, stdout) => {
      if (error) {
        reject(Error('Linux could not verify local TCP listener ownership with iproute2 ss.', { cause: error }));
        return;
      }
      try { resolve(parseLinuxListeners(stdout)); } catch (failure) { reject(failure); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

module.exports = { parseLinuxListeners, readLinuxListeners };
