'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ResultsView } = require('../src/results');
const { sortOptions } = require('../src/db/grid-sort');
const { browserRuntime } = require('./helpers/browser-runtime');

const runtime = browserRuntime();

test('snapshot sort controls send typed JSON paths and explicit NULL placement through the real Webview',
  { skip: runtime.skip, timeout: 30000 }, async t => {
    const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://rocketbrain.test/assets/*', route => {
      const asset = path.posix.basename(new URL(route.request().url()).pathname);
      return route.fulfill({ contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css',
        body: fs.readFileSync(path.join(__dirname, '../src/ui', asset), 'utf8') });
    });
    const columns = [
      { name: 'id', kind: 'integer', type: 'bigint unsigned', nullable: false, primaryKey: true },
      { name: 'payload', kind: 'json', type: 'json', nullable: true },
      { name: 'label', kind: 'text', type: 'varchar(8)', charset: 'utf8mb4', collation: 'utf8mb4_bin', nullable: true }
    ];
    const query = { page: 0, pageSize: 25, sort: [], filters: [] };
    const result = { columns: columns.map(column => column.name), rows: [[1, '{"group":[{"rank":5}]}', 'A']],
      rowCount: 1, durationMs: 1, state: { id: 'keyset:owned', readOnly: true, inTransaction: true },
      browse: { ...query, keyset: true, hasNext: false, pageable: true,
        sortOptions: sortOptions(columns, { utf8mb4: ['utf8mb4_general_ci'] }, true) },
      edit: { modelId: 'owned-fixture', table: 'fixture', columns, query, rowIds: ['key-1'], canEdit: false, insertable: false }
    };
    let receiver, posted = Promise.resolve(), offered;
    const v = { Uri: { joinPath: (...parts) => path.posix.join(...parts) },
      window: { showErrorMessage: message => errors.push(message) } };
    const results = new ResultsView(v, { extensionUri: '/virtual', subscriptions: [] }, {
      editAction(id, message) {
        if (message.type !== 'browseTable') return;
        offered = message.query;
        results.finish(id, { ...result, browse: { ...result.browse, ...offered }, edit: { ...result.edit, query: offered } });
        results.editState(id, { editResponseId: message.requestId });
      }
    });
    results.resolveWebviewView({ onDidDispose() {}, webview: { cspSource: 'https://rocketbrain.test',
      asWebviewUri: uri => 'https://rocketbrain.test/assets/' + path.posix.basename(uri),
      postMessage(data) {
        posted = posted.then(() => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), data));
        return posted;
      },
      onDidReceiveMessage(fn) { receiver = fn; return { dispose() {} }; } } });
    await posted;
    await page.exposeFunction('sendResult', message => receiver(message));
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.sendResult(message) }); });
    await page.setContent(results.view.webview.html);
    const id = results.begin('Owned snapshot view', 'MySQL');
    results.finish(id, result);
    await page.getByRole('button', { name: 'Sort and Filter' }).click();
    await page.getByRole('button', { name: 'Add Sort' }).click();
    await page.getByLabel('Sort column 1').selectOption('payload');
    assert.equal(await page.getByLabel('JSON sort type 1').inputValue(), 'text');
    await page.getByLabel('JSON sort type 1').selectOption('integer');
    await page.getByLabel('JSON sort path 1').fill('$.group[0].rank');
    await page.getByLabel('Sort direction 1').selectOption('desc');
    await page.getByLabel('Sort NULLs 1').selectOption('last');
    await page.getByRole('button', { name: 'Add Sort' }).click();
    await page.getByLabel('Sort column 2').selectOption('label');
    await page.getByLabel('Sort collation 2').selectOption('utf8mb4_general_ci');
    assert.equal(await page.getByLabel('Sort expression 2').count(), 0);
    await page.getByRole('button', { name: 'Apply Sort and Filters' }).click();
    await page.waitForFunction(() => !document.getElementById('apply-browse').disabled);
    assert.deepEqual(offered.sort, [
      { column: 'payload', direction: 'desc', nulls: 'last', jsonType: 'integer', jsonPath: '$.group[0].rank' },
      { column: 'label', direction: 'asc', collation: 'utf8mb4_general_ci' }
    ]);
    assert.deepEqual(errors, []);
  });
