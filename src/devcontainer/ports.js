'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const loopback = '127.0.0.1';
const healthInterval = 1000;
const clientLimit = 8;
const clientIdleTimeout = 30 * 60 * 1000;
const offerLifetime = 2 * 60 * 1000;
const bridgeCheck = 'import socket, sys, threading; assert sys.platform == "linux"';
const bridgeSource = `import os, socket, sys, threading, time

with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=3) as remote:
    remote.settimeout(1)
    closed_input = threading.Event()
    write_deadline = [0]

    def send_input():
        try:
            while True:
                data = os.read(0, 32768)
                if not data:
                    remote.shutdown(socket.SHUT_WR)
                    write_deadline[0] = time.monotonic() + 10
                    closed_input.set()
                    return
                remote.sendall(data)
        except OSError:
            remote.close()

    threading.Thread(target=send_input, daemon=True).start()
    while not closed_input.is_set() or time.monotonic() < write_deadline[0]:
        try:
            data = remote.recv(32768)
        except socket.timeout:
            continue
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
`;

function checkedPorts(input) {
  const { localPort = 0, containerPort } = input || {};
  if (!Number.isInteger(localPort) || (localPort !== 0 && localPort < 1024) || localPort > 65535) {
    throw Error('Choose an available local port from 1024 to 65535, or use 0 for an automatic port.');
  }
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw Error('Choose a container TCP port from 1 to 65535.');
  }
  return { localPort, containerPort };
}

function bridgeArgs(id, port, checkOnly = false) {
  const command = ['container', 'exec', '--interactive', id, 'python3', '-I', '-S', '-u', '-c'];
  return checkOnly ? [...command, bridgeCheck] : [...command, bridgeSource, String(port)];
}

function spawnBridge(target, id, port) {
  return spawn(target.docker, ['--host=' + target.host, ...bridgeArgs(id, port)], {
    cwd: target.root, env: target.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failure = () => reject(Error('The requested IPv4 loopback port could not be opened.'));
    server.once('error', failure);
    server.listen({ host: loopback, port, exclusive: true, backlog: clientLimit }, () => {
      server.removeListener('error', failure);
      resolve(server.address().port);
    });
  });
}

function createPortForwards({ startBridge = spawnBridge, observe, healthy }) {
  const offers = new Map();
  const active = new Map();
  let disposed = false;

  function list(key) {
    return [...active.values()].filter(forward => forward.key === key && forward.ready).map(forward => ({ ...forward.reply }));
  }

  function atCapacity(key) {
    return active.size >= 12 || [...active.values()].filter(forward => forward.key === key).length >= 4;
  }

  function close(forward) {
    if (forward.closed) return;
    forward.closed = true;
    active.delete(forward.id);
    clearInterval(forward.timer);
    if (forward.server.listening) forward.server.close();
    for (const client of forward.clients) client.destroy();
  }

  async function verify(forward) {
    if (forward.closed || disposed) throw Error('The port forward is closed.');
    try {
      await healthy(forward.binding);
      if (forward.closed || disposed) throw Error('The port forward is closed.');
    } catch {
      close(forward);
      throw Error('The verified container or workspace is no longer available.');
    }
  }

  async function relay(forward, client) {
    if (forward.clients.size >= clientLimit || forward.closed || client.remoteAddress !== loopback) {
      client.destroy();
      return;
    }
    forward.clients.add(client);
    let bridge, closed = false;
    client.on('error', () => client.destroy());
    client.setTimeout(clientIdleTimeout, () => client.destroy());
    client.once('close', () => {
      closed = true;
      forward.clients.delete(client);
      if (!bridge || bridge.exitCode !== null) return;
      bridge.stdin.end();
      const cleanup = setTimeout(() => bridge.kill(), 2000);
      cleanup.unref();
      bridge.once('close', () => clearTimeout(cleanup));
    });
    try {
      await verify(forward);
      if (closed) return;
      const { target, containerId } = forward.binding;
      bridge = startBridge(target, containerId, forward.reply.containerPort);
      bridge.once('error', () => client.destroy());
      bridge.stdin.on('error', () => client.destroy());
      bridge.stdout.on('error', () => client.destroy());
      bridge.once('close', code => {
        if (code !== 0) client.destroy();
      });
      await verify(forward);
      if (closed) return;
      bridge.stdout.pipe(client);
      client.pipe(bridge.stdin);
    } catch {
      client.destroy();
    }
  }

  function watch(forward) {
    let checking = false;
    forward.timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { await verify(forward); } catch { /* The invalid forward is already closed. */ }
      finally { checking = false; }
    }, healthInterval);
    forward.timer.unref();
  }

  return {
    async inspect(key, binding, requested) {
      if (disposed) throw Error('The Dev Container port forwarding service is closed.');
      const ports = checkedPorts(requested);
      await observe(binding);
      if (disposed) throw Error('The Dev Container port forwarding service is closed.');
      const now = Date.now();
      for (const [id, offer] of offers) if (offer.expires <= now) offers.delete(id);
      while (offers.size >= 12) offers.delete(offers.keys().next().value);
      const token = randomUUID();
      const reply = { token, containerId: binding.containerId, host: loopback, ...ports,
        ...(binding.attachedSource && { containerRoot: binding.attachedSource.containerRoot, sourceRoot: binding.attachedSource.sourceRoot }) };
      offers.set(token, { key, binding, reply, expires: now + offerLifetime });
      return { ...reply };
    },
    async open(key, confirmation) {
      if (disposed || confirmation?.allowLoopbackAccess !== true) throw Error('Review and approve the local loopback forward first.');
      const offer = offers.get(confirmation.token);
      if (offer?.key !== key || offer.expires <= Date.now()) throw Error('Open a current port forwarding review for this workspace.');
      offers.delete(confirmation.token);
      if (atCapacity(key)) throw Error('Close an existing Dev Container port forward first.');
      await observe(offer.binding);
      if (disposed || atCapacity(key)) {
        throw Error('A new Dev Container port forward could not be opened.');
      }
      const forward = { id: randomUUID(), key, binding: offer.binding, clients: new Set() };
      const { token, ...reply } = offer.reply;
      forward.reply = { ...reply, id: forward.id };
      forward.server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, client => {
        if (!forward.ready) client.destroy();
        else void relay(forward, client);
      });
      forward.server.on('error', () => close(forward));
      active.set(forward.id, forward);
      try {
        forward.reply.localPort = await listen(forward.server, reply.localPort);
        if (forward.closed) {
          forward.server.close();
          throw Error('The port forward was closed before it could open.');
        }
        await verify(forward);
        forward.ready = true;
        watch(forward);
        return { ...forward.reply };
      } catch (error) {
        close(forward);
        throw error;
      }
    },
    list,
    close(key, id) {
      const forward = active.get(id);
      if (forward?.key !== key) throw Error('Choose a current port forward for this workspace.');
      close(forward);
    },
    closeWorkspace(key) {
      for (const forward of active.values()) if (forward.key === key) close(forward);
      for (const [token, offer] of offers) if (offer.key === key) offers.delete(token);
    },
    dispose() {
      disposed = true;
      for (const forward of active.values()) close(forward);
      offers.clear();
    }
  };
}

module.exports = { bridgeArgs, createPortForwards };
