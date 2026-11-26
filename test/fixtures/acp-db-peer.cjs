'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const [behavior, marker] = process.argv.slice(2);
const sid = 'owned-database-peer';
let active, denied, unavailable;
const writer = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const response = (id, result) => writer({ id, result });

function finish() {
  if (!denied || !unavailable) return;
  const peer = { columns: ['teams.name'], measures: [{ column: 'tickets.id', function: 'COUNT' }],
    sort: [{ key: 'teams.name', direction: 'ASC' }], limit: 20,
    explanation: process.env.ROCKETBRAIN_PRIVATE_ACP_TEST || 'Isolated environment and denied tool requests.' };
  writer({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: JSON.stringify(peer) } } } });
  response(active, { stopReason: 'end_turn' });
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') {
    if (params.protocolVersion !== 1 || params.clientCapabilities.terminal || params.clientCapabilities.fs.readTextFile) process.exit(2);
    response(id, { protocolVersion: 1 });
  }
  if (method === 'session/new') {
    if (params.cwd !== process.cwd() || params.mcpServers.length || !params.cwd.includes('rocketbrain-db-acp-')) process.exit(2);
    response(id, { sessionId: sid });
  }
  if (method === 'session/prompt') {
    active = id;
    if (behavior === 'slow') { fs.writeFileSync(marker, 'started'); return; }
    writer({ id: 'permission', method: 'session/request_permission', params: { sessionId: sid, options: [] } });
    writer({ id: 'terminal', method: 'terminal/create', params: { sessionId: sid } });
  }
  if (id === 'permission') { denied = message.result?.outcome?.outcome === 'cancelled'; finish(); }
  if (id === 'terminal') { unavailable = message.error?.code === -32601; finish(); }
  if (method === 'session/cancel') {
    fs.appendFileSync(marker, ' cancelled');
    response(active, { stopReason: 'cancelled' });
  }
});
