'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { GROOVY_LINE_BUILD } = require('./debug-runtime');
const { GROOVY_DEBUG_MARKER } = require('./debug');
const { createOwnedJvmDebugger } = require('./micronaut-debugger');
const { waitForOwnedListener } = require('./testing-debug');
const { captureGroovyDebugSources, startGroovyApplicationDebug } = require('./groovy-debug');
const { workspaceRoots, physicalWorkspacePath, inside, cancelled, fail } = require('./workbench-model');

const normalized = value => value.replace(/\r\n?/gu, '\n');
const toolKey = tools => [tools.javaHome || '',tools.gradleHome || ''].join('\n');

function createGroovyApplicationDebugger(vscode, java, { projects, configuration, trusted, output }) {
  let review, active, starting, control;

  function check(cancellation) {
    trusted();
    if (cancelled(cancellation)) throw fail('Groovy debugging was cancelled.');
  }

  function roots() { return workspaceRoots(vscode.workspace.workspaceFolders); }

  function selected(project, document, cancellation) {
    check(cancellation);
    if (!document || document.languageId !== 'groovy' || document.isDirty || document.isClosed ||
        document.uri?.scheme !== 'file' || document.uri.authority || document.uri.query || document.uri.fragment) {
      throw fail('Open a saved local Groovy source to debug.');
    }
    const workspace = roots();
    const file = physicalWorkspacePath(document.uri.fsPath, workspace, { directory: false });
    const root = physicalWorkspacePath(project.root, workspace);
    if (path.relative(file, document.uri.fsPath) ||
        path.relative(project.root, root) ||
        !java.workbench.getSnapshot().projects.some(item => item.id === project.id && item.uri === project.uri)) {
      throw fail('Choose the same physical imported Groovy Gradle project.');
    }
    if (java.workbench.getSnapshot().taskRunning) throw fail('Wait for the current managed Java build to finish.');
    if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file' && inside(project.root, doc.uri.fsPath))) {
      throw fail('Save modified Groovy project files before debugging.');
    }
    const snapshot = captureGroovyDebugSources(root, file, cancellation);
    if (snapshot.files.get(file).text !== normalized(document.getText())) throw fail('The editor no longer matches the saved Groovy source.');
    return { file, snapshot, project: { ...project, root }, tools: configuration(root) };
  }

  async function prepare({ document, projectUri, cancellation } = {}) {
    check(cancellation);
    if (starting || active) throw fail('Stop the current owned Groovy application debugger first.');
    const pathHint = document?.uri?.scheme === 'file' && document.uri.fsPath;
    const candidates = (await projects()).filter(project => pathHint && inside(project.root, pathHint) &&
      (!projectUri || project.uri === projectUri)).sort((a,b) => b.root.length-a.root.length);
    if (!candidates.length) throw fail('Import the selected source in Java Projects as an ordinary Groovy Gradle application.');
    const project = candidates[0], inputs = selected(project, document, cancellation);
    const plan = { id: randomUUID(), projectUri: project.uri, project: project.name,
      source: path.relative(project.root, inputs.file), task: ':run', fingerprint: inputs.snapshot.fingerprint };
    review = { plan, project, document, version: document.version, tools: toolKey(inputs.tools), expires: Date.now()+8*60*1000 };
    return { ...plan };
  }

  async function finish(record) {
    if (!record) return { state: 'stopped' };
    record.closing ||= (async () => {
      try { await control?.stop(); }
      finally {
        await record.run.stop();
        if (active === record) active = undefined;
      }
      return { state: 'stopped' };
    })().catch(error => { record.closing=undefined; throw error; });
    return record.closing;
  }

  function endSession(runId) {
    const record = active;
    if (!record || record.id !== runId || record.closing) return;
    void Promise.race([record.run.done, delay(1700)]).finally(() => finish(record))
      .catch(error => output.appendLine(error.message));
  }

  async function start({ id, allowProjectExecution, cancellation } = {}) {
    check(cancellation);
    if (allowProjectExecution !== true) throw fail('Explicitly approve the reviewed Groovy Gradle application debugger.');
    if (starting || active) throw fail('Stop the current owned Groovy application debugger first.');
    if (!review || review.plan.id !== id || Date.now() >= review.expires) throw fail('Prepare a current one-use Groovy debug review.');
    const { plan, project, document, version, tools } = review;
    review = undefined;
    const abort = new AbortController();
    const onCancel = () => abort.abort();
    const subscription = cancellation?.onCancellationRequested?.(onCancel);
    cancellation?.addEventListener?.('abort', onCancel, { once: true });
    const verify = () => {
      const result = selected(project, document, abort.signal);
      if (document.version !== version || result.snapshot.fingerprint !== plan.fingerprint || toolKey(result.tools) !== tools) {
        throw fail('The Groovy source, build or tools changed after review. Review the application again.');
      }
      return result;
    };
    let record, settled;
    const done = new Promise(resolve => { settled = resolve; });
    starting = { abort, done };
    try {
      const timer = AbortSignal.timeout(45000);
      await new Promise((resolve, reject) => {
        const signal = AbortSignal.any([abort.signal, timer]);
        const rejectStart = () => reject(fail(timer.aborted ? 'The independent Groovy debugger did not start.' : 'Groovy debugging was cancelled.'));
        signal.addEventListener('abort', rejectStart, { once: true });
        if (signal.aborted) rejectStart();
        Promise.resolve().then(()=>java.start()).then(resolve,reject).finally(()=>{
          signal.removeEventListener('abort', rejectStart);
        }).catch(()=>{});
      });
      const state = java.getState(), inputs = verify();
      if (state.debugBuild !== GROOVY_LINE_BUILD || typeof java.debug.registerGroovySourceLines !== 'function') {
        throw fail('Update the independent Rocketbrain Java debugger for managed Groovy source lines.');
      }
      const run = await startGroovyApplicationDebug({ project: inputs.project, file: inputs.file, tools: inputs.tools,
        javaHome: state.javaHome, cancellation: abort.signal, verify: () => verify().snapshot,
        resolveDescendant: java.debug.processes.resolveDescendant, onOutput: chunk => output.append(chunk) });
      record = { id: randomUUID(), run };
      active = record;
      void run.done.finally(() => finish(record)).catch(error => output.appendLine(error.message));
      control ||= createOwnedJvmDebugger(vscode, java, {
        async verifyDebugTarget({ runId, cancellation: signal }) {
          const owned = active;
          if (!owned || owned.id !== runId || owned.closing) throw fail('Choose the current owned Groovy debug JVM.');
          const { pid, port } = owned.run.target;
          const proof = await waitForOwnedListener({ pid, port, cancellation: signal, timeoutMs: 6000 });
          if (active !== owned || owned.closing) throw fail('The owned Groovy debug JVM changed before attachment.');
          return proof;
        }
      },{ label:'Groovy', marker:GROOVY_DEBUG_MARKER, registerSourceLines:java.debug.registerGroovySourceLines,
        onSessionEnd:endSession });
      const sessionId = await control.attach({ project: inputs.project, receipt: { runId: record.id, debug: run.target },
        sourcePaths: run.sourcePaths, sourceLines: run.sourceLines, cancellation: abort.signal, validate: verify });
      return { state:'attached', task:plan.task, sessionId, verifiedLoopback:true,
        sourceLines:run.sourceLines.files.length, pid:run.target.pid, port:run.target.port };
    } catch (error) {
      if (record) await finish(record);
      throw error;
    } finally {
      starting=undefined;
      settled();
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',onCancel);
    }
  }

  async function stop() {
    review=undefined;
    const pending=starting;
    pending?.abort.abort();
    try { return await finish(active); }
    finally { await pending?.done; }
  }

  return { prepare, start, stop, getState: () => ({
    state: active ? 'attached' : starting ? 'starting' : 'stopped'
  }) };
}

module.exports = { createGroovyApplicationDebugger };
