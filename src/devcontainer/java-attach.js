'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

const debugType = 'rocketbrain-java';
const attachMarker = '__rocketbrainManagedContainerAttach';
const permits = new Map();

function assertManagedAttach(configuration, folder) {
  if (!configuration || !Object.hasOwn(configuration, attachMarker)) return;
  const record = permits.get(configuration[attachMarker]);
  if (!record || configuration.request !== 'attach' || configuration.type !== debugType ||
      configuration.hostName !== record.forward.host || configuration.port !== record.forward.localPort ||
      !Array.isArray(configuration.sourcePaths) || configuration.sourcePaths.length !== 1 ||
      typeof configuration.sourcePaths[0] !== 'string' ||
      path.relative(record.forward.sourceRoot, configuration.sourcePaths[0]) ||
      folder?.uri.scheme !== 'file' || path.relative(record.folder.uri.fsPath, folder.uri.fsPath)) {
    throw Error('Open a current reviewed Java attach from its managed Dev Container.');
  }
}

function deadline(task, milliseconds, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); });
  return Promise.race([task, expired]).finally(() => clearTimeout(timer));
}

function createManagedJavaAttach({ debug, openForward, closeForward, ready, launchTimeout = 20000 }) {
  const sessions = new Map();
  let disposed = false;

  function release(record) {
    if (record.released) return record.released;
    record.released = Promise.resolve().then(() => closeForward(record.root, record.forward.id)).catch(() => {});
    sessions.delete(record.marker);
    permits.delete(record.marker);
    return record.released;
  }

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
      if (disposed || approval?.allowContainerDebugging !== true || typeof approval.token !== 'string') {
        throw Error('Review and approve the managed JVM attach first.');
      }
      if (folder?.uri.scheme !== 'file' || path.relative(folder.uri.fsPath, root)) {
        throw Error('Choose the exact mounted local Java workspace.');
      }
      await ready();
      if (disposed) throw Error('The managed JVM attach service is closed.');
      const forward = await openForward(root, { token: approval.token, allowLoopbackAccess: true });
      if (disposed || !forward.sourceRoot || !forward.containerRoot || forward.host !== '127.0.0.1') {
        await Promise.resolve().then(() => closeForward(root, forward.id)).catch(() => {});
        throw Error('Use a current reviewed Java attach forward.');
      }
      const marker = randomUUID();
      let startSession;
      const started = new Promise(resolve => { startSession = resolve; });
      const record = { root, folder, forward, marker, started: startSession };
      sessions.set(marker, record);
      permits.set(marker, record);
      const configuration = { type: debugType, request: 'attach', name: 'Rocketbrain: Attach Managed Container JVM',
        hostName: forward.host, port: forward.localPort, sourcePaths: [forward.sourceRoot], [attachMarker]: marker };
      try {
        const session = await deadline((async () => {
          if (!await debug.startDebugging(folder, configuration)) throw Error('VS Code did not start the managed Java attach.');
          return started;
        })(), launchTimeout, 'The managed Java debugger did not start before its local port was released.');
        return { state: 'started', sessionId: session.id, containerId: forward.containerId, sourceRoot: forward.sourceRoot };
      } catch (error) {
        if (record.session) void Promise.resolve(debug.stopDebugging(record.session)).catch(() => {});
        await release(record);
        throw error;
      }
    },
    dispose() {
      disposed = true;
      startListener.dispose();
      stopListener.dispose();
      for (const record of sessions.values()) {
        if (record.session) void Promise.resolve(debug.stopDebugging(record.session)).catch(() => {});
        void release(record);
      }
    }
  };
}

module.exports = { createManagedJavaAttach, assertManagedAttach };
