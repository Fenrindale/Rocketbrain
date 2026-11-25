'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ResultsView } = require('../src/results');
const { TableEditor } = require('../src/table-editor');
const { browserRuntime } = require('./helpers/browser-runtime');
const { start, extend, present, limits } = require('../src/db/grid-window');
const { createResultExport } = require('../src/db/result-export');

const runtime = browserRuntime();
function captured(page, pageSize = 25, value = number => 'row ' + number) {
  const rows = Array.from({ length: pageSize }, (_, index) => [page * pageSize + index + 1, value(page * pageSize + index + 1)]);
  const columns = [{ name: 'id', type: 'int', kind: 'integer', primaryKey: true }, { name: 'name', type: 'varchar(30)', kind: 'text' }];
  const query = { page, pageSize, sort: [], filters: [] };
  return { columns: ['id', 'name'], rows, rowCount: rows.length, durationMs: 1, state: { id: 'keyset:owned', readOnly: true, inTransaction: true },
    browse: { ...query, keyset: true, pageable: true, hasNext: page < 6, hasPrevious: page > 0 },
    edit: { modelId: 'fixture-' + page, table: 'people', query, rowIds: rows.map(([id]) => 'key-' + id), columns,
      canEdit: false, reason: 'Read-only snapshot', insertable: false } };
}

test('continuous table windows evict whole pages opposite the movement and enforce the byte bound', () => {
  const first = captured(0, 1, () => 'x'.repeat(limits.bytes / 2));
  const second = captured(1, 1, () => 'y'.repeat(limits.bytes / 2));
  let window = extend(start(first), second, 'next');
  assert.deepEqual(window.pages.map(page => page.page), [1]);
  window = extend(window, first, 'previous');
  assert.deepEqual(window.pages.map(page => page.page), [0]);
  assert.throws(() => extend(window, captured(3), 'next'), /changed/u);
  const a = { ...captured(0), spatial: [{ row: 4, cells: { 1: 'point-a' } }] };
  const b = { ...captured(1), spatial: [{ row: 0, cells: { 1: 'point-b' } }] };
  const folded = present(extend(start(a), b, 'next'), b);
  assert.deepEqual(folded.rows.map(([id]) => id), Array.from({ length: 50 }, (_, index) => index + 1));
  assert.equal(folded.browse.page, 0);
  assert.equal(folded.browse.window.lastPage, 1);
  assert.deepEqual(folded.spatial.map(({ row }) => row), [4, 25]);
  const exported = JSON.parse(createResultExport(folded, 'json').data);
  assert.deepEqual([exported.page, exported.lastPage, exported.rowCount], [1, 2, 50]);
});

test('continuous result Webview loads lazily on wheel movement and restores its visible row when pages roll',
  { skip: runtime.skip, timeout: 30000 }, async t => {
    const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 460 } });
    const errors = [], reads = [], messages = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://rocketbrain.test/**', async route => {
      const asset = route.request().url().split('/').at(-1);
      const css = asset === 'results.css';
      await route.fulfill({ contentType: css ? 'text/css' : 'application/javascript', body:
        (css ? fs.readFileSync(path.join(__dirname, 'helpers/webview-palette.css'), 'utf8') : '') +
        fs.readFileSync(path.join(__dirname, '../src/ui', asset), 'utf8') });
    });
    let receive, controller, lastPost = Promise.resolve(), releasePage;
    const waiting = new Promise(resolve => { releasePage = resolve; });
    const db = { async openKeysetBrowser() { return { id: 'owned', result: captured(0) }; }, async closeKeysetBrowser() {},
      getSessionState: () => ({ readOnly: true }), async readKeysetPage(_id, { page }, from) {
        reads.push([page, from]);
        if (reads.length === 1) await waiting;
        return captured(page);
      } };
    const results = new ResultsView({ Uri: { joinPath: (root, ...segments) => path.posix.join(root, ...segments), file: value => value },
      workspace: { isTrusted: true }, window: { showErrorMessage: message => { throw Error(message); } } },
    { extensionUri: '/fixture', subscriptions: [] }, { editAction: (id, action) => controller.handle(id, action) });
    const connection = { db, mysql: true, epoch: 1, label: 'Owned scroll UI' };
    controller = new TableEditor({ results, connection: () => connection, trusted: () => true });
    t.after(() => controller.dispose());
    results.resolveWebviewView({ webview: { cspSource: 'https://rocketbrain.test',
      asWebviewUri: uri => 'https://rocketbrain.test/' + path.posix.basename(uri),
      onDidReceiveMessage: handler => { receive = handler; return { dispose() {} }; },
      postMessage(data) { lastPost = lastPost.then(() => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data)); return lastPost; }
    }, onDidDispose() {} });
    await page.exposeFunction('__postToHost', message => { messages.push(message.type); return receive(message); });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.__postToHost(message) }); });
    await page.setContent(results.view.webview.html, { waitUntil: 'networkidle' });
    await controller.openKeyset({ table: 'people' });
    await lastPost;
    const toggle = page.getByRole('checkbox', { name: 'Continuous scroll' });
    await toggle.check();
    await page.waitForFunction(() => document.getElementById('continuous-scroll').checked && !document.getElementById('continuous-scroll').disabled);
    assert.equal(reads.length, 0);
    const grid = page.locator('#grid');
    await grid.hover();
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => document.getElementById('continuous-scroll').disabled);
    assert.deepEqual(reads, [[1, 0]]);
    const anchor = await grid.evaluate(control => {
      const top = control.getBoundingClientRect().top + control.querySelector('thead').getBoundingClientRect().height;
      const visible = [...control.querySelectorAll('[data-snapshot-row]')].find(row => row.getBoundingClientRect().bottom > top);
      return { id: visible.dataset.snapshotRow, top: visible.getBoundingClientRect().top };
    });
    releasePage();
    await page.waitForFunction(() => document.getElementById('page-label').textContent.startsWith('Pages 1–2') && !document.getElementById('continuous-scroll').disabled);
    const topAfter = await page.locator('[data-snapshot-row="' + anchor.id + '"]').evaluate(row => row.getBoundingClientRect().top);
    assert.ok(Math.abs(topAfter - anchor.top) <= 1, `${anchor.top} to ${topAfter}`);
    assert.equal(messages.filter(type => type === 'scrollTable').length, 1);
    for (const range of ['Pages 1–3', 'Pages 1–4', 'Pages 2–5', 'Pages 3–6']) {
      await page.getByRole('button', { name: 'Next Page' }).click();
      await page.waitForFunction(expected => document.getElementById('page-label').textContent.startsWith(expected) && !document.getElementById('continuous-scroll').disabled, range);
    }
    assert.equal(await page.locator('#grid tbody tr').count(), 100);
    assert.equal(await page.locator('#grid tbody tr').first().getAttribute('data-snapshot-row'), '51');
    await page.getByRole('button', { name: 'Previous Page' }).click();
    await page.waitForFunction(() => document.getElementById('page-label').textContent.startsWith('Pages 2–5') && !document.getElementById('continuous-scroll').disabled);
    assert.deepEqual(reads.at(-1), [1, 2]);
    await toggle.uncheck();
    await page.waitForFunction(() => document.getElementById('page-label').textContent.startsWith('Page 2') && !document.getElementById('continuous-scroll').checked);
    assert.equal(await page.locator('#grid tbody tr').count(), 25);
    assert.deepEqual(errors, []);
  });
