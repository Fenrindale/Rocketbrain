'use strict';

const modeKey = 'rocketbrain.workspaceMode';
const modes = {
  all: { label: 'All Tools' },
  intellij: { label: 'IntelliJ IDEA', icon: 'code', description: 'Java and Spring', view: 'rocketbrain.project' },
  datagrip: { label: 'DataGrip', icon: 'database', description: 'Databases and SQL', view: 'rocketbrain.connections' }
};

async function registerWorkspaceMode(context, vscode) {
  const saved = context.workspaceState.get(modeKey);
  let current = typeof saved === 'string' && Object.hasOwn(modes, saved) ? saved : 'all';
  let pending = Promise.resolve();
  const items = new Map();

  function updateStatus() {
    for (const [mode, item] of items) {
      const { label, icon, description } = modes[mode];
      const selected = current === mode;
      item.text = `$(${selected ? 'check' : icon}) ${label}`;
      item.tooltip = selected ? `${label} mode active (${description})` : `Switch to ${label} mode (${description})`;
      item.accessibilityInformation = { label: item.tooltip, role: 'button' };
    }
  }

  for (const [mode, { label, view }] of Object.entries(modes)) {
    const command = `rocketbrain.mode.${mode}`;
    context.subscriptions.push(vscode.commands.registerCommand(command, () => {
      // Keep rapid clicks ordered across the asynchronous workspace write and view reveal.
      const change = pending.then(async () => {
        if (current !== mode) {
          await context.workspaceState.update(modeKey, mode);
          await vscode.commands.executeCommand('setContext', modeKey, mode);
          current = mode;
          updateStatus();
        }
        if (view) await vscode.commands.executeCommand(`${view}.focus`);
      });
      pending = change.catch(() => {});
      return change;
    }));

    if (view) {
      const item = vscode.window.createStatusBarItem(command, vscode.StatusBarAlignment.Left, 55 - items.size);
      item.name = `Rocketbrain: ${label} Mode`;
      item.command = command;
      items.set(mode, item);
      context.subscriptions.push(item);
    }
  }

  await vscode.commands.executeCommand('setContext', modeKey, current);
  updateStatus();
  for (const item of items.values()) item.show();
}

module.exports = { registerWorkspaceMode };
