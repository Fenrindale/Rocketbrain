'use strict';
const crypto = require('node:crypto');
const { ActuatorClient, RuntimeError, validateRuntimeUrl, compareRuntime, emptySnapshot } = require('./runtime-client');
const { registerRuntimeHealth } = require('./runtime-health-vscode');

function registerRuntimeSpring(vscode, context, output, { analyze }) {
  const subscriptions = [], events = new vscode.EventEmitter();
  subscriptions.push(events);
  let client = null, current = emptySnapshot(), generation = 0, disposed = false, refreshing = null;
  const configuration = () => vscode.workspace.getConfiguration('rocketbrain.spring.runtime');
  const snapshot = () => structuredClone(current);
  const emit = () => { if (!disposed) events.fire(snapshot()); };
  const assertTrusted = () => { if (disposed) throw new RuntimeError('DISPOSED', 'Spring runtime observation is closed.'); if (!vscode.workspace.isTrusted) { disconnect(); throw new RuntimeError('UNTRUSTED_WORKSPACE', 'Trust the workspace before connecting to a Spring runtime.'); } };
  const health = registerRuntimeHealth(vscode, { getClient: () => client, assertTrusted, onConnectionChange: events.event });
  subscriptions.push(health);
  function disconnect() { generation++; client?.dispose(); client = null; current = emptySnapshot(); emit(); return snapshot(); }

  async function connectionInput() {
    const url = await vscode.window.showInputBox({ title: 'Connect Spring runtime', prompt: 'Loopback Actuator base URL · only GET metadata is observed', value: current.baseUrl || configuration().get('url') || context.workspaceState.get('rocketbrain.spring.runtime.url') || 'http://127.0.0.1:8080/actuator', ignoreFocusOut: true, validateInput: value => { try { validateRuntimeUrl(value); return undefined; } catch (error) { return error.message; } } });
    if (url === undefined) return null;
    const canonical = validateRuntimeUrl(url).url.toString().replace(/\/$/, '');
    const workspaceId = vscode.workspace.workspaceFile?.toString() || vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join('|') || context.storageUri?.fsPath || '(empty workspace)';
    const secretId = 'rocketbrain.spring.runtime.auth.' + crypto.createHash('sha256').update(workspaceId + '\0' + canonical).digest('hex');
    const saved = await context.secrets.get(secretId);
    const choices = [...(saved ? [{ label: 'Use saved authentication', value: 'saved' }] : []), { label: 'No authentication · local development', value: 'none' }, { label: 'Bearer token', value: 'bearer' }, { label: 'Basic authentication', value: 'basic' }];
    const selection = await vscode.window.showQuickPick(choices, { title: 'Spring runtime authentication', ignoreFocusOut: true });
    if (!selection) return null;
    let authorization = '';
    if (selection.value === 'saved') authorization = saved;
    else if (selection.value === 'bearer') {
      const token = await vscode.window.showInputBox({ title: 'Spring runtime token', prompt: 'Stored in VS Code Secret Storage after connecting', password: true, ignoreFocusOut: true });
      if (token === undefined) return null; authorization = 'Bearer ' + token.trim();
    } else if (selection.value === 'basic') {
      const username = await vscode.window.showInputBox({ title: 'Spring runtime user', prompt: 'Basic authentication user name', ignoreFocusOut: true });
      if (username === undefined) return null;
      const password = await vscode.window.showInputBox({ title: 'Spring runtime password', prompt: 'Stored in VS Code Secret Storage after connecting', password: true, ignoreFocusOut: true });
      if (password === undefined) return null;
      if (/[\r\n:]/.test(username) || /[\r\n]/.test(password)) throw new RuntimeError('INVALID_AUTH', 'Basic credentials cannot contain line breaks; the user name cannot contain a colon.');
      authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    }
    return { url: canonical, authorization, secretId, saveAuthentication: selection.value !== 'saved' };
  }
  async function connect(options) {
    assertTrusted();
    const input = options || await connectionInput();
    if (!input) return snapshot();
    assertTrusted();
    const candidate = new ActuatorClient({ url: input.url, authorization: input.authorization, timeoutMs: input.timeoutMs ?? configuration().get('timeoutMs', 5000), maxResponseBytes: input.maxResponseBytes ?? configuration().get('maxResponseBytes', 2 * 1024 * 1024) });
    const epoch = ++generation; client?.dispose(); client = candidate;
    current = candidate.snapshot(); current.state = 'connecting'; emit();
    const observed = await candidate.refresh();
    if (disposed || epoch !== generation) return snapshot();
    assertTrusted(); current = observed; emit();
    if (input.secretId && input.saveAuthentication && ['connected', 'partial'].includes(current.state)) {
      if (input.authorization) await context.secrets.store(input.secretId, input.authorization);
      else await context.secrets.delete(input.secretId);
      await context.workspaceState.update('rocketbrain.spring.runtime.url', current.baseUrl);
    }
    output.appendLine(`Spring runtime observation: ${current.state}; ${current.counts.beans} Beans, ${current.counts.mappings} mappings. Property values and raw condition messages were discarded.`);
    return snapshot();
  }
  async function refresh() {
    assertTrusted();
    if (!client) throw new RuntimeError('NOT_CONNECTED', 'Connect to a loopback Spring runtime first.');
    if (refreshing) return refreshing;
    const candidate = client, epoch = generation;
    refreshing = (async () => {
      const observed = await candidate.refresh();
      if (!disposed && epoch === generation) { assertTrusted(); current = observed; emit(); }
      return snapshot();
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function compare() { return compareRuntime(await analyze(), snapshot()); }
  const command = (name, action) => subscriptions.push(vscode.commands.registerCommand(name, async (...args) => { try { return await action(...args); } catch (error) { output.appendLine(`Spring runtime: ${error.code || 'OPERATION_FAILED'}`); vscode.window.showErrorMessage(`Rocketbrain Spring: ${error.message}`); return undefined; } }));
  command('rocketbrain.spring.connectRuntime', () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Connecting to Spring runtime' }, () => connect()));
  command('rocketbrain.spring.refreshRuntime', refresh);
  command('rocketbrain.spring.disconnectRuntime', disconnect);
  command('rocketbrain.spring.runtimeHealth', health.open);
  command('rocketbrain.spring.compareRuntime', async () => {
    const comparison = await compare();
    vscode.window.showInformationMessage(`Spring comparison: ${comparison.summary.present} local Beans observed, ${comparison.summary.runtimeOnly} runtime-only, ${comparison.summary.notObserved} not observed.`);
    return comparison;
  });
  command('rocketbrain.spring.runtimeBeans', async () => {
    const value = snapshot();
    if (value.state === 'disconnected') throw new RuntimeError('NOT_CONNECTED', 'Connect to a loopback Spring runtime first.');
    const comparison = await compare();
    const selected = await vscode.window.showQuickPick(comparison.beans.map(bean => ({ label: bean.name, description: bean.observation, detail: bean.runtime.map(observed => `${observed.context} · ${observed.type}`).join('; '), bean })), { title: 'Spring Beans · observed runtime and separate local model', matchOnDescription: true, matchOnDetail: true });
    if (selected?.bean.source) { const source = selected.bean.source, range = source.range; await vscode.window.showTextDocument(vscode.Uri.parse(source.uri), { selection: new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character) }); }
  });
  return { connect, refresh, snapshot, disconnect, compare, health, onDidChange: events.event, dispose() { disposed = true; disconnect(); for (const item of subscriptions) item.dispose(); } };
}

module.exports = { registerRuntimeSpring };
