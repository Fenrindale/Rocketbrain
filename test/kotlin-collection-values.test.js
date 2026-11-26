'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLocalValueInspection } = require('../src/java/debug-local-values');
const { KOTLIN_BOX_BUILD, KOTLIN_MAP_BUILD } = require('../src/java/debug-runtime');

const capture = '410e2623-be8c-4fd7-a567-cdbd4ade1673';
const root = '70e31c92-ed22-4543-b9b7-1336c82cad31';
const nested = '521f0696-eed5-41d3-9e1d-c091f0d93ac1';
const item = (type, display, child) => ({ type, display, ...(child && { child }) });
const entries = [
  { index: 0, key: item('java.lang.String', '"first"'), value: item('java.util.ArrayList', '1 entries', nested) },
  { index: 1, key: item('null', 'null'), value: item('java.lang.Long', '9007199254740999') }
];

function setup() {
  const state = { state: 'stopped', threadId: 9, stopVersion: 3, debugBuild: KOTLIN_MAP_BUILD };
  const requests = [], posted = [];
  const session = { id: 'fixture', type: 'rocketbrain-java', async customRequest(method, args) {
    if (method === 'stackTrace') return { stackFrames: [{ id: 1, name: 'paused' }, { id: 2, name: 'caller' }] };
    requests.push({ ...args });
    if (args.action === 'list') return { values: [{ name: 'map', kind: 'orderedMap', length: 2 }] };
    const isChild = args.viewId === nested;
    const rows = isChild ? [{ index: 0, value: item('null', 'null') }] : entries;
    return { kind: isChild ? 'list' : 'orderedMap', snapshotId: capture, viewId: isChild ? nested : root,
      length: rows.length, start: args.start, rows: rows.slice(args.start, args.start + args.count) };
  } };
  let receive;
  const panel = { webview: {
    onDidReceiveMessage(callback) { receive = callback; return { dispose() {} }; },
    async postMessage(packet) { posted.push(packet); }
  }, onDidDispose() {}, dispose() {} };
  const vscode = { debug: { activeDebugSession: session, activeStackItem: { session, frameId: 1, threadId: 9 } },
    ViewColumn: { Beside: 2 }, window: { createWebviewPanel() { return panel; } } };
  const inspector = createLocalValueInspection(vscode, { getState: () => state, ensureTrusted() {} });
  return { inspector, state, vscode, requests, posted, panel, receive: message => receive(message) };
}

test('a Kotlin map snapshot only exposes an observed nested value and the same paused frame', async () => {
  const {inspector, requests, vscode} = setup();
  const report = await inspector.inspect();
  await assert.rejects(inspector.read(report, 'map', {count:33}), /up to 32/u);
  const first = await inspector.read(report, 'map', {count:1});
  assert.deepEqual(first.rows, [entries[0]]);
  assert.deepEqual((await inspector.readCollectionPage(first, {start:1})).rows, [entries[1]]);
  const child = await inspector.readNestedCollection(first, 0, 'value');
  assert.equal(child.kind, 'list');
  assert.deepEqual(child.rows, [{index:0,value:{type:'null',display:'null'}}]);
  assert.deepEqual(requests.at(-1), {action:'mapPage',frameId:1,name:'map',start:0,count:32,snapshotId:capture,viewId:nested});
  await assert.rejects(inspector.readNestedCollection(first, 0, 'key'), /supported nested value/u);
  await assert.rejects(inspector.readCollectionPage({...child}), /current Kotlin collection snapshot/u);
  vscode.debug.activeStackItem.frameId = 2;
  await assert.rejects(inspector.readCollectionPage(child), /different position/u);
});

test('the collection panel opens a nested page and returns to the enclosing snapshot', async () => {
  const {inspector, state, receive, posted, panel} = setup();
  state.debugBuild = KOTLIN_BOX_BUILD;
  assert.deepEqual((await inspector.inspect()).values, []);
  state.debugBuild = KOTLIN_MAP_BUILD;
  const report = await inspector.inspect();
  assert.equal(await inspector.show(report, 'map'), panel);
  await receive({type:'ready'});
  assert.equal(posted.at(-1).result.kind, 'orderedMap');
  await receive({type:'child',index:0,slot:'value'});
  assert.deepEqual([posted.at(-1).depth,posted.at(-1).result.kind], [1,'list']);
  await receive({type:'parent'});
  assert.deepEqual([posted.at(-1).depth,posted.at(-1).result.kind], [0,'orderedMap']);
  state.stopVersion++;
  await receive({type:'page',start:1});
  assert.equal(posted.at(-1).type, 'error');
});
