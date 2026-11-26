'use strict';

const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sessionId = 'owned-workspace-edit';
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (msg.params.clientCapabilities.fs.readTextFile || msg.params.clientCapabilities.terminal) process.exit(2);
    send({ id: msg.id, result: { protocolVersion: 1 } });
  }
  if (msg.method === 'session/new') {
    if (msg.params.mcpServers.length || !msg.params.cwd.includes('rocketbrain-db-acp-')) process.exit(2);
    send({ id: msg.id, result: { sessionId } });
  }
  if (msg.method === 'session/prompt') {
    const answer = { summary: 'Change the reviewed literals.', edits: [
      { id: 'file1', find: '"old-one"', replace: '"new-one"' }, { id: 'file2', find: '"old-two"', replace: '"new-two"' }
    ] };
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: JSON.stringify(answer) } } } });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
