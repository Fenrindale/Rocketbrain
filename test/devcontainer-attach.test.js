'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const { test } = require('node:test');
const { createManagedJavaAttach, assertManagedAttach } = require('../src/devcontainer/java-attach');

function fixture({ launch = 'success', attached = true, localRoute = true } = {}) {
  const root = process.cwd();
  const folder = { uri: { scheme: 'file', fsPath: root } };
  const events = new EventEmitter();
  const markers = { opens: [], closes: [], stops: [], configuration: undefined, session: undefined };
  function event(name) {
    return callback => {
      events.on(name, callback);
      return { dispose() { events.off(name, callback); } };
    };
  }
  const manager = createManagedJavaAttach({
    debug: {
      onDidStartDebugSession: event('started'), onDidTerminateDebugSession: event('ended'),
      async startDebugging(workspace, configuration) {
        assert.equal(workspace, folder);
        assertManagedAttach(configuration, folder);
        markers.configuration = configuration;
        if (launch === 'refused') return false;
        const session = { type: configuration.type, workspaceFolder: workspace, configuration, id: 'owned-session' };
        markers.session = session;
        if (launch === 'success') events.emit('started', session);
        return true;
      },
      async stopDebugging(session) { markers.stops.push(session.id); }
    },
    async ready() { if (!localRoute) throw Error('Local Java unavailable'); },
    async openForward(_root, confirmation) {
      markers.opens.push(confirmation);
      return { id: 'owned-port', host: '127.0.0.1', localPort: 12430, containerId: 'container',
        ...(attached && { sourceRoot: root, containerRoot: '/workspaces/fixture' }) };
    },
    async closeForward(_root, id) { markers.closes.push(id); },
    launchTimeout: 80
  });
  return { manager, root, folder, markers, events };
}

const approved = { token: 'owned-fixture-review', allowContainerDebugging: true };

test('Managed Java attach binds the exact native session, loopback and sources and releases on its own termination', async context => {
  const { manager, root, folder, markers, events } = fixture();
  context.after(() => manager.dispose());
  assert.doesNotThrow(() => assertManagedAttach({ request: 'launch', type: 'rocketbrain-java' }, folder));
  await assert.rejects(manager.start(root, folder, { token: approved.token }), /Review and approve/);
  assert.deepEqual(markers.opens, []);
  assert.deepEqual(await manager.start(root, folder, approved),
    { state: 'started', sessionId: 'owned-session', containerId: 'container', sourceRoot: root });
  assert.deepEqual(markers.opens, [{ token: approved.token, allowLoopbackAccess: true }]);
  assert.throws(() => assertManagedAttach({ ...markers.configuration, hostName: 'localhost' }, folder), /reviewed Java attach/);
  assert.throws(() => assertManagedAttach({ ...markers.configuration, sourcePaths: [] }, folder), /reviewed Java attach/);
  events.emit('ended', { ...markers.session, id: 'other-session' });
  await setImmediate();
  assert.deepEqual(markers.closes, []);
  events.emit('ended', markers.session);
  events.emit('ended', markers.session);
  await setImmediate();
  assert.deepEqual(markers.closes, ['owned-port']);
  assert.throws(() => assertManagedAttach(markers.configuration, folder), /reviewed Java attach/);
});

test('Managed attach releases ports on refusal, an unobserved session, or a mismatched forward', async context => {
  for (const [options, message] of [[{ launch: 'refused' }, /did not start/], [{ launch: 'quiet' }, /before its local port/],
    [{ attached: false }, /reviewed Java attach forward/], [{ localRoute: false }, /Local Java unavailable/]]) {
    const { manager, root, folder, markers } = fixture(options);
    context.after(() => manager.dispose());
    await assert.rejects(manager.start(root, folder, approved), message);
    assert.deepEqual(markers.closes, options.localRoute === false ? [] : ['owned-port']);
    if (markers.configuration) assert.throws(() => assertManagedAttach(markers.configuration, folder), /reviewed Java attach/);
  }
});
