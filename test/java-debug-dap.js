'use strict';
const net = require('node:net');

class DapClient {
  constructor(port) {
    this.socket = net.connect({ host: '127.0.0.1', port }); this.seq = 0; this.pending = new Map(); this.events = []; this.buffer = Buffer.alloc(0);
    this.ready = new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    this.socket.on('error', error => this.fail(error)); this.socket.on('close', () => this.fail(new Error('DAP connection closed.')));
    this.socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        const length = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString());
        if (!length) return this.fail(new Error('Invalid DAP header.'));
        const count = Number(length[1]); if (this.buffer.length < end + 4 + count) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + count).toString()); this.buffer = this.buffer.subarray(end + 4 + count);
        if (message.type === 'response') {
          const pending = this.pending.get(message.request_seq); if (!pending) continue;
          this.pending.delete(message.request_seq); clearTimeout(pending.timer);
          if (message.success) pending.resolve(message.body); else pending.reject(new Error(`${message.command}: ${message.message || JSON.stringify(message.body)}`));
        } else if (message.type === 'event') this.events.push(message);
        else if (message.type === 'request') this.write({ seq: ++this.seq, type: 'response', request_seq: message.seq, command: message.command, success: false, message: 'Test client has no terminal.' });
      }
    });
  }
  fail(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  write(message) { const body = Buffer.from(JSON.stringify(message)); this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); }
  async request(command, args = {}, timeout = 60000) {
    await this.ready; const seq = ++this.seq;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`DAP timeout: ${command}`)); }, timeout); this.pending.set(seq, { resolve, reject, timer }); this.write({ seq, type: 'request', command, arguments: args }); });
  }
  async event(name, after = 0, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const found = this.events.slice(after).find(event => event.event === name); if (found) return found.body; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`DAP event timeout: ${name}; ${JSON.stringify(this.events.slice(-8))}`);
  }
  async close() { if (!this.socket.destroyed) { try { await this.request('disconnect', { terminateDebuggee: true }, 3000); } catch {} this.socket.destroy(); } }
}

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
module.exports = { DapClient, freePort };
