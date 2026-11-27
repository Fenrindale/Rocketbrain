'use strict';

const assert = require('node:assert/strict');
const { setImmediate: flush } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');
const { compiledRegistration } = require('../desktop/patch-workbench.cjs');

function createWorkbench(initialMode = 'intellij') {
  const contextValues = new Map([
    ['rocketbrain.workspaceMode', initialMode],
    ['isWorkspaceTrusted', true],
    ['workspaceFolderCount', 1],
  ]);
  const kinds = new Map([
    ['workbench.view.extension.rocketbrain', 0], ['workbench.view.explorer', 0],
    ['workbench.view.debug', 0], ['workbench.view.extension.rocketbrain-query-panel', 1], ['outline', 0],
  ]);
  const visible = new Map();
  let panelPosition = 0;
  const events = [];
  const menus = [];
  let contextListener;
  let Workbench;
  const document = {
    defaultView: {},
    createElement(tag) {
      return {
        ownerDocument: document,
        tag, className: '', classList: { toggle() {}, remove() {} },
        children: [], dataset: {}, attributes: new Map(), listeners: new Map(),
        get lastElementChild() { return this.children.at(-1); },
        append(...elements) { this.children.push(...elements); },
        prepend(...elements) { this.children.unshift(...elements); },
        setAttribute(name, value) { this.attributes.set(name, value); },
        querySelector(selector) { return this.children.find(child => '.' + child.className === selector); },
        addEventListener(name, fn) { this.listeners.set(name, fn); },
        removeEventListener(name) { this.listeners.delete(name); },
        remove() {},
      };
    },
  };
  const root = document.createElement('main');
  const parts = new Map(['titlebar', 'editor', 'statusbar'].map(name => ['workbench.parts.' + name, document.createElement('div')]));
  const title = document.createElement('div');
  title.className = 'titlebar-container';
  parts.get('workbench.parts.titlebar').append(title);
  const left = document.createElement('div');
  left.className = 'titlebar-left';
  title.append(left);
  const statusItems = document.createElement('div');
  statusItems.className = 'left-items';
  parts.get('workbench.parts.statusbar').append(statusItems);

  const decorate = () => {};
  vm.runInNewContext(compiledRegistration(), {
    P: class { add() {} dispose() {} },
    F: { MenubarFileMenu: 'file', MenubarHelpMenu: 'help' },
    De: { appendMenuItems(items) { menus.push(...items); } },
    st(id, type, phase) {
      assert.equal(id, 'rocketbrain.desktop.workbench');
      assert.equal(phase, 3);
      Workbench = type;
    },
    rt: { AfterRestored: 3 },
    ye: decorate, ne: decorate, Ae: decorate, Co: decorate, Tt: decorate, Ed: decorate, hi: decorate,
  });

  const updateContext = (key, value) => {
    contextValues.set(key, value);
    contextListener({ affectsSome: keys => keys.has(key) });
  };
  new Workbench(
    {
      mainContainer: root,
      getContainer: (_window, part) => parts.get(part),
      getSize: () => ({ width: 800 }),
      isVisible: () => visible.has(1),
      setPartHidden(hidden, part) {
        events.push(['hidden', hidden, part]);
        if (hidden && part.endsWith('.panel')) visible.delete(1);
      },
      getPanelPosition: () => panelPosition,
      setPanelPosition(position) {
        panelPosition = position;
        events.push(['panel-position', position]);
      },
    },
    { async executeCommand(id) {
      events.push(['command', id]);
      if (id.startsWith('rocketbrain.mode.')) updateContext('rocketbrain.workspaceMode', id.split('.').at(-1));
    } },
    {
      getContextKeyValue: key => contextValues.get(key),
      onDidChangeContext(fn) { contextListener = fn; },
    },
    {
      getViewContainerById: id => kinds.has(id) ? { id } : null,
      getViewContainerLocation: ({ id }) => kinds.get(id),
      moveViewContainerToLocation({ id }, location) { kinds.set(id, location); },
      getViewDescriptorById: id => kinds.has(id) ? { id } : null,
      getViewLocationById: id => kinds.get(id),
      moveViewToLocation({ id }, location) { kinds.set(id, location); },
    },
    {
      async openViewContainer(id) {
        events.push(['open-container', id]);
        visible.set(kinds.get(id), id);
      },
      async openView(id) { events.push(['open-view', id]); },
      isViewContainerVisible: id => visible.get(kinds.get(id)) === id,
    },
    { async whenInstalledExtensionsRegistered() {} },
    { error: assert.fail },
  );

  const header = title.querySelector('.rb-workbench-header');
  const button = label => header.children.flatMap(group => group.children)
    .find(element => element.attributes.get('aria-label') === label);
  return { button, events, menus, kinds, root, updateContext };
}

test('the native shell docks Java and database tools around the editor and restores each mode', async () => {
  const { button, events, kinds, root } = createWorkbench();
  await flush();
  assert.equal(root.dataset.rocketbrainMode, 'java');
  assert.equal(button('Java Mode').attributes.get('aria-pressed'), 'true');
  assert.equal(kinds.get('workbench.view.debug'), 1);
  assert.equal(kinds.get('outline'), 2);
  assert.equal(events.some(event => event[0] === 'panel-position'), false);

  button('Database Mode').listeners.get('click')();
  await flush();
  assert.equal(root.dataset.rocketbrainMode, 'database');
  assert.equal(button('Database Mode').attributes.get('aria-pressed'), 'true');
  assert.equal(kinds.get('workbench.view.explorer'), 2);
  assert.ok(events.some(event => event[0] === 'panel-position' && event[1] === 2));
  assert.deepEqual(events.slice(-3), [
    ['open-container', 'workbench.view.extension.rocketbrain'],
    ['open-container', 'workbench.view.explorer'],
    ['open-container', 'workbench.view.extension.rocketbrain-query-panel'],
  ]);

  button('Java Mode').listeners.get('click')();
  await flush();
  assert.equal(kinds.get('workbench.view.explorer'), 0);
  assert.deepEqual(events.slice(-3), [
    ['open-container', 'workbench.view.extension.rocketbrain'],
    ['hidden', true, 'workbench.parts.panel'],
    ['open-view', 'outline'],
  ]);
});

test('the native shell uses real actions and observes workspace and SQL context enablement', async () => {
  const { button, events, menus, updateContext } = createWorkbench('datagrip');
  assert.equal(button('Run SQL').disabled, true);
  updateContext('rocketbrain.sqlToolbarRunnable', true);
  assert.equal(button('Run SQL').disabled, false);
  assert.equal(button('Commit').disabled, true);
  updateContext('rocketbrain.sqlToolbarPendingTransaction', true);
  assert.equal(button('Commit').disabled, false);
  updateContext('isWorkspaceTrusted', false);
  assert.equal(button('Run SQL').disabled, true);
  assert.equal(button('Run Java').disabled, true);
  updateContext('isWorkspaceTrusted', true);
  assert.equal(button('Run Java').disabled, false);

  button('Check for Updates').listeners.get('click')();
  button('Java Setup').listeners.get('click')();
  await flush();
  assert.deepEqual(menus.map(({ id, item }) => [id, item.command.id]), [
    ['file', 'rocketbrain.java.setup'],
    ['help', 'rocketbrain.desktop.checkForUpdates'],
  ]);
  assert.ok(events.some(event => event[1] === 'rocketbrain.desktop.checkForUpdates'));
  assert.ok(events.some(event => event[1] === 'rocketbrain.java.setup'));
});
