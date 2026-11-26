'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const traceLimit = 4 * 1024 * 1024;
const taskLimit = 2048;
const traceIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const wrapperFrame = /(?:^|\.)TaskTrace\.runRecorded\(/;
const handoffs = new Set(['executor', 'virtual-thread', 'reactor-scheduler']);
const validId = value => Number.isSafeInteger(value) && value > 0;
const shortText = (value, max) => typeof value === 'string' && value.length <= max;

function parseError() { return Error('The Java async trace contains an invalid record.'); }

function thread(value, typed) {
  if (!validId(value?.id) || !shortText(value.name, 120) || typed && typeof value.virtual !== 'boolean') throw parseError();
  return typed ? { id: value.id, name: value.name, virtual: value.virtual } : { id: value.id, name: value.name };
}

function sourceFrames(frames) {
  if (!Array.isArray(frames) || frames.length > 20) throw parseError();
  return frames.map(frame => {
    if (!shortText(frame?.type, 350) || !frame.type || !shortText(frame.method, 120) || !frame.method ||
        !shortText(frame.file, 160) || !Number.isSafeInteger(frame.line)) throw parseError();
    return { type: frame.type, method: frame.method, file: frame.file, line: frame.line };
  });
}

function parseAsyncTrace(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > traceLimit) throw Error('Open a Java async trace up to 4 MiB.');
  const lines = text.split('\n');
  // Ignore a final incomplete line while the traced JVM is appending.
  lines.pop();
  let header;
  try { header = JSON.parse(lines.shift()); } catch { throw Error('The file is missing a Java async trace header.'); }
  if (header?.kind !== 'trace' || header.version !== 1 || !traceIdPattern.test(header.traceId) || !validId(header.pid)) {
    throw Error('Open a Rocketbrain Java async task trace version 1.');
  }
  if (lines.length > taskLimit * 3 + 1) throw parseError();
  const tasks = new Map();
  let truncated = false;
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { throw parseError(); }
    if (truncated) throw parseError();
    if (item?.kind === 'truncated') { truncated = true; continue; }
    if (!validId(item?.id) || item.id > taskLimit) throw parseError();
    if (item.kind === 'submitted') {
      if (item.id !== tasks.size + 1 || !Number.isSafeInteger(item.parent) || item.parent < 0 ||
          item.parent && !tasks.has(item.parent) || !shortText(item.label, 160)) throw parseError();
      const typed = item.handoff !== undefined;
      if (typed && !handoffs.has(item.handoff)) throw parseError();
      const submittedBy = thread(item.thread, typed);
      const parent = tasks.get(item.parent);
      if (typed && parent && (parent.state !== 'entered' ||
          parent.worker.id !== submittedBy.id || parent.worker.virtual !== submittedBy.virtual)) throw parseError();
      tasks.set(item.id, {
        id: item.id, parentId: item.parent, label: item.label, submittedBy,
        ...(typed ? { handoff: item.handoff } : {}),
        submissionFrames: sourceFrames(item.frames), state: 'submitted'
      });
      continue;
    }
    const task = tasks.get(item.id);
    if (!task) throw parseError();
    if (item.kind === 'entered' && task.state === 'submitted') {
      const worker = thread(item.thread, task.handoff !== undefined);
      if (task.handoff === 'virtual-thread' && (!worker.virtual || worker.id === task.submittedBy.id)) throw parseError();
      task.state = 'entered';
      task.worker = worker;
    } else if (item.kind === 'rejected' && task.state === 'submitted' ||
        ['completed', 'failed'].includes(item.kind) && task.state === 'entered') {
      task.state = item.kind;
    } else {
      throw parseError();
    }
  }
  return { traceId: header.traceId, pid: header.pid, tasks, truncated };
}

async function openAsyncTrace(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}|[\0\r\n]/.test(file) || path.extname(file).toLowerCase() !== '.jsonl') {
    throw Error('Select a local Java async trace JSONL file.');
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > traceLimit) throw Error('Open a regular Java async trace file up to 4 MiB.');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw Error('The Java async trace file changed.');
    const buffer = Buffer.alloc(traceLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > traceLimit) throw Error('Open a Java async trace up to 4 MiB.');
    return parseAsyncTrace(buffer.toString('utf8', 0, length));
  } finally { await handle.close(); }
}

