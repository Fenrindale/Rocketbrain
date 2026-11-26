'use strict';

const { platforms, auditProfile, exportProfile } = require('./keyboard-profile');

const command = 'rocketbrain.keyboardProfile';

function reportText(report) {
  const annotation = routes => routes.reduce((sum, route) =>
    sum + route.overlaps.filter(item => item.scope === 'possible overlap').length, 0);
  const lines = [
    'Rocketbrain Keyboard Profile · ' + platforms[report.platform],
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

function registerKeyboardProfile(vscode) {
  let active, disposed = false;

  async function inspect({ platform, input } = {}) {
    if (disposed) throw Error('Keyboard Profile is closed.');
    const commands = await vscode.commands.getCommands(true);
    if (disposed) throw Error('Keyboard Profile is closed.');
    return auditProfile(platform, { commands, manifests: vscode.extensions.all, input });
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
      const target = await vscode.window.showQuickPick(Object.entries(platforms).map(([platform, label]) => ({ platform, label })),
        { title: 'Keyboard Profile', placeHolder: 'Choose the system where you will use these shortcuts' }, token.token);
      if (!target || cancelled()) return;
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

  const subscription = vscode.commands.registerCommand(command, open);
  return { inspect, dispose() {
    disposed = true;
    active?.cancel();
    subscription.dispose();
  } };
}

module.exports = { registerKeyboardProfile };
