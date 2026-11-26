'use strict';

const { platforms, auditProfile, exportProfile,activeContext } = require('./keyboard-profile');

const command = 'rocketbrain.keyboardProfile';

function reportText(report) {
  const annotation = routes => routes.reduce((sum, route) =>
    sum + route.overlaps.filter(item => item.scope === 'possible overlap').length, 0);
  const lines = [
    'Rocketbrain Keyboard Profile · ' + platforms[report.platform],
    'Workspace shortcuts are ' + (report.workspace.enabled ? 'enabled.' : 'disabled.'),
    report.routes.filter(route => route.available).length + ' of ' + report.routes.length + ' actions are registered.',
    report.manifestRules + ' extension contribution rules examined' + (report.manifestIncomplete ? ' (limit reached).' : '.'),
    report.suppliedInput ? report.suppliedRules + ' rules from the selected JSONC document.' : 'No keybindings JSONC was selected.',
    annotation(report.routes) + ' possible shortcut overlaps are listed below.',
    'The report compares the available sources. VS Code resolves installed shortcuts, layout and focus at runtime.',
    'To check an installed shortcut, use Keyboard Shortcuts → Show Same Keybindings or Keyboard Shortcuts Troubleshooting.'
  ];
  let group;
  for (const route of report.routes) {
    if (group !== route.group) {
      group = route.group;
      lines.push('', group);
    }
    lines.push(route.key + '  ' + route.title + (route.available ? '' : ' [command unavailable]'),
      '  ' + route.command, '  When ' + route.when);
    for (const row of route.overlaps) {
      const label = row.action === 'block' ? 'blocks this shortcut' : row.action === 'remove' ? 'removes ' + row.command : row.command;
      lines.push('  ' + row.relation + ' · ' + row.scope + ' · ' + row.source + ' · ' + label +
        (row.systemWide ? ' [system-wide]' : '') + (row.when ? ' · When ' + row.when : ''));
    }
    if (route.omitted) lines.push('  ' + route.omitted + ' additional matching entries omitted.');
  }
  return lines.join('\n') + '\n';
}

