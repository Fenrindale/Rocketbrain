'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { compiledRegistration } = require('../desktop/patch-workbench.cjs');

function createActions(startingPanel) {
  const menuItems = [];
  const commands = new Map();
  const events = [];
  const commandService = {};
  const paneService = {};
  vm.runInNewContext(compiledRegistration(), {
    A: { fileCode: 'fileCode', database: 'database', play: 'play', debugAlt: 'debugAlt', listTree: 'listTree', terminal: 'terminal', table: 'table' },
    Ke: { registerCommand(id, run) { commands.set(id, run); } },
    ye: commandService,
    F: { TitleBarAdjacentCenter: 'native-titlebar' },
    De: { appendMenuItems(items) { menuItems.push(...items); } },
    D: {
      equals: (key, value) => context => context[key] === value,
      notEquals: (key, value) => context => context[key] !== value,
      has: key => context => Boolean(context[key]),
      greater: (key, value) => context => context[key] > value,
      and: (...conditions) => context => conditions.every(condition => condition(context)),
    },
    Ra: paneService,
  });
  const services = new Map([
    [commandService, { async executeCommand(id) { events.push(id); } }],
    [paneService, {
      getActivePaneComposite(location) {
        assert.equal(location, 1);
        return startingPanel ? { getId: () => startingPanel } : undefined;
      },
      hideActivePaneComposite(location) { events.push(`hide:${location}`); },
    }],
  ]);
  return { menuItems, commands, events, accessor: { get: id => services.get(id) } };
}

test('the pinned Code OSS patch registers app mode and workflow items in the native title bar', () => {
  const { menuItems } = createActions();
  const forContext = context => menuItems.filter(({ item }) => !item.when || item.when(context)).map(({ item }) => item.command);
  assert.equal(menuItems.every(item => item.id === 'native-titlebar'), true);
  const java = forContext({});
  assert.deepEqual(java.map(command => command.title), ['Java Mode', 'Database Mode', 'Run Java', 'Debug Java']);
  assert.equal(java[0].toggled({}), true);
  assert.equal(java[2].precondition({isWorkspaceTrusted: true, workspaceFolderCount: 0}), false);
  assert.equal(java[2].precondition({isWorkspaceTrusted: true, workspaceFolderCount: 1}), true);

  const databaseContext = {'rocketbrain.workspaceMode': 'datagrip', isWorkspaceTrusted: true};
  const database = forContext(databaseContext);
  assert.deepEqual(database.map(command => command.title), ['Java Mode', 'Database Mode', 'Database Explorer', 'Open SQL Console', 'Run SQL', 'Query Results']);
  assert.equal(database[1].toggled(databaseContext), true);
  assert.equal(database[4].precondition(databaseContext), false);
  assert.equal(database[4].precondition({...databaseContext, 'rocketbrain.sqlToolbarRunnable': true}), true);
});

test('the Java title action closes only the active Rocketbrain query-results pane', async () => {
  const selectJava = 'rocketbrain.desktop.workbench.selectJava';
  const forResults = createActions('rocketbrain-query-panel');
  await forResults.commands.get(selectJava)(forResults.accessor);
  assert.deepEqual(forResults.events, ['rocketbrain.mode.intellij', 'hide:1']);

  const forTerminal = createActions('terminal');
  await forTerminal.commands.get(selectJava)(forTerminal.accessor);
  assert.deepEqual(forTerminal.events, ['rocketbrain.mode.intellij']);
});
