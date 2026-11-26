'use strict';

const { Transform } = require('node:stream');
const path = require('node:path');
const { maxSourceBytes } = require('./java-mapping');

const maxFrameBytes = 1024 * 1024;
const cleanText = text => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '');

function boundedMessages() {
  let buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, done) {
      if (chunk.length > maxFrameBytes) return done(Error('Container Java message exceeds the protocol limit.'));
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (buffer.length > 4096) return done(Error('Invalid container Java message header.'));
          break;
        }
        if (headerEnd > 4096) return done(Error('Invalid container Java message header.'));
        const headers = buffer.subarray(0, headerEnd).toString('ascii').split('\r\n');
        const lengths = headers.filter(header => /^Content-Length:/i.test(header));
        const length = lengths.length === 1 && /^Content-Length:\s*([0-9]{1,7})$/i.exec(lengths[0]);
        const size = Number(length?.[1]);
        if (!Number.isInteger(size) || size <= 0 || size > maxFrameBytes) {
          return done(Error('Container Java message exceeds the protocol limit.'));
        }
        const end = headerEnd + 4 + size;
        if (buffer.length < end) break;
        this.push(buffer.subarray(0, end));
        buffer = buffer.subarray(end);
      }
      done();
    }
  });
}

function inSource(text) {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > maxSourceBytes) {
    throw Error('Use a Java source editor up to 256 KiB.');
  }
}

function offsetsFor(text) {
  const lines = text.split(/\r?\n/u);
  let at = 0;
  const starts = lines.map((line, index) => {
    const start = at;
    if (index < lines.length - 1) at += line.length + (text[start + line.length] === '\r' ? 2 : 1);
    return start;
  });
  return ({ line, character } = {}) => {
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || line >= lines.length ||
        character < 0 || character > lines[line].length) throw Error('The Java server returned an invalid source range.');
    return starts[line] + character;
  };
}

function safeRange(range) {
  const point = location => location && Number.isInteger(location.line) && location.line >= 0 &&
    Number.isInteger(location.character) && location.character >= 0 && location.line <= maxSourceBytes &&
    location.character <= maxSourceBytes;
  return point(range?.start) && point(range?.end) && (range.start.line < range.end.line ||
    range.start.line === range.end.line && range.start.character <= range.end.character);
}

function sourcePosition(point) {
  if (!safeRange({ start: point, end: point })) throw Error('Select a current position in a mounted Java source editor.');
  return { line: point.line, character: point.character };
}

function checkedFormatter(text, input) {
  inSource(text);
  if (input == null) return { before: text, after: text };
  if (!Array.isArray(input) || input.length > 256) throw Error('The container Java formatting response exceeds the edit limit.');
  const offset = offsetsFor(text);
  const edits = input.map(edit => {
    if (!safeRange(edit?.range)) throw Error('The Java server returned an invalid source range.');
    inSource(edit.newText);
    return { start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText };
  }).sort((a, b) => b.start - a.start);
  let end = text.length + 1, total = 0, previous;
  for (const edit of edits) {
    total += Buffer.byteLength(edit.text);
    if (edit.end > end || total > maxSourceBytes || edit.start === previous) {
      throw Error('The container Java formatting edits overlap or exceed the edit limit.');
    }
    previous = edit.start;
    end = edit.start;
  }
  let after = text;
  for (const edit of edits) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  inSource(after);
  return { before: text, after };
}

function plainHover(contents) {
  const values = Array.isArray(contents) ? contents.slice(0, 8) : [contents];
  return cleanText(values.map(value => typeof value === 'string' ? value : value?.value || '').join('\n\n')).slice(0, 16384);
}

