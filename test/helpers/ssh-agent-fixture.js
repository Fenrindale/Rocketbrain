'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Transform } = require('node:stream');
const { AgentProtocol, utils } = require('ssh2');
const { KIND, ROOT } = require('../../scripts/connection-security-fixture');

const agentExtension = 27;
const agentFailurePacket = Buffer.from([0, 0, 0, 1, 5]);

function acceptAgentMessages(socket) {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, finish) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(0);
        if (!length || length > 8192) return finish(Error('Unexpected owned SSH agent frame size'));
        if (pending.length < 4 + length) break;
        const frame = pending.subarray(0, 4 + length);
        pending = pending.subarray(4 + length);
        // This disposable agent does not implement the OpenSSH session-bind extension.
        if (frame[4] === agentExtension) socket.write(agentFailurePacket);
        else this.push(frame);
      }
      finish();
    }
  });
}

async function ownedAgent(folder) {
  const actual = await fs.realpath(folder), parent = await fs.realpath(ROOT);
  const marker = JSON.parse(await fs.readFile(path.join(actual, 'owner.json'), 'utf8'));
  assert.equal(path.dirname(actual), parent);
  assert.equal(marker.kind, KIND);
  assert.equal(marker.id, path.basename(actual));
  const keyFiles = ['ssh-wrong', 'ssh-client'], selected = 1;
  const keys = await Promise.all(keyFiles.map(async name => utils.parseKey(await fs.readFile(path.join(actual, name)))));
  assert.ok(keys.every(key => !(key instanceof Error) && key.type === 'ssh-ed25519'));
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\rocketbrain-ssh-agent-' + randomBytes(8).toString('hex')
    : path.join(os.tmpdir(), 'rocketbrain-agent-' + randomBytes(8).toString('hex') + '.sock');
  const requests = [], connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    const messages = acceptAgentMessages(socket), agent = new AgentProtocol(false);
    socket.on('close', () => connections.delete(socket));
    for (const stream of [socket, messages, agent]) stream.on('error', () => socket.destroy());
    agent.on('identities', request => {
      requests.push({ action: 'list', count: keys.length });
      agent.getIdentitiesReply(request, keys);
    });
    agent.on('sign', (request, key, data) => {
      const index = keys.findIndex(value => value.getPublicSSH().equals(key.getPublicSSH()));
      requests.push({ action: 'sign', index });
      if (index < 0) agent.failureReply(request);
      else agent.signReply(request, keys[index].sign(data));
    });
    socket.pipe(messages).pipe(agent).pipe(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  return {
    endpoint, requests, selected,
    publicKeyPath: path.join(actual, keyFiles[selected] + '.pub'),
    otherKeyPath: path.join(actual, keyFiles[0] + '.pub'),
    privateKeyPath: path.join(actual, keyFiles[selected]),
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

module.exports = { ownedAgent };
