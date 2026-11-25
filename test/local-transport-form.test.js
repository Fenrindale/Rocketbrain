'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { browserRuntime } = require('./helpers/browser-runtime');
const { connectionHtml } = require('../src/db/connection-profiles-vscode');

const runtime = browserRuntime();
test('the live connection form submits only the selected IPC or TCP address and security fields', {
  skip: runtime.skip, timeout: 30000
}, async t => {
  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  await page.exposeFunction('__submitConnection', request => requests.push(request));
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({ postMessage: request => window.__submitConnection(request) });
  });
  await page.setContent(connectionHtml(randomBytes(24).toString('hex')));
  const model = { editorId: 'fixture', profile: { name: 'Example', group: '', color: 'none', host: '127.0.0.1',
    port: 3310, database: 'demo', user: 'demo', tls: { mode: 'disabled' } } };
  const send = data => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data);
  await send({ type: 'model', ...model });
  await page.locator('#transport').selectOption('named-pipe');
  assert.equal(await page.locator('#localAddressLabel').textContent(), 'Local pipe name');
  assert.equal(await page.locator('#tcpAddress').isVisible(), false);
  assert.equal(await page.locator('#tlsSettings').isVisible(), false);
  assert.equal(await page.locator('#sshSettings').isVisible(), false);
  await page.locator('#transportPath').fill('MySQL-Testing');
  await page.locator('[data-action=test]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Verifying'));
  assert.deepEqual(requests.at(-1).profile.transport, { kind: 'named-pipe', address: 'MySQL-Testing' });
  assert.ok(['host', 'port', 'tls', 'ssh'].every(key => !Object.hasOwn(requests.at(-1).profile, key)));
  await send({ type: 'result', result: { database: 'demo', serverVersion: '8.4', transport: { kind: 'named-pipe' } } });
  assert.match(await page.locator('#status').textContent(), /Windows named pipe/);

  await send({ type: 'model', ...model, profile: {
    name: 'Imported', database: 'demo', user: 'demo', color: 'none', transport: { kind: 'unix-socket' }
  }});
  assert.equal(await page.locator('#transport').inputValue(), 'unix-socket');
  assert.equal(await page.locator('#transportPath').inputValue(), '');
  assert.equal(await page.locator('#localAddressLabel').textContent(), 'Absolute socket path');
  await page.locator('#transportPath').fill('/run/mysql-test.sock');
  await page.locator('[data-action=test]').click();
  assert.deepEqual(requests.at(-1).profile.transport, { kind: 'unix-socket', address: '/run/mysql-test.sock' });
  await send({ type: 'result', result: { database: 'demo', serverVersion: '11.4', transport: { kind: 'unix-socket' } } });

  await send({ type: 'model', ...model });
  assert.equal(await page.locator('#transport').inputValue(), 'tcp');
  assert.equal(await page.locator('#localAddress').isVisible(), false);
  assert.equal(await page.locator('#tlsSettings').isVisible(), true);
  await page.locator('[data-action=test]').click();
  assert.ok(!Object.hasOwn(requests.at(-1).profile, 'transport'));
  assert.equal(requests.at(-1).profile.host, '127.0.0.1');
  assert.equal(requests.at(-1).profile.port, 3310);
});
