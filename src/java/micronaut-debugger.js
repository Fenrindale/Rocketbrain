'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DEBUG_TYPE, processAttachTarget } = require('./debug');
const { fail } = require('./workbench-model');

const MARKER = '__rocketbrainMicronautDebug';
const attachmentBudget = 30000;
const stoppingBudget = 5000;

async function bounded(promise, ms, message, cancellation) {
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(message)), ms);
      abort = () => reject(fail('Micronaut debugging was cancelled.'));
      cancellation?.addEventListener('abort', abort, { once: true });
      if (cancellation?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) cancellation?.removeEventListener('abort', abort);
  }
}

function createMicronautDebugger(vscode, java, runtime) {
  let current;
  const settling = new Set();

  function cleanup(record) {
    clearTimeout(record.lateTimer);
    record.started.dispose();
    record.ended.dispose();
    settling.delete(record);
  }

  async function stopSession(record) {
    if (!record.session || record.terminated) return;
    if (!record.stoppingSession) {
      record.stoppingSession = bounded(Promise.resolve().then(async () => {
        await vscode.debug.stopDebugging(record.session);
        await record.termination;
      }), stoppingBudget, 'The owned Micronaut debugger did not confirm termination.');
    }
    await record.stoppingSession;
  }

  function retire(record) {
    if (record.retiring) return record.retiring;
    record.closed = true;
    if (current === record) current = undefined;
    record.retiring = (async () => {
      try { await stopSession(record); }
      finally {
        if (record.terminated || record.requestSettled && (!record.startedSuccessfully || record.session)) cleanup(record);
        else {
          // A native start request can settle after cancellation. Keep its exact
          // marker subscribed so it cannot leave a late session behind.
          record.lateTimer = setTimeout(() => cleanup(record), attachmentBudget * 2);
          record.lateTimer.unref?.();
        }
      }
    })();
    return record.retiring;
  }

  async function attach({ project, receipt, sourcePaths, cancellation, validate }) {
    if (current || settling.size >= 4) throw fail('Wait for the previous owned Micronaut debugger to settle.');
    validate();
    const candidate = await java.debug.processes.resolve(receipt.debug.pid, cancellation);
    const proof = await runtime.verifyDebugTarget({ runId: receipt.runId, cancellation });
    if (candidate.hostName !== proof.address || candidate.pid !== proof.pid || candidate.port !== proof.port) {
      throw fail('The reviewed JVM does not own the observed Micronaut debug listener.');
    }
    validate();
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(project.uri));
    if (!folder) throw fail('Open the selected Micronaut project before attaching its debugger.');
    const key = randomUUID();
    const record = { runId: receipt.runId, closed: false, requestSettled: false };
    const own = session => session.type === DEBUG_TYPE && session.configuration?.[MARKER] === key;
    let terminated;
    record.termination = new Promise(resolve => { terminated = resolve; });
    record.started = vscode.debug.onDidStartDebugSession(session => {
      if (!own(session)) return;
      record.session = session;
      if (record.closed) void stopSession(record).catch(() => {}).finally(() => cleanup(record));
    });
    record.ended = vscode.debug.onDidTerminateDebugSession(session => {
      if (!own(session)) return;
      record.terminated = true;
      terminated();
      if (current === record) current = undefined;
      cleanup(record);
    });
    current = record;
    settling.add(record);
    const request = Promise.resolve().then(() => vscode.debug.startDebugging(folder, {
      type: DEBUG_TYPE, request: 'attach', name: 'Rocketbrain Micronaut · ' + project.name,
      ...processAttachTarget(candidate), [MARKER]: key, sourcePaths
    }, { suppressSaveBeforeStart: true })).then(started => {
      record.startedSuccessfully = started;
      return started;
    }).finally(() => {
      record.requestSettled = true;
      if (record.closed && !record.startedSuccessfully && !record.session) cleanup(record);
    });
    try {
      if (!await bounded(request, attachmentBudget, 'The Micronaut debug session did not start.', cancellation)) {
        throw fail('Could not attach to the owned Micronaut JVM.');
      }
      const deadline = Date.now() + attachmentBudget;
      while (!record.session || java.debug.verifiedLocalPid(record.session) !== proof.pid) {
        if (record.closed || record.terminated || cancellation?.aborted || Date.now() >= deadline) {
          throw fail('The Java debugger did not acknowledge the owned Micronaut JVM.');
        }
        await delay(100);
      }
      validate();
      return record.session.id;
    } catch (error) {
      await retire(record);
      throw error;
    }
  }

  return { attach, stop: () => current ? retire(current) : Promise.resolve(),
    sessionId: runId => current?.runId === runId && !current.terminated ? current.session?.id : undefined };
}

module.exports = { createMicronautDebugger, MARKER };
