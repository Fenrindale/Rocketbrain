'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserRuntime } = require('./helpers/browser-runtime');
const { buildDiagram, defaultLayout } = require('../src/db/schema-erd');
const { diagramHtml } = require('../src/db/schema-erd-view');
const { parseDiagramPng } = require('../src/db/schema-erd-vscode');

const runtime = browserRuntime();

test('diagram browser draws and navigates FKs, moves cards, round-trips positions and sends a PNG', {
  skip: runtime.skip, timeout: 25000
}, async () => {
  const pk = { name: 'id', type: 'int', primaryKey: true, nullable: false };
  const maliciousLookingName = '<img src=sample>';
  const diagram = buildDiagram({
    database: 'fixture', tables: [
      { name: 'parent', kind: 'table', columns: [pk] },
      { name: 'child', kind: 'table', columns: [pk, { name: maliciousLookingName, type: 'int' }],
        foreignKeys: [{ name: 'related', referencedSchema: 'fixture', referencedTable: 'parent',
          columns: [{ name: maliciousLookingName, referencedColumn: 'id', ordinal: 1 }] }] }
    ], views: [], coverage: { foreignKeys: 'loaded' }
  }, { focus: 'child' });
  const layout = defaultLayout(diagram);
  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const errors = [], requests = [], sent = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    await page.exposeFunction('hostMessage', message => sent.push(message));
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.hostMessage(message) }); });
    await page.setContent(diagramHtml('testlocaldiagram'));
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })),
      { type: 'diagram', token: 'test', diagram, layout, defaultLayout: layout, logicalAvailable: false });
    assert.equal(await page.locator('#entity').inputValue(), 'child');
    assert.equal(await page.locator('img').count(), 0);
    assert.match(await page.locator('#attributes').textContent(), /<img src=sample>/);
    await page.getByRole('button', { name: '→ parent' }).click();
    assert.equal(await page.locator('#entity').inputValue(), 'parent');
    await page.getByRole('button', { name: 'Open Table Preview' }).click();
    assert.equal(sent.find(message => message.type === 'openTable').name, 'parent');
    await page.getByRole('spinbutton', { name: 'X' }).fill('175');
    await page.getByRole('spinbutton', { name: 'Y' }).fill('245');
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    const bounds = await page.locator('canvas').boundingBox();
    await page.mouse.move(bounds.x + 180, bounds.y + 250);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 197, bounds.y + 263, { steps: 3 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Export Layout', exact: true }).click();
    const changed = sent.find(message => message.type === 'exportLayout').layout;
    assert.deepEqual(changed.positions.find(position => position.name === 'parent'), { name: 'parent', x: 192, y: 258 });
    await page.getByRole('button', { name: 'Reset Positions' }).click();
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })),
      { type: 'layout', token: 'test', layout: changed });
    assert.equal(await page.getByRole('spinbutton', { name: 'Y' }).inputValue(), '258');
    assert.equal(await page.getByRole('status').textContent(), 'Layout imported');
    await page.getByRole('button', { name: 'Export PNG' }).click();
    const deadline = Date.now() + 5000;
    while (!sent.some(message => message.type === 'exportPng') && Date.now() < deadline) await page.waitForTimeout(30);
    const png = parseDiagramPng(sent.find(message => message.type === 'exportPng').image);
    assert.equal(png.width, await page.locator('canvas').getAttribute('width').then(Number));
    assert.equal(png.height, await page.locator('canvas').getAttribute('height').then(Number));
    assert.ok(png.data.length > 1000);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  } finally { await browser.close(); }
});
