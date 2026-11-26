'use strict';

const assert = require('node:assert/strict');
const { assignment } = require('./kotlin-local-write');

const localValuesRequest = 'rocketbrain/readJavaValues';
const name = 'orderedMap';
const unsupported = ['oversizedMap', 'accessOrderMap', 'customMap', 'unorderedMap'];
const shown = (value, display) => assert.equal(value.display, display);
const boxed = (value, type, display) => assert.deepEqual([value.type, value.display], ['java.lang.' + type, display]);

function assertRootPage(page) {
  assert.equal(page.kind, 'orderedMap');
  assert.equal(page.length, 75);
  assert.equal(page.start, 0);
  assert.equal(page.rows.length, 32);
  boxed(page.rows[0].key, 'String', '"database"');
  boxed(page.rows[0].value, 'Integer', '42');
  assert.deepEqual(page.rows[1].key, { type: 'null', display: 'null' });
  assert.deepEqual(page.rows[1].value, { type: 'null', display: 'null' });
  boxed(page.rows[2].value, 'Long', '9007199254740999');
  boxed(page.rows[3].key, 'Boolean', 'false');
  boxed(page.rows[3].value, 'Boolean', 'true');
  boxed(page.rows[4].key, 'String', '"unicode🙂"');
  boxed(page.rows[4].value, 'String', '"fixture🙂"');
  assert.ok(page.rows[5].value.child);
  shown(page.rows[6].value, '<cycle>');
  shown(page.rows[7].value, '<opaque>');
  assert.equal(page.rows[6].value.child, undefined);
  assert.equal(page.rows[7].value.child, undefined);
}

async function assertKotlinCollections(send, frameId, change) {
  const read = (action, options = {}) => send(localValuesRequest, { action, frameId, name, start: 0, count: 32, ...options });
  const open = options => read('mapOpen', options);
  const page = ({snapshotId,viewId}, options) => read('mapPage', {snapshotId,viewId,...options});
  const child = (parent, index, slot) => page(parent, {viewId:parent.rows[index][slot].child});
  const locals = (await read('list')).values;
  assert.ok(locals.some(row => row.name === name && row.kind === 'orderedMap' && row.length === 75));
  for (const refused of unsupported) {
    assert.ok(!locals.some(row => row.name === refused));
    await assert.rejects(open({name:refused}), /exact insertion-order LinkedHashMap/u);
  }
  await assert.rejects(open({count:33}), /at most 32/u);
  await assert.rejects(open({start:-1}), /exact non-negative/u);
  const root = await open();
  assertRootPage(root);
  const second = await page(root, {start:32});
  const tail = await page(root, {start:64});
  assert.deepEqual([...root.rows, ...second.rows, ...tail.rows].map(row => row.index), Array.from({length:75},(_,i)=>i));
  boxed(second.rows[0].key, 'Integer', '32');
  boxed(tail.rows.at(-1).value, 'String', '"key-74"');
  assert.equal((await page(root, {start:75})).rows.length, 0);
  await assert.rejects(page(root, {start:76}), /collection snapshot/u);
  await assert.rejects(page(root, {viewId:'0'.repeat(36)}), /collection snapshot/u);
  await assert.rejects(page(root, {snapshotId:'0'.repeat(36)}), /collection snapshot/u);
  await assert.rejects(page(root, {name:'customMap'}), /collection snapshot/u);
  const list = await child(root, 5, 'value');
  assert.equal(list.kind, 'list');
  assert.equal(list.length, 3);
  shown(list.rows[0].value, 'null');
  const array = await child(list, 1, 'value');
  assert.equal(array.kind, 'array');
  boxed(array.rows[1].value, 'Long', '9007199254740997');
  const nestedMap = await child(list, 2, 'value');
  assert.equal(nestedMap.kind, 'orderedMap');
  boxed(nestedMap.rows[0].value, 'Boolean', 'false');
  const tree = await child(root, 8, 'value');
  assert.equal(tree.kind, 'orderedMap');
  assert.deepEqual(tree.rows.map(row => row.value.display), Array.from({length:12},(_,i)=>String(i)));
  assert.ok(tree.rows.every(row => row.key.type.endsWith('WatchTrapKey') && row.key.display === '<opaque>'));

  await change('map-value', 'Rocketbrain Kotlin map value changed by fixture');
  boxed((await page(root)).rows[0].value, 'Integer', '42');
  const refreshed = await open();
  boxed(refreshed.rows[0].value, 'Integer', '83');
  await assert.rejects(page(root), /collection snapshot/u);
  await change('map', 'Rocketbrain Kotlin map structure changed by fixture');
  await assert.rejects(page(refreshed), /map structure changed/u);
  const latest = await open();
  assert.equal(latest.length, 76);
  const permit = await send(assignment, {action:'prepare',frameId,name:'amount',literal:'42'});
  await send(assignment, {action:'apply',frameId,reviewId:permit.reviewId});
  await assert.rejects(page(latest), /collection snapshot/u);
  const final = await open();
  return {
    capturedEntries:75, indices:[0,32,64], typedCells:true, preciseLong:true, unicode:true, treeNodes:12,
    supportedNestedKinds:[list.kind,array.kind,nestedMap.kind], cycleOpaque:true, unsupportedMapsRefused:true,
    foreignTokensRefused:true, olderSnapshotRefused:true, capturedValueStable:true, structuralDriftRefused:true,
    debuggerWriteInvalidated:true, snapshotId:final.snapshotId, viewId:final.viewId
  };
}

async function assertNativeKotlinCollections(inspector, session) {
  const report = await inspector.inspect(session);
  assert.ok(report.values.some(row => row.name === name && row.kind === 'orderedMap'));
  for (const refused of unsupported) assert.ok(!report.values.some(row => row.name === refused));
  const root = await inspector.read(report, name);
  assertRootPage(root);
  const next = await inspector.readCollectionPage(root, {start:32});
  boxed(next.rows[0].key, 'Integer', '32');
  const list = await inspector.readNestedCollection(root, 5, 'value');
  const array = await inspector.readNestedCollection(list, 1, 'value');
  boxed(array.rows[1].value, 'Long', '9007199254740997');
  await assert.rejects(inspector.readNestedCollection(root,6,'value'), /supported nested value/u);
  await assert.rejects(inspector.readCollectionPage({...root}), /current Kotlin collection snapshot/u);
  const panel = await inspector.show(report, name);
  try {
    assert.equal(panel.viewType, 'rocketbrain.java.localValues');
    assert.match(panel.title, /Kotlin Map/u);
    assert.match(panel.webview.html, /Back to enclosing collection/u);
  } finally { panel.dispose(); }
  return { capturedEntries:75, secondPage:true, nestedListAndArray:true, cycleOpaque:true, unsupportedMapsRefused:true, nativePanel:true };
}

function assertKotlinCollectionsResumed(output, changed) {
  const summary = changed ? '76|83|0' : '75|42|0';
  assert.ok(output.includes('Rocketbrain Kotlin Ordered Map|' + summary), output);
  return { size: changed ? 76 : 75, databaseValue: changed ? 83 : 42, applicationSideEffects:0 };
}

module.exports = {localValuesRequest, assertKotlinCollections, assertNativeKotlinCollections, assertKotlinCollectionsResumed};
