'use strict';

const maximumFrames = 32;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function createFrameRestart(vscode, { getState, ensureTrusted }) {
  const reviews = new WeakMap();
  const inFlight = new WeakSet();

  function paused(session) {
    ensureTrusted();
    if (!session || session.type !== 'rocketbrain-java' || session.id !== vscode.debug.activeDebugSession?.id) {
      throw Error('Focus a paused Rocketbrain Java session to restart a frame.');
    }
    const state = getState(session.id);
    if (state?.state !== 'stopped' || state.resuming !== undefined || !positiveId(state.threadId)) {
      throw Error('Pause the Java session before restarting a frame.');
    }
    if (state.capabilities?.supportsRestartFrame !== true) {
      throw Error('The active Java debug adapter does not support frame restart.');
    }
    const focused = vscode.debug.activeStackItem;
    if (focused?.session?.id === session.id && focused.threadId !== state.threadId) {
      throw Error('Select a frame on the Java thread that reported the current stop.');
    }
    return { generation: state.stopVersion, threadId: state.threadId };
  }

  function verify(session, previous) {
    const current = paused(session);
    if (current.generation !== previous.generation || current.threadId !== previous.threadId) {
      throw Error('The Java debugger stopped at a different position. Choose a new stack frame.');
    }
  }

  async function inspect(session = vscode.debug.activeDebugSession) {
    const stop = paused(session);
    const result = await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: maximumFrames + 1 });
    verify(session, stop);
    const stackFrames = result?.stackFrames;
    if (!Array.isArray(stackFrames) || stackFrames.length > maximumFrames + 1) {
      throw Error('The debug adapter did not provide a bounded Java call stack.');
    }
    // JDI cannot pop the bottom frame. Require a returned caller for each offered frame.
    const frames = stackFrames.slice(0, -1).filter(frame => positiveId(frame?.id) &&
      typeof frame.name === 'string' && frame.name.trim() && frame.name.length <= 512).map(frame => Object.freeze({
      id: frame.id, label: frame.name.replace(/\s+/g, ' ').trim(), line: positiveId(frame.line) ? frame.line : undefined
    }));
    const report = Object.freeze({ frames: Object.freeze(frames) });
    reviews.set(report, { session, stop });
    return report;
  }

  async function restart(report, frameId) {
    const review = reviews.get(report);
    const frame = review && report.frames.find(choice => choice.id === frameId);
    if (!frame) throw Error('Choose a frame from the current Java call stack.');
    const { session, stop } = review;
    verify(session, stop);
    if (inFlight.has(session)) throw Error('A Java frame restart is already in progress.');
    reviews.delete(report);
    inFlight.add(session);
    try {
      await session.customRequest('restartFrame', { frameId: frame.id });
      return frame;
    } finally { inFlight.delete(session); }
  }

  async function choose() {
    const report = await inspect();
    if (!report.frames.length) throw Error('The paused Java stack has no frame with a caller.');
    const selected = await vscode.window.showQuickPick(report.frames.map(frame => ({
      label: frame.label, description: frame.line ? 'Line ' + frame.line : undefined, frameId: frame.id
    })), { title: 'Restart Java Stack Frame', placeHolder: 'Choose the frame to run again. Previous side effects remain.' });
    if (selected) return restart(report, selected.frameId);
  }

  return { inspect, restart, choose };
}

module.exports = { createFrameRestart };
