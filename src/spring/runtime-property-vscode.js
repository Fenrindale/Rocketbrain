'use strict';

const { randomBytes } = require('node:crypto');
const { RuntimeError } = require('./runtime-client');
const { propertyPath } = require('./runtime-property');

const VIEW = 'rocketbrain.spring.propertyOrigin';
const TITLE = 'Spring Property Origin';
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);

function renderProperty(report) {
  const nonce = randomBytes(18).toString('base64');
  const { display } = report;
  const value = display.state === 'visible' ? '<pre>' + escape(display.type === 'string' ? JSON.stringify(display.value) : display.value) + '</pre>'
    : '<p>' + (display.state === 'redacted' ? 'Value redacted' : 'No bounded scalar value available') + '</p>';
  const rows = report.sources.map(item => '<tr><td>' + item.position + '</td><td>' + escape(item.name) + (item.effective ? ' · effective' : '') +
    '</td><td>' + escape(item.origin || 'Origin unavailable') + '</td></tr>').join('');
  const target = report.debugProcessVerified ? 'Verified active local Java debug target' : 'Selected loopback Spring runtime';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${TITLE}</title>
  <style nonce="${nonce}">
  body{font-family:var(--vscode-font-family);padding:.8rem 1rem} h1,h2{margin-bottom:.4rem} h1{font-size:1.25rem} h2{font-size:1rem}
  header p, dt{color:var(--vscode-descriptionForeground)} code,pre{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}
  pre{white-space:pre-wrap} dd{margin:.2rem 0 .65rem;overflow-wrap:anywhere} table{width:100%;border-collapse:collapse}
  th,td{padding:.4em .6em;text-align:left;border:1px solid var(--vscode-panel-border);overflow-wrap:anywhere} th{background:var(--vscode-editorWidget-background)}
  </style></head><body><header><h1><code>${escape(report.key)}</code></h1><p>${target} · ${escape(report.observedAt)}</p></header>
  <dl><dt>Effective source</dt><dd>${escape(report.source)}</dd><dt>Origin</dt><dd>${escape(report.origin || 'Origin unavailable')}</dd></dl>
  <h2>Effective value</h2>${value}<h2>Property sources in precedence order</h2>
  ${rows ? '<table><thead><tr><th>Order</th><th>Source</th><th>Origin</th></tr></thead><tbody>'+rows+'</tbody></table>' : '<p>Spring did not report individual property sources.</p>'}
  </body></html>`;
}

function registerRuntimeProperty(vscode, { getClient, onConnectionChange, assertTrusted, verifiedLocalPid }) {
  let panel, displayedSession, revision = 0, disposed = false, client = getClient();
  function close() {
    revision++;
    const previous = panel;
    panel = undefined;
    displayedSession = undefined;
    previous?.dispose();
  }
  const subscriptions = [onConnectionChange(() => {
    if (client === getClient()) return;
    client = getClient();
    close();
  })];
  if (vscode.debug?.onDidChangeActiveDebugSession) subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(session => {
    if (displayedSession && displayedSession.id !== session?.id) close();
  }));
  if (vscode.debug?.onDidTerminateDebugSession) subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
    if (displayedSession?.id === session.id) close();
  }));

  async function open(debugMode, input) {
    assertTrusted();
    const suppliedKey = input && Object.hasOwn(input, 'key');
    if (suppliedKey && input.approved !== true) throw new RuntimeError('REVIEW_REQUIRED', 'Review the exact property key before inspecting it.');
    const candidate = getClient();
    if (!candidate) throw new RuntimeError('NOT_CONNECTED', 'Connect to a loopback Spring runtime first.');
    const session = debugMode ? vscode.debug?.activeDebugSession : undefined;
    const pid = debugMode ? verifiedLocalPid?.(session) : undefined;
    if (debugMode && (!session || !pid)) throw new RuntimeError('UNVERIFIED_DEBUG_TARGET', 'Attach to the local Java process by its verified PID before inspecting a Spring debug property.');
    const checkSession = () => {
      assertTrusted();
      if (disposed || candidate !== getClient() || (session &&
          (session.id !== vscode.debug.activeDebugSession?.id || verifiedLocalPid(session) !== pid)))
        throw new RuntimeError('STALE_PROPERTY', 'The runtime or debug target changed during property inspection.');
    };

    const key = suppliedKey ? input.key : await vscode.window.showInputBox({
      title: debugMode ? 'Spring Property in Active Debug Target' : 'Spring Runtime Property',
      prompt: 'Enter one property key, for example spring.application.name.', ignoreFocusOut: true,
      validateInput(value) { try { propertyPath(value); } catch (error) { return error.message; } }
    });
    if (key === undefined) return;
    checkSession();
    try { propertyPath(key); } catch (error) { throw new RuntimeError('INVALID_PROPERTY_KEY', error.message); }
    if (!suppliedKey) {
      const answer = await vscode.window.showWarningMessage('Inspect this Spring property?', { modal: true,
        detail: key + '\n' + candidate.snapshot().baseUrl + '\n\nThe effective value may contain sensitive data. It will appear in a temporary editor tab.' }, 'Inspect');
      if (answer !== 'Inspect') return;
    }
    checkSession();
    if (displayedSession?.id !== session?.id) close();
    const epoch = ++revision;
    displayedSession = session;
    const assertCurrent = () => {
      checkSession();
      if (epoch !== revision) throw new RuntimeError('STALE_PROPERTY', 'Another observation replaced this property inspection.');
    };

    let result;
    try { result = await candidate.property(key, { verifiedPid: pid, assertCurrent }); }
    catch (error) {
      if (debugMode && error.code === 'TIMEOUT') throw new RuntimeError('DEBUG_RUNTIME_TIMEOUT', 'Spring did not respond. Resume the debugged JVM if all threads are suspended, and retry.');
      throw error;
    }
    assertCurrent();
    if (!panel) {
      const view = vscode.window.createWebviewPanel(VIEW, TITLE, vscode.ViewColumn.Beside,
        { enableScripts: false, localResourceRoots: [], enableCommandUris: false });
      panel = view;
      view.onDidDispose(() => {
        if (panel !== view) return;
        panel = undefined;
        close();
      });
    }
    panel.webview.html = renderProperty(result);
    panel.reveal();
    return { ...result, view: VIEW };
  }
  return { open, dispose() { disposed = true; close(); for (const subscription of subscriptions) subscription.dispose(); } };
}

module.exports = { registerRuntimeProperty, renderProperty };
