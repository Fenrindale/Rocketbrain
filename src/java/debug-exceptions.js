'use strict';

const { DEBUG_BUILD } = require('./debug-runtime');
const setting = 'exceptionBreakpoints';
const settingPath = 'rocketbrain.java.' + setting;
const binaryClassName = /^(?:[\p{ID_Start}_$][\p{ID_Continue}_$]*\.)*[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u;
const fields = ['exceptionTypes', 'allowClasses', 'skipClasses'];

function classFilter(value) {
  if (binaryClassName.test(value)) return true;
  if (value.startsWith('*')) return binaryClassName.test(value.slice(1).replace(/^\./, ''));
  if (value.endsWith('*')) return binaryClassName.test(value.slice(0, -1).replace(/\.$/, ''));
  return false;
}

function filterList(value, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24) throw Error('Use up to 24 values for ' + key + '.');
  const valid = key === 'exceptionTypes' ? name => binaryClassName.test(name) : classFilter;
  const items = value.map(name => {
    if (typeof name !== 'string' || name.length > 240 || !valid(name.trim())) {
      const rule = key === 'exceptionTypes' ? 'Use exact Java exception class names (nested types use $).' :
        'Use a Java class name or one leading/trailing wildcard in the throw-site class pattern.';
      throw Error(rule);
    }
    return name.trim();
  });
  return [...new Set(items)];
}

function exceptionPolicy(value) {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw Error('Configure exceptionTypes, allowClasses and skipClasses for Java exception breakpoints.');
  }
  return Object.fromEntries(fields.map(key => [key, filterList(value[key], key)]));
}

function debugSettings(policy, { javaHome, mode, updated = false } = {}) {
  return JSON.stringify({
    hotCodeReplace: mode === 'never' ? 'never' : 'manual',
    logLevel: 'WARNING', javaHome,
    exceptionFilters: exceptionPolicy(policy),
    exceptionFiltersUpdated: updated
  });
}

function checkEngine(policy, build) {
  if (policy.exceptionTypes.length > 1 && build !== DEBUG_BUILD) {
    throw Error('Multiple Java exception types require the current Rocketbrain Java engine. Run Install and Configure Independent Java Engine to update the debugger.');
  }
}

function createExceptionControls(vscode, { run, ensureTrusted, engineState, hasSessions, output }) {
  let queued = Promise.resolve();
  let applied;
  const config = () => vscode.workspace.getConfiguration?.('rocketbrain.java');
  const get = () => exceptionPolicy(config()?.get(setting));

  function sync(updated = false) {
    const promise = queued.then(async () => {
      ensureTrusted();
      const policy = get();
      const next = JSON.stringify(policy);
      const needsRefresh = hasSessions() && applied !== next;
      const engine = engineState();
      if (updated && (!needsRefresh || engine.state !== 'running')) return policy;
      checkEngine(policy, engine.debugBuild);
      await run('vscode.java.updateDebugSettings', debugSettings(policy, {
        javaHome: engine.javaHome,
        mode: config()?.get('hotCodeReplace', 'manual'),
        updated: needsRefresh
      }));
      applied = next;
      return policy;
    });
    queued = promise.catch(() => {});
    return promise;
  }

  async function update(value) {
    ensureTrusted();
    const policy = exceptionPolicy(value);
    if (engineState().debugBuild) checkEngine(policy, engineState().debugBuild);
    if (!vscode.workspace.workspaceFolders?.length) throw Error('Open a Java workspace to share exception filters with its debug sessions.');
    await config().update(setting, policy, vscode.ConfigurationTarget.Workspace);
    return sync(true);
  }

  const prompts = {
    exceptionTypes: ['Java exception types', 'Enter comma-separated class names. An empty list matches every exception type.'],
    allowClasses: ['Allowed Java throw sites', 'Enter comma-separated class patterns. If supplied, every pattern must match.'],
    skipClasses: ['Skipped Java throw sites', 'Enter comma-separated throw-site class patterns to exclude.']
  };
  const parse = value => value.trim() ? value.split(',').map(name => name.trim()) : [];
  async function edit() {
    ensureTrusted();
    const existing = get();
    const next = {};
    for (const key of fields) {
      const [title, prompt] = prompts[key];
      const answer = await vscode.window.showInputBox({
        title, prompt, value: existing[key].join(', '),
        validateInput(value) {
          try { filterList(parse(value), key); } catch (error) { return error.message; }
          return undefined;
        }
      });
      if (answer === undefined) return;
      next[key] = parse(answer);
    }
    const policy = await update(next);
    void vscode.window.showInformationMessage('Workspace Java exception filters updated. Toggle Caught or Uncaught in Run and Debug to enable them.');
    return policy;
  }

  const listener = vscode.workspace.onDidChangeConfiguration?.(event => {
    if (event.affectsConfiguration(settingPath) && vscode.workspace.isTrusted) {
      void sync(true).catch(error => output.appendLine('Java exception filters could not be applied. ' + error.message));
    }
  });
  return { get, update, edit, sync, dispose() { listener?.dispose(); } };
}

module.exports = { createExceptionControls, exceptionPolicy, debugSettings, classFilter };
