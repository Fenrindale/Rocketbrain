'use strict';
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function sameSource(raw, file) {
  if (typeof raw!=='string') return false;
  try {
    const selected=raw.startsWith('file:') ? fileURLToPath(raw) : raw;
    return path.isAbsolute(selected) && !path.relative(selected,file);
  } catch {return false;}
}

// Own DAP transport: the public Java engine still owns Java/JDI semantics.
class JavaDebugAdapter {
  constructor(vscode, port, observe = () => {}, output, observeRequest = () => {}, kotlinSourceLines, verifiedFieldPort) {
    this.emitter = new vscode.EventEmitter(); this.onDidSendMessage = this.emitter.event;
    this.buffer = Buffer.alloc(0); this.mutations = new Set(); this.disposed = false; this.observe = observe; this.output = output;
    this.observeRequest = observeRequest;
    this.kotlinSourceLines=kotlinSourceLines;
    this.verifiedFieldPort=verifiedFieldPort;
    this.vscode=vscode;
    this.socket = net.connect({ host: '127.0.0.1', port });
    this.socket.on('data', chunk => this.read(chunk));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => { if (!this.disposed) { if (this.terminated) this.dispose(); else this.fail(new Error('Java debugger connection closed.')); } });
  }
  send(message) { this.observe(message); this.emitter.fire(message); }
  fail(error) {
    if (this.disposed) return;
    this.output?.appendLine(`Java debug transport: ${error.message}`);
    this.send({ type: 'event', seq: 0, event: 'output', body: { category: 'stderr', output: `Rocketbrain Java: ${error.message}\n` } });
    this.send({ type: 'event', seq: 0, event: 'terminated', body: {} }); this.dispose();
  }
  read(chunk) {
    if (this.disposed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buffer.length > 8192) this.fail(new Error('Invalid DAP header.')); return; }
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(this.buffer.subarray(0, end).toString('ascii'));
      const count = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(count) || count < 0 || count > 32 * 1024 * 1024) return this.fail(new Error('Invalid DAP payload length.'));
      if (this.buffer.length < end + 4 + count) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + count).toString('utf8')); }
      catch { return this.fail(new Error('Invalid DAP JSON.')); }
      this.buffer = this.buffer.subarray(end + 4 + count);
      if (message.type === 'response' && message.command === 'initialize' && message.success) message = { ...message, body: { ...message.body, supportsSetExpression: true } };
      if (message.type === 'response' && this.mutations.delete(message.request_seq)) {
        message = { ...message, command: 'setExpression', body: message.success ? { value: message.body?.result, type: message.body?.type, variablesReference: message.body?.variablesReference || 0, namedVariables: message.body?.namedVariables, indexedVariables: message.body?.indexedVariables } : message.body };
      }
      if (message.type === 'event' && message.event === 'terminated') this.terminated = true;
      this.send(message);
    }
  }
  handleMessage(message) {
    if (this.disposed) return;
    let outgoing = message;
    if (message.type==='request' && message.command==='attach') {
      const args={...message.arguments};
      const verifiedPort=this.verifiedFieldPort;
      this.verifiedFieldPort=undefined;
      delete args.rocketbrainLocalKotlinFieldValues;
      if (Number.isInteger(verifiedPort) && args.port===verifiedPort && args.hostName==='127.0.0.1') {
        args.rocketbrainLocalKotlinFieldValues=true;
      }
      if (this.kotlinSourceLines) args.rocketbrainKotlinSourceLines=this.kotlinSourceLines;
      outgoing={...message,arguments:args};
    } else if (this.kotlinSourceLines && message.type==='request' &&
        message.command==='setBreakpoints' && this.vscode.workspace.textDocuments.some(document=>
        document.isDirty && document.uri.scheme==='file' && !document.uri.authority &&
        sameSource(message.arguments?.source?.path,document.uri.fsPath))) {
      outgoing={...message,arguments:{...message.arguments,sourceModified:true}};
    }
    if (message.type === 'request' && message.command === 'setExpression') {
      const args = message.arguments || {};
      if (typeof args.expression !== 'string' || !args.expression.trim() || typeof args.value !== 'string' || !Number.isInteger(args.frameId)) {
        this.send({ type: 'response', seq: 0, request_seq: message.seq, command: 'setExpression', success: false, message: 'Java expression mutation requires an expression, value and stopped frameId.' }); return;
      }
      // Only a user-initiated DAP setExpression request reaches this assignment.
      // Java evaluation validates assignability and the target type in that frame.
      this.mutations.add(message.seq);
      outgoing = { ...message, command: 'evaluate', arguments: { expression: `${args.expression} = (${args.value})`, frameId: args.frameId, context: 'repl', format: args.format } };
    }
    this.observeRequest(outgoing);
    const body = Buffer.from(JSON.stringify(outgoing)); this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.mutations.clear(); this.socket.destroy(); this.emitter.dispose(); }
}
module.exports = { JavaDebugAdapter };
