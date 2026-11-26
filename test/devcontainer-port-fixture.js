'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

async function openFixtureForward(service, root, containerPort, localPort = 0) {
  const review = await service.inspectPort(root, { containerPort, localPort });
  const forward = await service.forwardPort(root, { token: review.token, allowLoopbackAccess: true });
  assert.equal(forward.host, '127.0.0.1');
  assert.equal(forward.containerId, review.containerId);
  assert.equal(forward.containerPort, containerPort);
  assert.ok(forward.localPort > 0);
  return forward;
}

function connect(forward) {
  const socket = net.createConnection({ host: forward.host, port: forward.localPort });
  socket.setTimeout(10000, () => socket.destroy(Error('Timed out reading the fixture forward')));
  socket.on('error', () => {});
  return socket;
}

async function checkHttp(forward) {
  const stop = AbortSignal.timeout(10000);
  const response = await fetch('http://' + forward.host + ':' + forward.localPort + '/ready', {
    signal: stop, redirect: 'error', headers: { connection: 'close' }
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'rocketbrain-container-http\n');
}

async function attachJdwp(forward) {
  const socket = connect(forward);
  try {
    await once(socket, 'connect');
    const iterator = socket.iterator({ destroyOnReturn: false });
    let buffer = Buffer.alloc(0);
    async function read(length) {
      while (buffer.length < length) {
        const chunk = await iterator.next();
        if (chunk.done) throw Error('The forwarded JDWP stream closed.');
        buffer = Buffer.concat([buffer, chunk.value]);
      }
      const data = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return data;
    }
    const handshake = Buffer.from('JDWP-Handshake');
    socket.write(handshake);
    assert.deepEqual(await read(handshake.length), handshake);
    const request = Buffer.from([0, 0, 0, 11, 0, 0, 0, 1, 0, 1, 1]);
    socket.write(request); // VirtualMachine.Version
    let version;
    for (let i = 0; i < 8 && !version; i++) {
      const header = await read(11);
      const length = header.readUInt32BE(0);
      assert.ok(length >= 11 && length <= 16384, 'Bound the fixture JDWP response');
      const body = await read(length - 11);
      if (header[8] !== 0x80 || header.readUInt32BE(4) !== 1) continue;
      assert.equal(header.readUInt16BE(9), 0);
      const descriptionBytes = body.readUInt32BE(0);
      assert.ok(descriptionBytes > 0 && descriptionBytes < body.length - 4);
      version = body.subarray(4, 4 + descriptionBytes).toString('utf8');
    }
    assert.match(version, /Java Debug Wire Protocol|JDWP/u);
    await iterator.return();
    return { socket, close: new Promise(resolve => socket.once('close', resolve)) };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function waitForReleasedPort(forward) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const socket = connect(forward);
    try {
      await once(socket, 'connect');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') return;
      throw error;
    } finally {
      socket.destroy();
    }
    await delay(100);
  }
  assert.fail('The exact forward kept accepting local connections after it should have closed.');
}

module.exports = { openFixtureForward, checkHttp, attachJdwp, waitForReleasedPort };
