'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerWorkspaceMode } = require('../src/workspace-mode');

const modeKey = 'rocketbrain.workspaceMode';
const intellijCommand = 'rocketbrain.mode.intellij';
const datagripCommand = 'rocketbrain.mode.datagrip';
const allCommand = 'rocketbrain.mode.all';

function host(state = new Map(), write = async (key, value) => state.set(key, value)) {
  const commands = new Map(), items = new Map(), calls = [];
  const context = {
    subscriptions: [],
    workspaceState: { get: key => state.get(key), update: write }
  };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem(id) {
        const item = { show() { this.visible = true; }, dispose() { items.delete(id); } };
        items.set(id, item);
        return item;
      }
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      async executeCommand(id, ...args) {
        if (commands.has(id)) return commands.get(id)(...args);
        calls.push([id, ...args]);
      }
    }
  };
  return { context, vscode, state, calls, items, run: vscode.commands.executeCommand };
}

test('status buttons select and focus each mode while restoring all tools from the palette', async () => {
  const h = host();
  await registerWorkspaceMode(h.context, h.vscode);
  const idea = h.items.get(intellijCommand);
  const dataGrip = h.items.get(datagripCommand);
  assert.equal(idea.visible, true);
  assert.equal(dataGrip.visible, true);
  assert.deepEqual(h.calls, [['setContext', modeKey, 'all']]);
  assert.match(idea.accessibilityInformation.label, /^Switch to IntelliJ IDEA/);

  await h.run(idea.command);
  assert.equal(idea.text, '$(check) IntelliJ IDEA');
  assert.match(idea.accessibilityInformation.label, /mode active/);
  assert.equal(h.state.get(modeKey), 'intellij');

  await h.run(dataGrip.command);
  assert.equal(dataGrip.text, '$(check) DataGrip');
  assert.doesNotMatch(idea.text, /\$\(check\)/);
  assert.equal(h.state.get(modeKey), 'datagrip');

  await h.run(allCommand);
  assert.equal(h.state.get(modeKey), 'all');
  assert.doesNotMatch(dataGrip.text, /\$\(check\)/);
  assert.deepEqual(h.calls, [
    ['setContext', modeKey, 'all'],
    ['setContext', modeKey, 'intellij'],
    ['rocketbrain.project.focus'],
    ['setContext', modeKey, 'datagrip'],
    ['rocketbrain.connections.focus'],
    ['setContext', modeKey, 'all']
  ]);
});

test('remembered modes are restored without moving focus and invalid values show all tools', async () => {
  for (const [saved, expected] of [['datagrip', 'datagrip'], ['unknown', 'all'], [['intellij'], 'all']]) {
    const h = host(new Map([[modeKey, saved]]));
    await registerWorkspaceMode(h.context, h.vscode);
    assert.deepEqual(h.calls, [['setContext', modeKey, expected]]);
    assert.equal(h.state.get(modeKey), saved);
  }
});

test('standalone default and mode buttons use the project and database workspaces', async () => {
  const h = host();
  h.vscode.env = { appName: 'Rocketbrain' };
  await registerWorkspaceMode(h.context, h.vscode);
  assert.equal(h.items.size, 0);
  assert.deepEqual(h.calls, [['setContext', modeKey, 'intellij']]);

  await h.run(datagripCommand);
  assert.equal(h.state.get(modeKey), 'datagrip');
  await h.run(intellijCommand);
  assert.equal(h.state.get(modeKey), 'intellij');
  assert.deepEqual(h.calls, [
    ['setContext', modeKey, 'intellij'],
    ['setContext', modeKey, 'datagrip'],
    ['rocketbrain.showQueryResults'],
    ['rocketbrain.databases.focus'],
    ['setContext', modeKey, 'intellij'],
    ['rocketbrain.project.focus']
  ]);
});

test('standalone restores saved workspace modes', async () => {
  const h = host(new Map([[modeKey, 'datagrip']]));
  h.vscode.env = { appName: 'Rocketbrain Desktop' };
  await registerWorkspaceMode(h.context, h.vscode);
  assert.equal(h.items.size, 0);
  assert.deepEqual(h.calls, [['setContext', modeKey, 'datagrip']]);
});

test('rapid selections and a failed workspace write do not overwrite the latest mode', async () => {
  const state = new Map();
  const writes = [];
  const h = host(state, async (key, value) => {
    writes.push(value);
    if (writes.length === 1) throw new Error('Workspace write failed');
    state.set(key, value);
  });
  await registerWorkspaceMode(h.context, h.vscode);
  const failed = h.run(intellijCommand);
  const next = h.run(datagripCommand);
  const final = h.run(intellijCommand);
  await assert.rejects(failed, /Workspace write failed/);
  await Promise.all([next, final]);
  assert.deepEqual(writes, ['intellij', 'datagrip', 'intellij']);
  assert.equal(state.get(modeKey), 'intellij');
  assert.equal(h.items.get(intellijCommand).text, '$(check) IntelliJ IDEA');
  assert.equal(h.items.get(datagripCommand).text, '$(database) DataGrip');
});