function chainFor(trace, id) {
  const chain = [];
  for (let next = id; next;) {
    const task = trace.tasks.get(next);
    if (!task) throw Error('The paused Java task is missing from this trace.');
    chain.push(task);
    next = task.parentId;
  }
  return chain.reverse();
}

function traceValue(variables) {
  if (!Array.isArray(variables)) return undefined;
  const traceId = variables.find(v => v.name === 'rocketbrainTraceId')?.value;
  const task = variables.find(v => v.name === 'rocketbrainTaskId')?.value;
  const value = typeof traceId === 'string' && traceId.startsWith('"') && traceId.endsWith('"') ? traceId.slice(1, -1) : traceId;
  if (typeof value === 'string' && traceIdPattern.test(value) && typeof task === 'string' && /^[1-9][0-9]{0,3}$/.test(task)) {
    const workerId = variables.find(v => v.name === 'rocketbrainWorkerThreadId');
    const workerVirtual = variables.find(v => v.name === 'rocketbrainWorkerVirtual');
    if (!workerId && !workerVirtual) return { traceId: value, taskId: Number(task) };
    const id = workerId?.value;
    const virtual = workerVirtual?.value;
    if (typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id) && validId(Number(id)) &&
        ['true', 'false'].includes(virtual)) {
      return { traceId: value, taskId: Number(task), worker: { id: Number(id), virtual: virtual === 'true' } };
    }
  }
}

function createAsyncInspection({ activeSession, getState, ensureTrusted, readTrace = openAsyncTrace }) {
  function stopped(session) {
    ensureTrusted();
    const state = session && getState(session.id);
    if (!session || session.type !== 'rocketbrain-java' || session.id !== activeSession()?.id ||
        state?.state !== 'stopped' || state.resuming !== undefined || !validId(state.threadId)) {
      throw Error('Pause a Rocketbrain Java task before inspecting its async stack.');
    }
    return state;
  }

  async function inspect(file, session = activeSession()) {
    const { stopVersion, threadId } = stopped(session);
    const selected = () => {
      const state = stopped(session);
      if (state.stopVersion !== stopVersion || state.threadId !== threadId) {
        throw Error('The debugger stopped elsewhere. Inspect the async stack again.');
      }
    };
    const trace = await readTrace(file);
    selected();
    const { stackFrames } = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 64 });
    selected();
    const wrapper = stackFrames?.find(frame => validId(frame.id) && wrapperFrame.test(frame.name));
    if (!wrapper) throw Error('No recorded Java task is active in the paused stack.');
    const { scopes } = await session.customRequest('scopes', { frameId: wrapper.id });
    selected();
    const locals = scopes?.find(scope => /^locals?$/i.test(scope.name) && validId(scope.variablesReference));
    if (!locals) throw Error('Compile the Java trace helper with local debug variables enabled.');
    const { variables } = await session.customRequest('variables', { variablesReference: locals.variablesReference });
    selected();
    const identity = traceValue(variables);
    if (!identity) throw Error('The Java task frame has no readable trace identity.');
    if (identity.traceId !== trace.traceId) throw Error('The selected trace belongs to a different Java runtime.');
    const chain = chainFor(trace, identity.taskId);
    const task = chain.at(-1);
    if (task?.state !== 'entered') throw Error('The trace does not contain an active execution record for the paused Java task.');
    if (identity.worker || task.handoff) {
      if (!identity.worker || identity.worker.id !== task.worker.id || identity.worker.virtual !== task.worker.virtual) {
        throw Error('The trace worker identity differs from the paused Java thread.');
      }
    }
    return { traceId: trace.traceId, pid: trace.pid, taskId: identity.taskId, chain, truncated: trace.truncated };
  }

  return { inspect };
}

module.exports = { parseAsyncTrace, openAsyncTrace, chainFor, createAsyncInspection };
