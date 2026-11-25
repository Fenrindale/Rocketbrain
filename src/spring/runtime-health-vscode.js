'use strict';

const { randomBytes } = require('node:crypto');
const { healthChoices } = require('./runtime-health');
const { renderHealth } = require('./runtime-health-view');

function registerRuntimeHealth(vscode, { getClient, assertTrusted, onConnectionChange }) {
  const events = new vscode.EventEmitter();
  let panel, pending, client, disposed = false, revision = 0;
  let current = { state: 'disconnected', path: [], observation: null };

  const choices = () => current.observation ? healthChoices(current.observation, current.path.length) : [];
  const snapshot = () => structuredClone({ ...current, choices: choices() });

  function render() {
    if (panel) panel.webview.html = renderHealth(current, choices(), randomBytes(18).toString('base64'), revision);
  }

  function update(state, path = [], observation = null) {
    current = { state, path, observation };
    revision++;
    render();
    if (!disposed) events.fire(snapshot());
  }

  const connection = onConnectionChange(() => {
    const next = getClient();
    if (client === next) return;
    client = next;
    pending = undefined;
    update(client ? 'ready' : 'disconnected');
  });

  async function observe(path) {
    assertTrusted();
    if (!client) return snapshot();
    if (pending) return pending;
    const candidate = client;
    const request = Promise.resolve().then(async () => {
      let report;
      try {
        report = { state: 'observed', ...await candidate.health(path.map(step => step.segment)) };
      } catch (error) {
        report = { state: 'unavailable', code: error.code || 'OBSERVATION_FAILED', httpStatus: error.status || null };
      }
      if (!disposed && candidate === client) {
        assertTrusted();
        update(report.state, path, { ...report, observedAt: new Date().toISOString() });
      }
      return snapshot();
    });
    pending = request;
    update('loading', path);
    try { return await request; }
    finally { if (pending === request) pending = undefined; }
  }

  function refresh() { return observe(current.path); }
  function back() { return observe(current.path.slice(0, -1)); }

  function select(index) {
    const choice = Number.isInteger(index) && choices()[index];
    if (!choice) return snapshot();
    return observe([...current.path, choice]);
  }

  async function open() {
    assertTrusted();
    if (panel) panel.reveal();
    else {
      const view = vscode.window.createWebviewPanel('rocketbrainSpringHealth', 'Spring Actuator Health', vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [] });
      panel = view;
      view.onDidDispose(() => { if (panel === view) panel = undefined; });
      view.webview.onDidReceiveMessage(async message => {
        if (disposed || view !== panel || message?.revision !== revision) return;
        try {
          if (message.action === 'refresh') await refresh();
          else if (message.action === 'back') await back();
          else if (message.action === 'select') await select(message.index);
        } catch (error) {
          if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Spring: ' + error.message);
        }
      });
      render();
    }
    return observe([]);
  }

  function close() { panel?.dispose(); }

  return {
    open, refresh, back, select, snapshot, close, onDidChange: events.event,
    dispose() { disposed = true; close(); connection.dispose(); events.dispose(); }
  };
}

module.exports = { registerRuntimeHealth };
