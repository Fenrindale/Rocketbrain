'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DEBUG_TYPE, processAttachTarget } = require('./debug');
const { fail } = require('./workbench-model');

const MARKER = '__rocketbrainMicronautDebug';
const attachmentBudget = 30000;
const stoppingBudget = 5000;

async function bounded(promise, ms, message, cancellation, label='Micronaut') {
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(message)), ms);
      abort = () => reject(fail(label+' debugging was cancelled.'));
      cancellation?.addEventListener('abort', abort, { once: true });
      if (cancellation?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) cancellation?.removeEventListener('abort', abort);
  }
}

function createOwnedJvmDebugger(vscode, java, runtime, {
  label='Micronaut', marker=MARKER, registerSourceLines, onSessionEnd
} = {}) {
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
      }), stoppingBudget, 'The owned '+label+' debugger did not confirm termination.');
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

  async function attach({ project, receipt, sourcePaths, sourceLines, cancellation, validate }) {
    if (current || settling.size >= 4) throw fail('Wait for the previous owned '+label+' debugger to settle.');
    validate();
    const selection = receipt.debug.startedAt ? receipt.debug : receipt.debug.pid;
    const candidate = await java.debug.processes.resolve(selection, cancellation);
    const proof = await runtime.verifyDebugTarget({ runId: receipt.runId, cancellation });
    if (candidate.hostName !== proof.address || candidate.pid !== proof.pid || candidate.port !== proof.port) {
      throw fail('The reviewed JVM does not own the observed '+label+' debug listener.');
    }
    validate();
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(project.uri));
    if (!folder) throw fail('Open the selected '+label+' project before attaching its debugger.');
    const key = randomUUID();
    const registration = sourceLines && registerSourceLines?.(key, candidate, sourceLines);
    const record = { runId: receipt.runId, closed: false, requestSettled: false };
    const own = session => session.type === DEBUG_TYPE && session.configuration?.[marker] === key;
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
      onSessionEnd?.(record.runId);
    });
    current = record;
    settling.add(record);
    const request = Promise.resolve().then(() => vscode.debug.startDebugging(folder, {
      type: DEBUG_TYPE, request: 'attach', name: 'Rocketbrain '+label+' · ' + project.name,
      ...processAttachTarget(candidate), [marker]: key, sourcePaths
    }, { suppressSaveBeforeStart: true })).then(started => {
      record.startedSuccessfully = started;
      return started;
    }).finally(() => {
      record.requestSettled = true;
      if (record.closed && !record.startedSuccessfully && !record.session) cleanup(record);
    });
    try {
      if (!await bounded(request, attachmentBudget, 'The '+label+' debug session did not start.', cancellation,label)) {
        throw fail('Could not attach to the owned '+label+' JVM.');
      }
      const deadline = Date.now() + attachmentBudget;
      while (!record.session || java.debug.verifiedLocalPid(record.session) !== proof.pid) {
        if (record.closed || record.terminated || cancellation?.aborted || Date.now() >= deadline) {
          throw fail('The Java debugger did not acknowledge the owned '+label+' JVM.');
        }
        await delay(100);
      }
      validate();
      return record.session.id;
    } catch (error) {
      await retire(record);
      throw error;
    } finally { registration?.dispose(); }
  }

  return { attach, stop: () => current ? retire(current) : Promise.resolve(),
    sessionId: runId => current?.runId === runId && !current.terminated ? current.session?.id : undefined };
}

module.exports = { createMicronautDebugger:createOwnedJvmDebugger, createOwnedJvmDebugger, MARKER };