function createContainerJavaLsp({ child, protocol, mapping, settings, onDiagnostics = () => {}, onExit = () => {} }) {
  const documents = new Map();
  const input = boundedMessages();
  const connection = protocol.createProtocolConnection(new protocol.StreamMessageReader(input),
    new protocol.StreamMessageWriter(child.stdin));
  let stopped = false, failure, stopping, changeKind = 2;

  function fail() {
    if (stopped) return;
    stopped = true;
    failure = Error('The managed container Java server stopped.');
    connection.dispose();
    child.stdout.unpipe(input);
    input.destroy();
    child.stdin.end();
    documents.clear();
    const kill = setTimeout(() => child.kill(), 8000);
    kill.unref();
    child.once('close', () => clearTimeout(kill));
    onExit();
  }

  input.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.on('error', fail);
  child.on('close', fail);
  connection.onClose(fail);
  connection.onError(fail);
  child.stdout.pipe(input);
  connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'Review edits in the workspace editor.' }));
  connection.onRequest('workspace/configuration', params => (Array.isArray(params?.items) ? params.items.slice(0, 32) : [])
    .map(item => item?.section === 'java' ? settings.java : item?.section ? null : settings));
  connection.onRequest('workspace/workspaceFolders', () => [{ uri: mapping.workspaceUri, name: 'Mounted Java workspace' }]);
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('client/unregisterCapability', () => null);
  connection.onRequest('window/workDoneProgress/create', () => null);
  connection.onRequest('window/showMessageRequest', () => null);
  connection.onNotification('textDocument/publishDiagnostics', params => {
    let file;
    try { file = mapping.toHost(params?.uri); } catch { return; }
    const open = documents.get(params.uri) || [...documents.values()].find(document => !path.relative(document.file, file));
    if (!open || params.version != null && params.version !== open.version || !Array.isArray(params.diagnostics)) return;
    const diagnostics = params.diagnostics.slice(0, 128).flatMap(item =>
      safeRange(item?.range) && typeof item.message === 'string' && /^[1-4]$/.test(item.severity ?? 1)
        ? [{ range: item.range, message: cleanText(item.message).slice(0, 4096), severity: item.severity ?? 1 }] : []);
    onDiagnostics(open.file, diagnostics, open.version);
  });
  connection.listen();

  async function request(method, params, timeout = 12000, cancellation) {
    if (stopped || cancellation?.isCancellationRequested) throw failure || Error('The container Java request was cancelled.');
    const source = new protocol.CancellationTokenSource();
    const subscription = cancellation?.onCancellationRequested(() => source.cancel());
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          source.cancel();
          reject(Error('The container Java request exceeded its time limit.'));
        }, timeout);
      });
      return await Promise.race([connection.sendRequest(method, params, source.token), deadline]);
    } finally {
      clearTimeout(timer);
      subscription?.dispose();
      source.dispose();
    }
  }

  async function synchronize({ file, text, version }) {
    inSource(text);
    if (stopped || !Number.isInteger(version) || version < 0) throw Error('Open a current mounted Java source editor.');
    const uri = mapping.toRemote(file);
    const current = documents.get(uri);
    if (current?.version === version && current.text === text) return uri;
    if (current?.version >= version) throw Error('The mounted editor version changed. Reopen the source file.');
    if (!current && documents.size >= 32) throw Error('Close a mounted Java editor before adding another.');
    documents.set(uri, { file, text, version });
    if (current) {
      const lines = current.text.split(/\r?\n/u);
      const change = changeKind === 2 ? { text, range: {
        start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length }
      } } : { text };
      await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [change] });
    } else await connection.sendNotification('textDocument/didOpen',
      { textDocument: { uri, version, text, languageId: 'java' } });
    return uri;
  }

  return {
    async initialize() {
      const workspaceFolders = [{ uri: mapping.workspaceUri, name: 'Mounted Java workspace' }];
      const response = await request('initialize', {
        processId: null, clientInfo: { name: 'Rocketbrain Container Java' }, rootUri: mapping.workspaceUri, workspaceFolders,
        capabilities: { workspace: { workspaceFolders: true, configuration: true, applyEdit: false },
          textDocument: { synchronization: { didSave: false }, hover: { contentFormat: ['plaintext'] },
            definition: { linkSupport: true }, publishDiagnostics: { versionSupport: true } } },
        initializationOptions: { bundles: [], workspaceFolders: [mapping.workspaceUri], settings }
      }, 60000);
      if (!response?.capabilities) throw Error('The container did not start the Java language protocol.');
      const sync = response.capabilities.textDocumentSync;
      changeKind = typeof sync === 'number' ? sync : sync?.change;
      if (![1, 2].includes(changeKind)) throw Error('The container Java server does not declare supported document synchronization.');
      await connection.sendNotification('initialized', {});
      await connection.sendNotification('workspace/didChangeConfiguration', { settings });
    },
    synchronize,
    async close(file) {
      if (stopped) return;
      const entry = [...documents].find(([_uri, document]) => document.file === file);
      if (entry) {
        const [uri] = entry;
        documents.delete(uri);
        await connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
      }
    },
    async hover(document, position, cancellation) {
      const uri = await synchronize(document);
      const reply = await request('textDocument/hover', { textDocument: { uri }, position: sourcePosition(position) }, 12000, cancellation);
      return plainHover(reply?.contents);
    },
    async definition(document, position, cancellation) {
      const uri = await synchronize(document);
      const response = await request('textDocument/definition', { textDocument: { uri },
        position: sourcePosition(position) }, 12000, cancellation);
      return (Array.isArray(response) ? response.slice(0, 32) : [response]).flatMap(item => {
        const range = item?.targetSelectionRange || item?.range;
        if (!safeRange(range)) return [];
        try { return [{ file: mapping.toHost(item.targetUri || item.uri), range }]; } catch { return []; }
      });
    },
    async formatting(document, options) {
      const uri = await synchronize(document);
      const { tabSize, insertSpaces } = options || {};
      if (!Number.isInteger(tabSize) || tabSize < 1 || tabSize > 32 || typeof insertSpaces !== 'boolean') {
        throw Error('Choose valid Java formatter indentation options.');
      }
      const reply = await request('textDocument/formatting', { textDocument: { uri }, options: { tabSize, insertSpaces } });
      return checkedFormatter(document.text, reply);
    },
    stop() {
      if (stopped) return Promise.resolve();
      if (!stopping) stopping = (async () => {
        try {
          await request('shutdown', null, 2200);
          await connection.sendNotification('exit');
        } catch { /* EOF also stops the owned supervised process. */ }
        finally { fail(); }
      })();
      return stopping;
    },
    dispose: fail
  };
}

module.exports = { boundedMessages, checkedFormatter, createContainerJavaLsp };
