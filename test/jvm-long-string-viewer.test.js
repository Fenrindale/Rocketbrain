'use strict';

const assert = require('node:assert/strict');
const { Script } = require('node:vm');
const { test } = require('node:test');
const { createLocalValueInspection } = require('../src/java/debug-local-values');
const { JVM_STRING_PAGE_BUILD, KOTLIN_MAP_BUILD } = require('../src/java/debug-runtime');

const length = 290000;
const pageId = '4de42bee-74f0-4abe-96a5-709afe878882';

function harness(build = JVM_STRING_PAGE_BUILD) {
  const state = { state: 'stopped', stopVersion: 3, debugBuild: build, threadId: 9 };
  const requests = [], posted = [];
  const session = { type: 'rocketbrain-java', id: 'fixture', async customRequest(command, args) {
    requests.push({ command, ...args });
    if (command === 'stackTrace') return { stackFrames: [{ id: 7, name: 'fixtureJava' }] };
    if (args.action === 'list') return { values: [
      { name: 'longText', kind: 'string', length, pageable: true, complete: false },
      { name: 'unknownLayout', kind: 'string', length, complete: false },
      { name: 'shortText', kind: 'string', length: 5, complete: true },
      { name: 'map', kind: 'orderedMap', length: 4 }
    ] };
    if (args.action === 'string') return { kind: 'string', length: 5, text: 'short' };
    return fixture.respond(args);
  } };
  let listen, closed;
  const panel = { webview: { onDidReceiveMessage(callback) { listen = callback; return { dispose() {} }; },
    async postMessage(message) { posted.push(message); } }, onDidDispose(callback) { closed = callback; },
    dispose() { closed(); } };
  const debug = { activeDebugSession: session, activeStackItem: { session, frameId: 7, threadId: 9 } };
  const vscode = { debug, ViewColumn: { Beside: 2 }, window: { createWebviewPanel: () => panel } };
  const service = createLocalValueInspection(vscode, { getState: () => state, ensureTrusted() {} });
  const response = ({ start, count }) => {
    const units = Math.min(count, length - start);
    const text = start === 0 ? '\uD800' + '한'.repeat(units - 1) : 'z'.repeat(units);
    return { kind: 'stringPage', pageId, length, units, start, encoding: 'utf16le',
      base64: Buffer.from(text, 'utf16le').toString('base64') };
  };
  const fixture = { service, session, state, requests, panel, posted, debug, response, respond: response, message: x => listen(x) };
  return fixture;
}

test('the local value view reads a bound UTF-16 range and leaves existing short strings and v14 maps compatible', async () => {
  const fixture = harness(), { service, requests, panel } = fixture;
  const report = await service.inspect();
  assert.deepEqual(report.values.filter(item => item.pageable).map(item => item.name), ['longText']);
  assert.ok(report.values.some(item => item.kind === 'orderedMap'));
  assert.deepEqual(await service.read(report, 'shortText'), { kind: 'string', length: 5, text: 'short' });
  await assert.rejects(service.read(report, 'unknownLayout'), /beyond|unavailable/u);
  await assert.rejects(service.read(report, 'longText', { count: 8193 }), /8192/u);
  assert.equal(await service.show(report, 'longText'), panel);
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/u)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /isLongString \? 8192/u);
  await fixture.message({ type: 'ready' });
  assert.equal(fixture.posted.at(-1).result.text.charCodeAt(0), 0xd800);
  assert.equal(fixture.posted.at(-1).result.text.length, 8192);
  await fixture.message({ type: 'page', start: 8192 });
  assert.deepEqual(requests.at(-1), { command: 'rocketbrain/readJavaValues', action: 'stringPage',
    frameId: 7, name: 'longText', pageId, start: 8192, count: 8192 });
  assert.equal(fixture.posted.at(-1).result.text, 'z'.repeat(8192));
  service.dispose();

  const legacy = harness(KOTLIN_MAP_BUILD), old = await legacy.service.inspect();
  assert.ok(old.values.some(item => item.kind === 'orderedMap'));
  assert.ok(old.values.every(item => !item.pageable));
  await assert.rejects(legacy.service.read(old, 'longText'), /256 Ki/u);
  assert.deepEqual(await legacy.service.read(old, 'shortText'), { kind: 'string', length: 5, text: 'short' });
});

test('String continuation refuses forged state, mismatched wire metadata and the changed focus or stop', async () => {
  const fixture = harness(), { service, state, debug } = fixture;
  const report = await service.inspect();
  const page = await service.read(report, 'longText', { start: 0, count: 2 });
  assert.equal(page.text, '\uD800한');
  await assert.rejects(service.readStringPage({ ...page }, { start: 2 }), /Open the current long String/u);
  for (const altered of [{ base64: '####' }, { base64: 'AAA' }, { start: 0 }, { units: 2 }, { encoding: 'utf8' },
    { pageId: '6829fb42-83b1-46be-b501-236e7f5889aa' }]) {
    fixture.respond = args => ({ ...fixture.response(args), ...altered });
    await assert.rejects(service.readStringPage(page, { start: 2, count: 1 }), /invalid String page/u);
  }
  fixture.respond = fixture.response;
  assert.equal((await service.readStringPage(page, { start: length })).text, '');
  debug.activeStackItem.frameId = 8;
  await assert.rejects(service.readStringPage(page, { start: 2 }), /different position/u);
  debug.activeStackItem.frameId = 7;
  fixture.respond = args => { state.stopVersion++; return fixture.response(args); };
  await assert.rejects(service.readStringPage(page, { start: 2 }), /different position/u);
});
