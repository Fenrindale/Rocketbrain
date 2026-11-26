'use strict';

const { randomUUID } = require('node:crypto');
const { DEBUG_TYPE } = require('./debug');
const { COROUTINE_BUILD } = require('./debug-runtime');

const REQUEST = 'rocketbrain/watchKotlinCoroutine';
const FRAME_EVENT = 'rocketbrainCoroutineFrame';
const EXPIRED_EVENT = 'rocketbrainCoroutineWatchExpired';

async function bounded(work, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([work,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

function coroutineDebugger(vscode, java, { trusted, resolveSource, report, reveal }) {
  let attached, watching, stopped, closed = false, revision = 0;
  const launches = new Map();

  async function stop(session) {
    const message = 'The Kotlin debugger detach has not completed.';
    if (!java.debug.verifiedLocalPid(session)) return bounded(vscode.debug.stopDebugging(session), 10000, message);
    let listener;
    const terminated = new Promise(resolve => {
      listener = vscode.debug.onDidTerminateDebugSession(ended => { if (ended.id === session.id) resolve(); });
    });
    try {
      // The adapter may close its transport before replying to disconnect.
      void session.customRequest('disconnect', { terminateDebuggee: false }).catch(() => {});
      await bounded(terminated, 10000, message);
    } finally {
      listener.dispose();
    }
  }

  const subscriptions = [
    vscode.debug.onDidStartDebugSession(session => {
      const intent = launches.get(session.name);
      if (!intent || session.type !== DEBUG_TYPE || session.configuration.request !== 'attach') return;
      intent.session = session;
      if (closed || intent.cancelled) void stop(session).catch(() => {});
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      if (attached?.session.id !== session.id) return;
      attached = watching = stopped = undefined;
      report('Kotlin debugger detached.');
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
      const selected = watching;
      if (!selected || event.session.id !== selected.session.id || event.body?.watch !== selected.watch) return;
      if (event.event === EXPIRED_EVENT) {
        watching = undefined;
        report('The selected continuation did not resume within 45 seconds.');
      } else if (event.event === FRAME_EVENT) {
        void showLiveFrame(selected, event.body).catch(error => {
          if (watching === selected) watching = undefined;
          report(error.message);
        });
      }
    })
  ];

  async function showLiveFrame(selection, body) {
    const { session, debugFrame } = selection;
    if (body.sequence !== debugFrame.sequence || body.className !== debugFrame.className ||
        body.file !== debugFrame.file || body.parkedLine !== debugFrame.line ||
        !Number.isSafeInteger(body.threadId) || body.threadId < 1 ||
        !Number.isInteger(body.line) || body.line < 1) throw Error('The live Kotlin frame did not match its reviewed continuation.');
    let paused;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (watching !== selection) return;
      trusted();
      paused = java.debug.getState(session.id);
      if (paused?.state === 'stopped' && paused.threadId === body.threadId) break;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    if (paused?.state !== 'stopped' || paused.threadId !== body.threadId) throw Error('The selected Kotlin debug thread is no longer paused.');
    const stack = await bounded(session.customRequest('stackTrace', { threadId: body.threadId, startFrame: 0, levels: 1 }),
      5000, 'The Kotlin debug adapter did not return its live stack frame.');
    const frame = stack?.stackFrames?.[0];
    const current = java.debug.getState(session.id);
    if (watching !== selection || current?.state !== 'stopped' || current.threadId !== body.threadId ||
        current.stopVersion !== paused.stopVersion || current.resuming !== undefined ||
        frame?.line !== body.line || !String(frame.name).includes('invokeSuspend') || !Number.isSafeInteger(frame.id) || frame.id < 1) {
      throw Error('The selected Kotlin debug frame changed before it could be opened.');
    }
    const live = { state: 'stopped', sessionId: session.id, threadId: body.threadId, frameId: frame.id, stopVersion: current.stopVersion,
      file: body.file, line: body.line, parkedLine: body.parkedLine, sequence: body.sequence };
    await reveal(selection.source, live, () => getFrame(session, live));
    if (getFrame(session, live)) {
      stopped = live;
      report('Paused at the selected Kotlin continuation as it resumed.');
    }
    if (watching === selection) watching = undefined;
  }

  function getFrame(session = attached?.session, frame = stopped) {
    if (!frame || session?.id !== frame.sessionId) return undefined;
    const state = java.debug.getState(session.id);
    if (state?.state !== 'stopped' || state.threadId !== frame.threadId || state.stopVersion !== frame.stopVersion ||
        state.resuming !== undefined) return undefined;
    return frame;
  }

  async function attach(descriptor, source, check) {
    if (attached) {
      if (attached.descriptor.session !== descriptor.session || attached.descriptor.pid !== descriptor.pid ||
          attached.descriptor.debugPort !== descriptor.debugPort) throw Error('Detach the current Kotlin debugger before connecting another JVM.');
      return attached.session;
    }
    await bounded(java.start(), 30000, 'The Java debug engine did not start in time.');
    check();
    if (java.getState().debugBuild !== COROUTINE_BUILD) throw Error('Install or update the Rocketbrain Java debugger for Kotlin continuation attach.');
    const reviewed = await java.debug.processes.resolve(descriptor.pid);
    if (reviewed.hostName !== '127.0.0.1' || reviewed.port !== descriptor.debugPort) {
      throw Error('The selected JVM no longer owns its approved Kotlin debug listener.');
    }
    check();
    const name = 'Kotlin coroutine JVM ' + descriptor.pid + ' · ' + randomUUID().slice(0, 8);
    const intent = { name, cancelled: false };
    launches.set(name, intent);
    try {
      const started = await bounded(java.debug.processes.attach(reviewed, {
        name, folder: source.folder, sourcePaths: [source.root]
      }), 30000, 'The Kotlin JVM attach did not start in time.');
      if (!started) throw Error('The local Kotlin JVM declined the Java debugger attach.');
      for (let attempt = 0; attempt < 80; attempt++) {
        check();
        if (intent.session && java.debug.verifiedLocalPid(intent.session) === descriptor.pid) break;
        await new Promise(resolve => setTimeout(resolve, 125));
      }
      if (!intent.session || java.debug.verifiedLocalPid(intent.session) !== descriptor.pid) {
        throw Error('The attached Java session did not confirm ownership of the selected Kotlin JVM.');
      }
      const verified = await bounded(intent.session.customRequest(REQUEST, {
        action: 'verify', pid: String(descriptor.pid), session: descriptor.session
      }), 5000, 'The Kotlin debugger did not prove its probe session.');
      check();
      if (verified?.verified !== true) throw Error('The Kotlin debugger did not verify the selected probe session.');
      attached = { descriptor, session: intent.session };
      return intent.session;
    } catch (error) {
      intent.cancelled = true;
      if (intent.session) await stop(intent.session).catch(() => {});
      throw error;
    } finally {
      if (intent.cancelled && !intent.session) {
        const timer = setTimeout(() => launches.delete(name), 35000);
        timer.unref();
      } else launches.delete(name);
    }
  }

  async function watchFrame(descriptor, capture, ordinal, debugFrame, check) {
    if (watching) throw Error('Finish waiting for the current Kotlin continuation before selecting another.');
    const generation = revision;
    const current = () => {
      check();
      if (closed || revision !== generation) throw Error('The coroutine debugger attach was cancelled.');
    };
    const source = await resolveSource(debugFrame);
    current();
    if (!source) return;
    const wasAttached = !!attached;
    const session = await attach(descriptor, source, current);
    const watch = randomUUID();
    watching = { watch, session, debugFrame, source };
    stopped = undefined;
    try {
      const result = await bounded(session.customRequest(REQUEST, { action: 'watch', pid: String(descriptor.pid),
        session: descriptor.session, capture, ordinal, watch, ...debugFrame }), 6000,
      'The Kotlin debugger could not arm the selected continuation in time.');
      current();
      if (result?.armed !== true || result.watch !== watch || result.expiresInSeconds !== 45) {
        throw Error('The Kotlin debugger did not arm the selected continuation.');
      }
      if (watching?.watch === watch) report('Waiting for the selected Kotlin continuation to resume.');
      return { state: 'armed', sessionId: session.id, watch, sequence: debugFrame.sequence,
        parkedLine: debugFrame.line, expiresInSeconds: 45 };
    } catch (error) {
      if (watching?.watch === watch) watching = undefined;
      if (!wasAttached) await detach().catch(() => {});
      throw error;
    }
  }

  async function detach() {
    revision++;
    const active = attached;
    watching = stopped = undefined;
    for (const intent of launches.values()) intent.cancelled = true;
    if (active) await stop(active.session);
    if (attached === active) attached = undefined;
    return { state: 'debugger-detached' };
  }

  return { watchFrame, detach, getFrame, async dispose() {
    closed = true;
    await detach().catch(() => {});
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { coroutineDebugger, REQUEST, FRAME_EVENT };
