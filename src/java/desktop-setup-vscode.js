'use strict';

const { randomBytes } = require('node:crypto');

function setupPage() {
  const nonce = randomBytes(24).toString('base64');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>Java Setup</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-weight) 14px/1.5 var(--vscode-font-family); }
main { max-width: 790px; margin: 0 auto; padding: clamp(24px, 7vw, 70px) clamp(20px, 5vw, 48px); }
h1 { font-size: 29px; font-weight: 650; margin: 0 0 6px; }
h2 { font-size: 15px; font-weight: 650; margin: 0 0 3px; }
p { margin: 0 0 12px; }
.description { color: var(--vscode-descriptionForeground); }
.state { margin: 24px 0 18px; padding: 12px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.row p { margin: 0; overflow-wrap: anywhere; }
.row div { min-width: 0; }
.actions { margin: 20px 0 10px; display: flex; flex-wrap: wrap; gap: 8px; }
button { border: 1px solid transparent; border-radius: 4px; padding: 6px 12px; min-height: 29px; font: inherit; white-space: nowrap; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: default; }
.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.primary:hover:enabled { background: var(--vscode-button-hoverBackground); }
#problem:empty, #server-info:empty { display: none; }
#problem { color: var(--vscode-errorForeground); overflow-wrap: anywhere; margin-top: 12px; }
@media (max-width: 460px) { .row { align-items: flex-start; flex-direction: column; } }
</style></head>
<body><main>
  <h1>Java Setup</h1>
  <p class="description">Configure the JDK and language engine for Java navigation, code completion, project import, and debugging.</p>
  <div class="state" role="status"><strong id="status">Checking Java setup…</strong><div id="server-info" class="description"></div></div>
  <div class="row"><div><h2>Java engine JDK</h2><p id="java-home" class="description">Checking for a JDK…</p></div><button data-action="pick-jdk">Choose JDK…</button></div>
  <div class="row"><div><h2>Language engine</h2><p id="language-engine" class="description">Checking for Eclipse JDT LS…</p></div><button data-action="pick-engine">Choose JDT LS…</button></div>
  <div class="actions">
    <button class="primary" data-action="download">Download Java Engine</button>
    <button data-action="restart">Start Java</button>
    <button data-action="enable-java" hidden>Enable Java</button>
    <button data-action="use-detected" hidden>Use Detected JDK</button>
    <button data-action="settings">Project JDKs and Build Tools</button>
    <button data-action="output">View Java Log</button>
  </div>
  <p id="download-info" class="description">The managed installation includes Eclipse JDT LS and the Rocketbrain debugger.</p>
  <p id="problem" role="alert"></p>
</main><script nonce="${nonce}">
'use strict';
const vscode = acquireVsCodeApi();
const buttons = new Map();
for (const button of document.querySelectorAll('button[data-action]')) {
  const action = button.dataset.action;
  button.addEventListener('click', () => vscode.postMessage({ action }));
  buttons.set(action, button);
  button.disabled = true;
}
const set = (id, text) => { document.getElementById(id).textContent = text || ''; };
window.addEventListener('message', ({ data }) => {
  if (data?.type !== 'setupState') return;
  set('status', data.status);
  set('server-info', data.detail);
  set('java-home', data.javaHome);
  set('language-engine', data.serverPath);
  set('download-info', data.downloadInfo);
  set('problem', data.problem);
  for (const [action, button] of buttons) {
    button.disabled = !data.available.includes(action);
    if (action === 'enable-java' || action === 'use-detected') button.hidden = !data.available.includes(action);
  }
  buttons.get('restart').textContent = data.restartLabel;
  buttons.get('download').textContent = data.downloadLabel;
});
vscode.postMessage({ action: 'requestState' });
</script></body></html>`;
}

function registerDesktopJavaSetup(vscode, { runtime, getState, canStart, detectJdk, install, save, restart, output }) {
  let panel, progress, job, lastError;
  const config = () => vscode.workspace.getConfiguration('rocketbrain.java');
  const settings = () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rocketbrain-local.rocketbrain rocketbrain.java');

  function refresh() {
    if (!panel) return;
    const engine = runtime();
    const state = getState();
    const trusted = vscode.workspace.isTrusted;
    const enabled = config().get('enabled', true);
    const available = ['settings', 'output'];
    const configured = engine.jdk && engine.serverPath;
    if (trusted && !job) {
      available.push('pick-jdk', 'pick-engine', 'download');
      if (configured && enabled && canStart() && state.state !== 'starting') available.push('restart');
      if (!enabled) available.push('enable-java');
      if (engine.configuredJdk && detectJdk()) available.push('use-detected');
    }
    const active = state.state === 'running' || state.state === 'starting';
    let status, detail;
    if (job === 'download') {
      status = 'Installing Java Engine'; detail = progress;
    } else if (!trusted) {
      status = 'Workspace trust required'; detail = 'Trust this workspace to install Java or import its projects.';
    } else if (!enabled) {
      status = 'Java is disabled'; detail = 'Enable Java to start editor services.';
    } else if (active) {
      status = state.state === 'starting' ? 'Starting Java engine' : state.ready ? 'Java is ready' : 'Indexing Java project';
    } else if (state.state === 'error') {
      status = 'Java could not start'; detail = 'Check the Java log, review these paths, and retry.';
    } else if (state.state === 'container') {
      status = 'Java is managed by the container'; detail = state.message;
    } else if (configured) {
      status = 'Java engine is configured'; detail = canStart() ? 'Start Java to index the current workspace.' : 'Open a Java project in Java mode to start the engine.';
    } else {
      status = 'Java setup required'; detail = 'Download the managed engine or select an existing JDK and Eclipse JDT LS distribution.';
    }
    void panel.webview.postMessage({
      type: 'setupState', available, status, detail,
      javaHome: engine.jdk ? `JDK ${engine.jdk.version} · ${engine.jdk.path}` : engine.configuredJdk || 'No compatible JDK 25 or newer detected',
      serverPath: engine.serverPath || engine.configuredServer || 'Eclipse JDT LS is not installed',
      problem: lastError || (state.state === 'error' ? state.message : engine.problems.join(' ')),
      restartLabel: active ? 'Restart Java' : state.state === 'error' ? 'Retry Java' : 'Start Java',
      downloadLabel: configured ? 'Install Managed Engine' : 'Download Java Engine',
      downloadInfo: engine.jdk ? 'Rocketbrain will reuse this JDK and install Eclipse JDT LS and the debugger in its own data folder.' :
        'Rocketbrain will download Temurin JDK 25 and install Eclipse JDT LS and the debugger in its own data folder.'
    });
  }

  async function receive(message) {
    const { action } = message || {};
    if (action === 'requestState') return refresh();
    if (action === 'settings') return settings();
    if (action === 'output') return output.show();
    if (!['download', 'pick-jdk', 'pick-engine', 'restart', 'enable-java', 'use-detected'].includes(action) || job || !vscode.workspace.isTrusted) return;
    job = action;
    lastError = undefined;
    try {
      if (action === 'download') {
        progress = 'Preparing download…';
        refresh();
        await install(runtime().jdk?.path || detectJdk()?.path, message => { progress = message; refresh(); });
      } else if (action === 'restart') {
        if (canStart()) await restart();
      } else if (action === 'enable-java') {
        await save('enabled', true);
      } else if (action === 'use-detected') {
        if (detectJdk()) await save('javaHome', undefined);
      } else {
        const jdk = action === 'pick-jdk';
        const selection = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
          canSelectMany: false, title: jdk ? 'Select a JDK 25 or newer' : 'Select the extracted Eclipse JDT LS directory',
          openLabel: jdk ? 'Use This JDK' : 'Use This Language Engine' });
        if (selection?.[0]?.scheme === 'file') await save(jdk ? 'javaHome' : 'serverPath', selection[0].fsPath);
      }
    } catch (error) {
      lastError = error.message;
      output.appendLine(`Java setup: ${error.message}`);
    } finally {
      job = undefined;
      refresh();
    }
  }

  function open({ automatic = false } = {}) {
    if (panel) {
      if (!automatic) panel.reveal(vscode.ViewColumn.Active);
      refresh();
      return;
    }
    const next = vscode.window.createWebviewPanel('rocketbrain.java.setup', 'Java Setup',
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    panel = next;
    const listener = next.webview.onDidReceiveMessage(message => receive(message).catch(error => {
      lastError = error.message;
      output.appendLine(`Java setup: ${error.message}`);
      refresh();
    }));
    next.onDidDispose(() => {
      listener.dispose();
      if (panel === next) panel = undefined;
    });
    next.webview.html = setupPage();
  }

  return { open, refresh, dispose: () => panel?.dispose() };
}

module.exports = { registerDesktopJavaSetup };
