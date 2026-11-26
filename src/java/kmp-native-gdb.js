'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { boundedArgument, nativeArgumentList } = require('./kmp-native-review');

const lineLimit = 256 * 1024;
const quote = text => {
  if (!boundedArgument(text)) throw Error('GDB requires a bounded literal argument.');
  return JSON.stringify(text);
};
const integer = text => /^[1-9]\d{0,7}$/u.test(text || '') ? Number(text) : undefined;

function parseMi(line) {
  if (typeof line !== 'string' || line.length > lineLimit) throw Error('GDB/MI exceeded its record limit.');
  const header = /^(\d{0,9})([\^*=])([a-z-]+)(?:,|$)/u.exec(line);
  if (!header) return;
  let offset = header[0].length, nodes = 0;
  const invalid = () => { throw Error('GDB returned an invalid MI record.'); };
  function name() {
    const token = /^[\w.-]+/u.exec(line.slice(offset))?.[0];
    if (!token || token.length > 128) invalid();
    offset += token.length;
    return token;
  }
  function text() {
    let result = '', octal = [];
    const flush = () => {
      if (!octal.length) return;
      result += Buffer.from(octal).toString('utf8');
      octal = [];
    };
    offset++;
    while (offset < line.length) {
      const char = line[offset++];
      if (char === '"') { flush(); return result; }
      if (char !== '\\') { flush(); result += char; continue; }
      const escaped = line[offset++];
      if (/^[0-7]$/u.test(escaped || '')) {
        let digits = escaped;
        while (digits.length < 3 && /^[0-7]$/u.test(line[offset] || '')) digits += line[offset++];
        const byte = Number.parseInt(digits, 8);
        if (byte > 255) invalid();
        octal.push(byte);
      } else {
        flush();
        const control = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '"': '"', '\\': '\\' }[escaped];
        if (!control) invalid();
        result += control;
      }
    }
    invalid();
  }
  function sequence(close, depth, array) {
    const result = array ? [] : Object.create(null);
    while (offset < line.length && line[offset] !== close) {
      if (++nodes > 4096 || depth > 12) invalid();
      if (array && ['"', '{', '['].includes(line[offset])) result.push(value(depth));
      else {
        const key = name();
        if (line[offset++] !== '=') invalid();
        const item = value(depth);
        if (array) result.push({ [key]: item });
        else {
          if (Object.hasOwn(result, key)) invalid();
          result[key] = item;
        }
      }
      if (line[offset] !== ',') break;
      offset++;
      if (offset === line.length || line[offset] === close) invalid();
    }
    if (close && line[offset++] !== close) invalid();
    return result;
  }
  function value(depth) {
    if (line[offset] === '"') return text();
    if (line[offset] === '{') { offset++; return sequence('}', depth + 1, false); }
    if (line[offset] === '[') { offset++; return sequence(']', depth + 1, true); }
    invalid();
  }
  const payload = sequence(undefined, 0, false);
  if (offset !== line.length) invalid();
  return { token: Number(header[1]), kind: header[2], name: header[3], payload };
}

function startNativeGdb(review) {
  review.validate(true);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:LD_|PYTHON|GDB|DEBUGINFOD)/u.test(key)));
  const child = spawn(review.gdb, ['--quiet', '--nx', '--nh', '--interpreter=mi2',
    '-iex', 'set auto-load off'], { cwd: review.module, stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, env: { ...env, LC_ALL: 'C.UTF-8', DEBUGINFOD_URLS: '' } });
  const events = new EventEmitter(), decoder = new StringDecoder('utf8');
  let buffer = '', nextToken = 0, pending, closed = false, stopping, inferiorPid;
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });

  function rejectPending(error) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
    pending = undefined;
  }
  function end(error) {
    if (closed) return;
    closed = true;
    rejectPending(error);
    resolveExit();
    events.emit('closed', error);
  }
  child.once('error', end);
  child.once('close', () => end(Error('The owned Kotlin/Native debugger ended.')));
  child.stderr.resume();
  child.stdin.on('error', rejectPending);

  function lineReceived(line) {
    const record = parseMi(line);
    if (!record) return;
    if (record.kind === '^' && record.token === pending?.token) {
      const { resolve, reject, timer } = pending;
      pending = undefined;
      clearTimeout(timer);
      if (record.name === 'error') {
        const error = Error('GDB could not complete the requested debug action.');
        error.gdbRejected = true;
        reject(error);
      } else resolve(record);
      return;
    }
    if (record.kind === '=' && record.name === 'thread-group-started' && record.payload.id === 'i1') {
      inferiorPid = integer(record.payload.pid);
    }
    if (record.kind === '*' && record.name === 'stopped') events.emit('stopped', record.payload);
  }
  child.stdout.on('data', data => {
    try {
      buffer += decoder.write(data);
      while (buffer.includes('\n')) {
        const endLine = buffer.indexOf('\n');
        lineReceived(buffer.slice(0, endLine).replace(/\r$/u, ''));
        buffer = buffer.slice(endLine + 1);
      }
      if (buffer.length > lineLimit) throw Error('GDB/MI exceeded its record limit.');
    } catch (error) {
      rejectPending(error);
      void stop().catch(() => {});
      events.emit('invalid', error);
    }
  });

  function request(command) {
    if (closed || pending) return Promise.reject(Error('The GDB/MI session is not ready for another action.'));
    const token = ++nextToken;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        rejectPending(Error('The Kotlin/Native debugger command timed out.'));
        void stop().catch(() => {});
      }, 10000);
      pending = { token, resolve, reject, timer };
      child.stdin.write(String(token) + command + '\n');
    });
  }

  async function initialize() {
    const argumentsText = nativeArgumentList(review.args);
    for (const command of ['-gdb-set confirm off', '-gdb-set pagination off', '-gdb-set mi-async on', '-gdb-set disable-randomization off',
      '-gdb-set startup-with-shell off', '-gdb-set may-call-functions off', '-gdb-set debuginfod enabled off',
      '-inferior-tty-set /dev/null', '-file-exec-and-symbols ' + quote(review.program),
      '-gdb-set args' + (argumentsText ? ' ' + argumentsText : '')]) {
      const result = await request(command).catch(error => {
        throw new Error('GDB could not configure ' + command.split(' ').slice(0, command.startsWith('-gdb-set') ? 2 : 1).join(' ') + '.', { cause: error });
      });
      if (result.name !== 'done') throw Error('GDB did not establish a local Kotlin/Native launch.');
    }
  }

  function stop() {
    return stopping ||= (async () => {
      if (closed) return;
      rejectPending(Error('The Kotlin/Native debug session is stopping.'));
      const timer = setTimeout(() => {
        if (closed || !child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }, 2500);
      let deadline;
      try {
        void request('-gdb-exit').catch(() => {});
        await Promise.race([exit, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Error('The owned GDB process did not exit.')), 7500);
        })]);
      } finally { clearTimeout(timer); clearTimeout(deadline); }
    })();
  }

  return { initialize, request, stop, events, validateInferior: () => review.validateInferior(inferiorPid) };
}

module.exports = { parseMi, quote, integer, startNativeGdb };
