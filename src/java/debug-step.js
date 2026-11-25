'use strict';

const { classFilter } = require('./debug-exceptions');

const filters = ['allowClasses', 'skipClasses', 'classNameFilters'];
const options = ['skipSynthetics', 'skipStaticInitializers', 'skipConstructors'];

function stepFilterFields(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Java stepFilters must be an object.');
  const result = {};
  for (const key of filters) {
    if (!Object.hasOwn(value, key)) continue;
    const patterns = value[key];
    if (!Array.isArray(patterns) || patterns.length > 128 || patterns.some(pattern =>
      typeof pattern !== 'string' || pattern.length > 240 || !(classFilter(pattern.trim()) || pattern.trim() === '*'))) {
      throw Error('Use Java class names or leading/trailing wildcards in ' + key + '.');
    }
    result[key] = [...new Set(patterns.map(pattern => pattern.trim()))];
  }
  for (const key of options) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'boolean') throw Error('Use true or false for ' + key + '.');
    result[key] = value[key];
  }
  return result;
}

function mergeStepFilters(workspace, launch) {
  const result = { ...stepFilterFields(workspace), ...stepFilterFields(launch) };
  if (result.classNameFilters) {
    result.skipClasses = [...new Set([...(result.skipClasses || []), ...result.classNameFilters])];
    delete result.classNameFilters;
  }
  return result;
}

const positiveId = value => Number.isSafeInteger(value) && value > 0;

function stepTargets(response) {
  const targets = response?.targets;
  if (!Array.isArray(targets) || targets.length > 128) return [];
  const choices = new Map();
  for (const item of targets) {
    if (!positiveId(item?.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 1024) continue;
    const coordinates = Object.fromEntries(['line', 'column', 'endLine', 'endColumn'].filter(key => positiveId(item[key]))
      .map(key => [key, item[key]]));
    choices.set(item.id, Object.freeze({ id: item.id, label: item.label.replace(/\s+/g, ' ').trim(), ...coordinates }));
  }
  return [...choices.values()];
}

function createSmartStep(vscode, { getState, ensureTrusted }) {
  const reviews = new WeakMap();

  function paused(session) {
    ensureTrusted();
    if (!session || session.type !== 'rocketbrain-java' || session.id !== vscode.debug.activeDebugSession?.id) {
      throw Error('Focus a paused Rocketbrain Java session to choose a step target.');
    }
    const state = getState(session.id);
    if (state?.state !== 'stopped' || state.resuming !== undefined || !positiveId(state.threadId)) {
      throw Error('Pause the Java session before choosing a step target.');
    }
    if (state.capabilities?.supportsStepInTargetsRequest !== true) throw Error('The active Java debug adapter does not provide step targets.');
    return { generation: state.stopVersion, threadId: state.threadId };
  }

  function verify(session, expected, frameId) {
    const current = paused(session);
    if (current.generation !== expected.generation || current.threadId !== expected.threadId) {
      throw Error('The Java debugger stopped at a different position. Choose a new step target.');
    }
    const focus = vscode.debug.activeStackItem;
    if (focus?.session?.id === session.id && (focus.threadId !== expected.threadId ||
        positiveId(focus.frameId) && focus.frameId !== frameId)) {
      throw Error('Select the top frame of the paused Java thread before choosing a step target.');
    }
  }

  async function inspect(session = vscode.debug.activeDebugSession) {
    const stop = paused(session);
    const response = await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 });
    const frame = response?.stackFrames?.[0];
    if (!positiveId(frame?.id)) throw Error('The paused Java thread has no usable stack frame.');
    verify(session, stop, frame.id);
    const targets = stepTargets(await session.customRequest('stepInTargets', { frameId: frame.id }));
    verify(session, stop, frame.id);
    const report = Object.freeze({ frame: frame.name, line: frame.line, targets: Object.freeze(targets) });
    reviews.set(report, { session, stop, frameId: frame.id });
    return report;
  }

  async function step(report, id) {
    const review = reviews.get(report);
    const choice = review && report.targets.find(item => item.id === id);
    if (!choice) throw Error('Choose a target from the current Java step list.');
    verify(review.session, review.stop, review.frameId);
    reviews.delete(report);
    await review.session.customRequest('stepIn', { threadId: review.stop.threadId, targetId: choice.id });
    return choice;
  }

  async function choose() {
    const report = await inspect();
    if (!report.targets.length) throw Error('There are no selectable Java calls at the current stop.');
    const choice = await vscode.window.showQuickPick(report.targets.map(target => ({
      label: target.label,
      description: target.line ? 'Line ' + target.line + (target.column ? ', column ' + target.column : '') : undefined,
      targetId: target.id
    })), { title: 'Step Into a Java Call' });
    if (choice) return step(report, choice.targetId);
  }

  return { inspect, step, choose };
}

module.exports = { createSmartStep, mergeStepFilters, stepTargets };
