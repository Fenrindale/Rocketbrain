'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

const debugType = 'rocketbrain-java';
const containerMarker = '__rocketbrainManagedContainerAttach';
const sshMarker = '__rocketbrainManagedSshAttach';
const wslMarker = '__rocketbrainManagedWslAttach';
const routes = {
  container: { marker: containerMarker, approval: 'allowContainerDebugging', targetRoot: 'containerRoot',
    name: 'Rocketbrain: Attach Managed Container JVM', review: 'its managed Dev Container' },
  ssh: { marker: sshMarker, approval: 'allowSshJavaDebug', targetRoot: 'remoteRoot',
    name: 'Rocketbrain: Attach Reviewed SSH JVM', review: 'its verified SSH workspace' },
  wsl: { marker: wslMarker, approval: 'allowWslJavaDebug', targetRoot: 'wslRoot',
    name: 'Rocketbrain: Debug WSL Java', review: 'its reviewed WSL Java launch' }
};
const permits = new Map();

function assertManagedAttach(configuration, folder) {
  if (!configuration) return;
  const selected = Object.values(routes).filter(route => Object.hasOwn(configuration, route.marker));
  if (!selected.length) return;
  const route = selected[0];
  const record = permits.get(configuration[route.marker]);
  if (selected.length !== 1 || !record || record.route !== route || record.forward.isClosed?.() ||
      configuration.request !== 'attach' || configuration.type !== debugType ||
      configuration.hostName !== record.forward.host || configuration.port !== record.forward.localPort ||
      !Array.isArray(configuration.sourcePaths) || configuration.sourcePaths.length !== 1 ||
      typeof configuration.sourcePaths[0] !== 'string' ||
      path.relative(record.forward.sourceRoot, configuration.sourcePaths[0]) ||
      folder?.uri.scheme !== 'file' || path.relative(record.folder.uri.fsPath, folder.uri.fsPath)) {
    throw Error('Open a current reviewed Java attach from ' + route.review + '.');
  }
}

function deadline(task, milliseconds, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); });
  return Promise.race([task, expired]).finally(() => clearTimeout(timer));
}

function createManagedJavaAttach({ debug, openForward, closeForward, ready, kind = 'container', observe, launchTimeout = 20000 }) {
  const route = routes[kind];
  const attachMarker = route.marker;
  const sessions = new Map();
  let disposed = false;

  function release(record) {
    if (record.released) return record.released;
    record.released = Promise.resolve().then(() => closeForward(record.root, record.forward.id)).catch(() => {});
    record.observation?.dispose();
    sessions.delete(record.marker);
    permits.delete(record.marker);
    return record.released;
  }

  function stop(record) {
    if (!record.stopping) record.stopping = (async () => {
      if (record.session) {
        try { await deadline(debug.stopDebugging(record.session), 2800, 'The owned debugger did not stop.'); } catch {}
      }
      await release(record);
    })();
    return record.stopping;
  }

  const stopAll = () => Promise.allSettled([...sessions.values()].map(record => stop(record)));

  function ownsSession(record, session) {
    const cfg = session.configuration;
    return session.type === debugType && session.workspaceFolder?.uri.scheme === 'file' &&
      !path.relative(record.folder.uri.fsPath, session.workspaceFolder.uri.fsPath) && cfg?.request === 'attach' &&
      cfg[attachMarker] === record.marker && cfg.hostName === record.forward.host && cfg.port === record.forward.localPort;
  }

  const startListener = debug.onDidStartDebugSession(session => {
    const record = sessions.get(session.configuration?.[attachMarker]);
    if (!record || !ownsSession(record, session)) return;
    record.session = session;
    record.started(session);
  });
  const stopListener = debug.onDidTerminateDebugSession(session => {
    const record = sessions.get(session.configuration?.[attachMarker]);
    if (record?.session?.id === session.id) void release(record);
  });

  return {
    async start(root, folder, approval) {
      if (disposed || approval?.[route.approval] !== true || typeof approval.token !== 'string') {
        throw Error('Review and approve the managed JVM attach first.');
      }
      if (folder?.uri.scheme !== 'file' || path.relative(folder.uri.fsPath, root)) {
        throw Error('Choose the exact mounted local Java workspace.');
      }
      await ready();
      if (disposed) throw Error('The managed JVM attach service is closed.');
      const forward = await openForward(root, { token: approval.token, allowLoopbackAccess: true,
        ...(kind !== 'container' && { sourceFile: approval.sourceFile }) });
      if (disposed || !forward.sourceRoot || !forward[route.targetRoot] || forward.host !== '127.0.0.1' || forward.isClosed?.()) {
        await Promise.resolve().then(() => closeForward(root, forward.id)).catch(() => {});
        throw Error('Use a current reviewed Java attach forward.');
      }
      const marker = randomUUID();
      let startSession;
      const started = new Promise(resolve => { startSession = resolve; });
      const record = { root, folder, forward, marker, route, started: startSession };
      sessions.set(marker, record);
      permits.set(marker, record);
      const configuration = { type: debugType, request: 'attach', name: route.name,
        hostName: forward.host, port: forward.localPort, sourcePaths: [forward.sourceRoot], [attachMarker]: marker };
      try {
        record.observation = observe?.(forward, () => { void stop(record); });
        const session = await deadline((async () => {
          if (!await debug.startDebugging(folder, configuration)) throw Error('VS Code did not start the managed Java attach.');
          return started;
        })(), launchTimeout, 'The managed Java debugger did not start before its local port was released.');
        if (kind !== 'container' && (record.released || forward.isClosed?.())) throw Error('The reviewed Java attach channel closed.');
        return { state: 'started', sessionId: session.id, sourceRoot: forward.sourceRoot,
          ...({ container: { containerId: forward.containerId }, ssh: { pid: forward.pid, sourceFile: forward.sourceFile },
            wsl: { sourceFile: forward.sourceFile, wslRoot: forward.wslRoot } })[kind] };
      } catch (error) {
        await stop(record);
        throw error;
      }
    },
    stop: stopAll,
    dispose() {
      disposed = true;
      startListener.dispose();
      stopListener.dispose();
      void stopAll();
    }
  };
}

module.exports = { createManagedJavaAttach, assertManagedAttach };
