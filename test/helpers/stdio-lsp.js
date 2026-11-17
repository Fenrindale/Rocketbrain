'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

class StdioLsp {
  constructor(launch) {
    this.process = spawn(launch.command, launch.args, { ...launch.options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.id = 0; this.pending = new Map(); this.notifications = []; this.buffer = Buffer.alloc(0); this.stderr = '';
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    this.process.stdout.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        const length = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString());
        if (!length) throw new Error('Unexpected JDT LS protocol header.');
        const count = Number(length[1]); if (this.buffer.length < end + 4 + count) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + count).toString());
        this.buffer = this.buffer.subarray(end + 4 + count);
        if (message.method && message.id !== undefined) {
          const result = message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null;
          this.write({ jsonrpc: '2.0', id: message.id, result });
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id); if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
        } else this.notifications.push(message);
      }
    });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', code => this.fail(new Error(`JDT LS exited: ${code}\n${this.stderr}`)));
  }
  fail(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  write(message) { const body = Buffer.from(JSON.stringify(message)); this.process.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeout = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP timeout: ${method}\n${this.stderr}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  async close() {
    try { await this.request('shutdown', null, 5000); this.notify('exit'); } catch { /* Terminate an unresponsive test server below. */ }
    await new Promise(resolve => { if (this.process.exitCode !== null) return resolve(); const timer = setTimeout(() => { this.process.kill(); resolve(); }, 3000); this.process.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}

function positionOf(text, needle, extra = 0) {
  const index = text.indexOf(needle); assert.ok(index >= 0, `Missing marker ${needle}`);
  const lines = text.slice(0, index + extra).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length };
}
async function until(check, timeout = 90000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await check(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 600)); }
  throw last || new Error('Timed out waiting for the Java engine result.');
}

module.exports = { StdioLsp, positionOf, until };
