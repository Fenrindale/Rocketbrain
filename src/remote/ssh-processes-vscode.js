'use strict';

const { StringDecoder } = require('node:string_decoder');
const { createSshJava } = require('./ssh-java');
const { uriScheme } = require('./ssh-workspace');

function registerSshProcesses(vscode, command, currentConnection, uriFor) {
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-ssh-java');
  const subscriptions = [diagnostics];
  let java, terminal, starting = false, generation = 0;

  function physicalDocument(document, peer) {
    return document?.languageId === 'java' && document.uri.scheme === uriScheme && document.uri.authority === peer.authority &&
      !document.uri.query && !document.uri.fragment;
  }

  function asSnapshot(document) {
    return { file: document.uri.path, text: document.getText(), version: document.version };
  }

  function assertPeer(peer) {
    if (!vscode.workspace.isTrusted || !peer || currentConnection() !== peer) throw Error('Reopen the reviewed SSH workspace.');
  }

  function codeRange(range) { return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character); }

  function clearJava() {
    const prior = java;
    java = undefined;
    prior?.route.dispose();
    diagnostics.clear();
  }

  function closeTerminal(record) {
    if (!record || terminal !== record) return;
    terminal = undefined;
    record.terminal?.dispose();
    record.child.stdin.end();
    record.child.kill();
  }

  async function startTerminal(peer, approval) {
    assertPeer(peer);
    if (terminal) throw Error('Close the existing SSH workspace terminal first.');
    const child = await peer.openProcess('terminal', approval);
    try { assertPeer(peer); } catch (error) { child.kill(); throw error; }
    const out = new vscode.EventEmitter(), closed = new vscode.EventEmitter();
    const record = { child };
    terminal = record;
    let opened = false, earlyOutput = '', exitCode;
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    function write(text) {
      if (opened) out.fire(text);
      else earlyOutput = (earlyOutput + text).slice(-8192);
    }
    function finish() {
      closed.fire(exitCode);
      out.dispose();
      closed.dispose();
    }
    child.stdout.on('data', chunk => write(stdout.write(chunk)));
    child.stderr.on('data', chunk => write(stderr.write(chunk)));
    child.once('close', code => {
      if (terminal === record) terminal = undefined;
      write(stdout.end());
      write(stderr.end());
      exitCode = code ?? 1;
      if (opened) finish();
    });
    const pty = {
      onDidWrite: out.event, onDidClose: closed.event,
      open() {
        opened = true;
        out.fire('SSH ' + peer.host + ' · ' + peer.root + '\r\n');
        out.fire(earlyOutput);
        earlyOutput = '';
        if (exitCode !== undefined) finish();
      },
      close() { closeTerminal(record); },
      handleInput(input) {
        if (!vscode.workspace.isTrusted || currentConnection() !== peer) return closeTerminal(record);
        if (Buffer.byteLength(input) <= 8192 && child.stdin.writableLength <= 1024 * 1024 && child.stdin.writable) {
          child.stdin.write(input);
        }
      }
    };
    try {
      record.terminal = vscode.window.createTerminal({ name: 'Rocketbrain SSH · ' + peer.id, pty });
      record.terminal.show();
      return { state: 'started', host: peer.host, root: peer.root };
    } catch (error) {
      closeTerminal(record);
      throw error;
    }
  }

  async function startJava(peer, approval) {
    assertPeer(peer);
    if (java || starting) throw Error('Close the active SSH Java process first.');
    const owner = generation;
    starting = true;
    let state;
    try {
      const route = await createSshJava({ client: peer, approval, protocol: require('vscode-languageclient/node'),
        onDiagnostics(file, items, version) {
          if (!state || java !== state || currentConnection() !== peer || !vscode.workspace.isTrusted) return;
          const uri = uriFor(peer.authority, file);
          const document = vscode.workspace.textDocuments.find(value => value.uri.toString() === uri.toString());
          if (document?.version !== version) return;
          diagnostics.set(uri, items.flatMap(item => {
            const range = codeRange(item.range);
            return document.validateRange(range).isEqual(range) ? [new vscode.Diagnostic(range, item.message, item.severity - 1)] : [];
          }));
        },
        onExit() { if (state && java === state) clearJava(); } });
      if (owner !== generation || currentConnection() !== peer || !vscode.workspace.isTrusted) {
        route.dispose();
        throw Error('The reviewed SSH workspace changed.');
      }
      state = { peer, route };
      java = state;
      for (const doc of vscode.workspace.textDocuments.filter(value => physicalDocument(value, peer))) synchronize(doc);
      return { state: 'running', host: peer.host, root: peer.root };
    } finally { starting = false; }
  }

  function synchronize(document) {
    const current = java;
    if (current && physicalDocument(document, current.peer) && currentConnection() === current.peer && vscode.workspace.isTrusted) {
      void current.route.synchronize(asSnapshot(document)).catch(() => {});
    }
  }

  async function find(document, position, cancellation, method) {
    const current = java;
    if (!current || !physicalDocument(document, current.peer)) return undefined;
    assertPeer(current.peer);
    const snapshot = asSnapshot(document);
    const result = await current.route[method](snapshot, { line: position.line, character: position.character }, cancellation);
    if (java === current && !document.isClosed && document.version === snapshot.version && !cancellation?.isCancellationRequested) return result;
  }

  const selector = { scheme: uriScheme, language: 'java' };
  subscriptions.push(vscode.languages.registerHoverProvider(selector, { async provideHover(document, position, token) {
    const result = await find(document, position, token, 'hover').catch(() => undefined);
    return result ? new vscode.Hover(new vscode.MarkdownString().appendText(result)) : undefined;
  } }), vscode.languages.registerDefinitionProvider(selector, { async provideDefinition(document, position, token) {
    const found = await find(document, position, token, 'definition').catch(() => undefined);
    return found?.map(item => new vscode.Location(uriFor(document.uri.authority, item.file), codeRange(item.range)));
  } }), vscode.workspace.onDidOpenTextDocument(synchronize), vscode.workspace.onDidCloseTextDocument(document => {
    const current = java;
    if (current && physicalDocument(document, current.peer)) {
      diagnostics.delete(document.uri);
      void current.route.closeDocument(document.uri.path).catch(() => {});
    }
  }));

  subscriptions.push(command('terminal', async () => {
    const peer = currentConnection();
    assertPeer(peer);
    const plan = await peer.inspectProcess('terminal');
    const approved = await vscode.window.showWarningMessage('Open an interactive shell on this SSH host?', {
      modal: true, detail: plan.user + '@' + plan.host + ':' + plan.port + '\n' + plan.root
    }, 'Open SSH Terminal');
    if (approved) return startTerminal(peer, { token: plan.token, allowRemoteProcess: true });
  }), command('javaStart', async () => {
    const peer = currentConnection();
    assertPeer(peer);
    const javaHome = await vscode.window.showInputBox({ title: 'Remote Independent JDK Directory' });
    if (!javaHome) return;
    const serverPath = await vscode.window.showInputBox({ title: 'Remote Eclipse JDT LS Directory' });
    if (!serverPath) return;
    const plan = await peer.inspectProcess('java', { javaHome, serverPath });
    const approved = await vscode.window.showWarningMessage('Start Java analysis on this SSH host?', {
      modal: true, detail: plan.user + '@' + plan.host + ':' + plan.port + '\n' + plan.root + '\nJDK ' + plan.jdk
    }, 'Start SSH Java');
    if (approved) return startJava(peer, { token: plan.token, allowRemoteProcess: true });
  }), command('javaStop', () => java?.route.stop()));

  return {
    inspect: (kind, requested) => { const peer = currentConnection(); assertPeer(peer); return peer.inspectProcess(kind, requested); },
    startTerminal: approval => startTerminal(currentConnection(), approval),
    startJava: approval => startJava(currentConnection(), approval),
    javaStatus: () => java ? { state: 'running' } : { state: 'none' },
    terminalStatus: () => terminal ? { state: 'running' } : { state: 'none' },
    retire() { generation++; clearJava(); closeTerminal(terminal); },
    dispose() {
      this.retire();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

module.exports = { registerSshProcesses };
