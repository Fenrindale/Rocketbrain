'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { browserRuntime } = require('./helpers/browser-runtime');
const { verifyGridMultipagePaste } = require('./grid-multipage-paste-host');
const { MysqlService } = require('../src/db/mysql');
const { ResultsView } = require('../src/results');
const { TableEditor } = require('../src/table-editor');

const springConfig = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
const runtime = browserRuntime();

test('the real grid form merges a reviewed paste across three server pages in an actual Spring database', {
  skip: runtime.skip || (!springConfig && 'Run the disposable Spring/MySQL or MariaDB fixture.'), timeout: 90000
}, async t => {
  const spring = JSON.parse(await fs.readFile(springConfig, 'utf8'));
  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!['results.js', 'results.css'].includes(name)) { await route.abort(); return; }
    const body = await fs.readFile(path.join(__dirname, '../src/ui', name), 'utf8');
    await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : 'text/css', body });
  });
  let db, controller, receive, id, pending = Promise.resolve();
  const results = new ResultsView({
    Uri: { joinPath: (root, ...parts) => path.posix.join(root, ...parts), file: value => value },
    workspace: { isTrusted: true }, window: {}
  }, { extensionUri: '/virtual/rocketbrain', subscriptions: [] }, { editAction: (id, message) => controller.handle(id, message) });
  results.resolveWebviewView({ webview: {
    cspSource: 'https://rocketbrain.test', asWebviewUri: uri => 'https://rocketbrain.test/' + path.posix.basename(uri),
    onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; },
    postMessage(data) {
      pending = pending.then(() => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data));
      return pending;
    }
  }, onDidDispose() {} });
  await pending;
  await page.exposeFunction('__postToHost', message => receive(message));
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({ postMessage: message => window.__postToHost(message),
      getState: () => window.__state, setState: state => { window.__state = structuredClone(state); } });
  });
  await page.setContent(results.view.webview.html, { waitUntil: 'networkidle' });
  const record = () => results.history.find(row => row.id === id);
  const report = await verifyGridMultipagePaste(spring, {
    record,
    async connect(config, table) {
      db = new MysqlService(config);
      await db.openSession('multipage', { readOnly: true });
      const connection = { db, mysql: true, epoch: 1, label: 'Owned spring database' };
      controller = new TableEditor({ results, connection: () => connection, trusted: () => true,
        withSession: async (_sessionId, action) => action() });
      id = await controller.open({ table, sessionId: 'multipage', sql: 'SELECT * FROM `' + table + '`' });
      await pending;
    },
    async action(type, options) {
      const before = record(), revision = before.draftRevision || 0;
      if (type === 'prepareBulk') {
        const button = page.locator('#paste-cells');
        assert.equal(await button.isEnabled(), true, 'Paste stays available while an unreviewed draft exists.');
        await button.click();
        await page.locator('#bulk-row').selectOption(options.anchorRowId);
        await page.locator('#bulk-column').selectOption(options.anchorColumn);
        if (options.acrossPages) {
          await page.locator('#bulk-across-pages').check();
          assert.match(await page.locator('#bulk-summary').textContent(), /primary keys in Review SQL/);
        }
        await page.locator('#bulk-text').fill(options.text);
        await page.locator('#bulk-stage').click();
        await page.waitForFunction(() => !(window.__state?.drafts ?? []).some(([, draft]) => draft.pendingRequestId));
        await pending;
        if (record().editError) throw Error(record().editError);
        await page.waitForFunction(revision => (window.__state?.drafts ?? [])[0]?.[1]?.revision === revision + 1, revision);
        assert.equal(record().draftRevision, revision + 1);
        return record().bulkDraft;
      }
      await controller.handle(id, { type, draftRevision: revision, ...options });
      await pending;
      if (record().editError) throw Error(record().editError);
      return record().review;
    },
    async disconnect() {
      controller?.dispose();
      await db?.dispose();
    }
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...report, actualChromiumForm: true }));
});