function registerKeyboardProfile(vscode,{workspaceState,extension}={}) {
  let active,disposed=false,applied,pending=Promise.resolve();
  const hasWorkspace = () => Boolean(vscode.workspace.workspaceFolders?.length);
  const saved = () => workspaceState?.get(activeContext,false)===true;
  const state = () => ({configured:saved(),enabled:applied===true && hasWorkspace(),hasWorkspace:hasWorkspace()});

  function queue(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function sync() {
    const enabled = !disposed && hasWorkspace() && saved();
    if (workspaceState && applied!==enabled) {
      await vscode.commands.executeCommand('setContext',activeContext,enabled);
      applied=enabled;
    }
    return state();
  }

  const ready = queue(sync);
  void ready.catch(error => { if(!disposed)void vscode.window.showErrorMessage('Rocketbrain: '+error.message); });

  async function workspaceStatus() {
    await pending;
    return state();
  }

  function setWorkspaceEnabled(enabled,cancellation) {
    return queue(async () => {
      if (disposed) throw Error('Keyboard Profile is closed.');
      if (cancellation?.isCancellationRequested) return state();
      if (typeof enabled!=='boolean' || !workspaceState || !hasWorkspace()) {
        throw Error('Open a workspace folder to change its keyboard profile.');
      }
      if (saved()!==enabled) await workspaceState.update(activeContext,enabled || undefined);
      return sync();
    });
  }

  async function inspect({ platform, input } = {}) {
    if (disposed) throw Error('Keyboard Profile is closed.');
    const commands = await vscode.commands.getCommands(true);
    const workspace = await workspaceStatus();
    if (disposed) throw Error('Keyboard Profile is closed.');
    return {...auditProfile(platform,{commands,manifests:vscode.extensions.all,input,ownerId:extension?.id}),workspace};
  }

  function selectedJson() {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.isClosed || !['json', 'jsonc'].includes(document.languageId)) return;
    return { document, version: document.version };
  }

  function currentInput(saved) {
    if (saved.document.isClosed || saved.document.version !== saved.version ||
      vscode.window.activeTextEditor?.document !== saved.document) {
      throw Error('The selected keybindings document changed. Review the current document again.');
    }
    return saved.document.getText();
  }

  async function open() {
    if (disposed) return;
    active?.cancel();
    const token = new vscode.CancellationTokenSource();
    active = token;
    const cancelled = () => disposed || token.token.isCancellationRequested;
    const source = selectedJson();
    try {
      const workspace = await workspaceStatus();
      if (cancelled()) return;
      const toggle = workspaceState && workspace.hasWorkspace ? [{
        label:workspace.configured?'Disable Shortcuts in This Workspace':'Enable 52 Shortcuts in This Workspace',
        description:'Applies to this workspace using the current VS Code platform',
        kind:'workspace',enabled:!workspace.configured
      }] : [];
      const target = await vscode.window.showQuickPick([...toggle,
        ...Object.entries(platforms).map(([platform,label]) => ({platform,label}))],
        {title:'Keyboard Profile',placeHolder:'Change workspace shortcuts or choose a platform to preview'},token.token);
      if (!target || cancelled()) return;
      if (target.kind==='workspace') {
        const workspace = await setWorkspaceEnabled(target.enabled,token.token);
        if (cancelled()) return;
        void vscode.window.showInformationMessage('Rocketbrain workspace shortcuts '+(workspace.enabled?'enabled.':'disabled.'));
        return {kind:target.enabled?'enable':'disable',workspace};
      }
      const choices = [
        { label: 'Preview Keyboard Profile', description: 'Compare installed extension shortcut contributions', kind: 'preview' },
        ...(source ? [{ label: 'Review Active Keybindings JSONC', description: 'Also compare the current JSON document', kind: 'audit' }] : []),
        { label: 'Export Keybindings JSONC', description: 'Open an untitled editor with registered actions', kind: 'export' },
        { label: 'Open Keyboard Shortcuts', description: 'Inspect individual shortcuts in VS Code', kind: 'shortcuts' }
      ];
      const choice = await vscode.window.showQuickPick(choices,
        { title: 'Keyboard Profile · ' + target.label, matchOnDescription: true }, token.token);
      if (!choice || cancelled()) return;
      if (choice.kind === 'shortcuts') return await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
      const audit = choice.kind === 'audit';
      const report = await inspect({ platform: target.platform, input: audit ? currentInput(source) : undefined });
      if (cancelled()) return;
      if (audit) currentInput(source);
      const exporting = choice.kind === 'export';
      const content = exporting ? exportProfile(report) : reportText(report);
      const document = await vscode.workspace.openTextDocument({ language: exporting ? 'jsonc' : 'plaintext', content });
      if (cancelled()) return;
      await vscode.window.showTextDocument(document, { preview: false });
      if (cancelled()) return;
      return { kind: choice.kind, rules: report.routes.length, document: document.uri };
    } catch (error) {
      if (!cancelled()) void vscode.window.showErrorMessage('Rocketbrain: ' + error.message);
    } finally {
      if (active === token) active = undefined;
      token.dispose();
    }
  }

  const subscription = vscode.commands.registerCommand(command,open);
  const folders = vscode.workspace.onDidChangeWorkspaceFolders?.(() => {
    void queue(sync).catch(error => { if(!disposed)void vscode.window.showErrorMessage('Rocketbrain: '+error.message); });
  });
  return {inspect,workspaceStatus,setWorkspaceEnabled,dispose() {
    if (disposed) return pending;
    disposed = true;
    active?.cancel();
    subscription.dispose();
    folders?.dispose();
    return queue(sync);
  }};
}

module.exports = { registerKeyboardProfile };
