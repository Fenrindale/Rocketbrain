'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ResultsView } = require('../src/results');

function browserRuntime() {
  const candidates = [
    process.env.ROCKETBRAIN_PLAYWRIGHT_PATH,
    'playwright',
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
  ].filter(Boolean);
  let chromium;
  for (const candidate of candidates) {
    try { chromium = require(candidate).chromium; break; } catch { /* Try the next local runtime. */ }
  }
  if (!chromium) return { skip: 'Playwright is unavailable; set ROCKETBRAIN_PLAYWRIGHT_PATH to run the browser test.' };
  const programs = [
    process.env.ROCKETBRAIN_BROWSER_PATH,
    chromium.executablePath(),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  const executablePath = programs.find(program => fs.existsSync(program));
  if (!executablePath) return { skip: 'A local Chromium browser is unavailable; set ROCKETBRAIN_BROWSER_PATH to run the browser test.' };
  return { chromium, executablePath };
}

const runtime = browserRuntime();

test('actual result Webview renders database values as text and routes history/copy/export correctly', { skip: runtime.skip, timeout: 45000 }, async (t) => {
  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  const unexpectedRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    const asset = url === 'https://rocketbrain.test/assets/results.js' ? 'results.js'
      : url === 'https://rocketbrain.test/assets/results.css' ? 'results.css' : null;
    if (asset) {
      await route.fulfill({ status: 200, contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css', body: fs.readFileSync(path.join(__dirname, '../src/ui', asset), 'utf8') });
    } else {
      unexpectedRequests.push(url);
      await route.abort();
    }
  });

  let receiveMessage;
  let lastPost = Promise.resolve();
  let clipboard = '';
  const writes = [];
  const vscode = {
    Uri: { joinPath: (base, ...parts) => path.posix.join(base, ...parts), file: value => value },
    env: { clipboard: { writeText: async text => { clipboard = text; } } },
    window: { showSaveDialog: async () => '/virtual/query-results.csv', showErrorMessage: message => { throw new Error(message); } },
    workspace: { fs: { writeFile: async (uri, data) => { writes.push({ uri, text: data.toString('utf8') }); } } },
  };
  const host = new ResultsView(vscode, { extensionUri: '/virtual/rocketbrain', subscriptions: [] });
  const fakeView = {
    webview: {
      cspSource: 'https://rocketbrain.test',
      asWebviewUri: uri => `https://rocketbrain.test/assets/${path.posix.basename(uri)}`,
      onDidReceiveMessage: handler => { receiveMessage = handler; return { dispose() {} }; },
      postMessage: data => {
        lastPost = lastPost.then(() => page.evaluate(payload => window.dispatchEvent(new MessageEvent('message', { data: payload })), data));
        return lastPost;
      },
    },
    onDidDispose() {},
  };
  host.resolveWebviewView(fakeView);
  await lastPost;
  await page.exposeFunction('__postToHost', async message => receiveMessage(message));
  await page.evaluate(() => {
    window.__sent = [];
    window.__completed = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.__sent.push(message);
        return window.__postToHost(message).then(() => { window.__completed.push(message); });
      },
    });
  });
  await page.setContent(fakeView.webview.html, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__completed.some(message => message.type === 'ready'));
  await lastPost;
  assert.equal(await page.locator('#copy').isDisabled(), true);
  assert.equal(await page.locator('#export').isDisabled(), true);

  const attack = '<img src="https://attacker.invalid/steal" onerror="window.__xss=true">';
  const heading = '<svg onload="window.__xss=true">column</svg>';
  const longText = `${'long text '.repeat(1600)}\ncomma, and "quoted" text`;
  const firstId = host.begin("SELECT '<payload>' AS test", '<b>MySQL source</b>');
  host.finish(firstId, { columns: [heading, 'nullable', 'details', 'formula'], rows: [[attack, null, longText, '=1+1']], rowCount: 1, truncated: true, durationMs: 2.35 });
  await lastPost;

  await t.test('HTML-like cells, column titles and source labels stay literal; NULL and full long values remain accessible', async () => {
    assert.equal(await page.locator('#source').textContent(), '<b>MySQL source</b>');
    assert.equal(await page.locator('thead th').nth(1).textContent(), heading);
    assert.equal(await page.locator('tbody td').nth(1).textContent(), attack);
    assert.equal(await page.locator('tbody td.null').textContent(), 'NULL');
    assert.equal(await page.locator('tbody td').nth(3).textContent(), longText);
    assert.equal(await page.locator('tbody td').nth(3).getAttribute('title'), longText);
    assert.equal(await page.locator('#grid img, #grid svg, #source b').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.locator('#status').textContent(), /1 rows.*limit reached.*2\.4 ms.*read only/);
    assert.equal(await page.locator('#copy').isDisabled(), false);
  });

  await t.test('copy/export buttons invoke the actual host handlers with the selected result and preserve CSV quoting', async () => {
    await page.locator('#copy').click();
    await page.waitForFunction(id => window.__completed.some(message => message.type === 'copy' && message.id === id), firstId);
    assert.ok(clipboard.startsWith(`${heading}\tnullable\tdetails\tformula\n${attack}\t\t`));
    assert.equal(clipboard.split('\n').length, 2);
    assert.ok(clipboard.endsWith("\t'=1+1"));
    await page.locator('#export').click();
    await page.waitForFunction(id => window.__completed.some(message => message.type === 'export' && message.id === id), firstId);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].uri, '/virtual/query-results.csv');
    assert.ok(writes[0].text.includes('comma, and ""quoted"" text'));
    assert.ok(writes[0].text.includes(longText.split('\n')[0]));
    assert.ok(writes[0].text.includes('"\'=1+1"'));
  });

  const errorText = '<img src=x onerror="window.__errorXss=true"> Query failed';
  const secondId = host.begin('SELECT missing', 'MySQL');
  host.finish(secondId, undefined, errorText);
  await lastPost;
  await t.test('errors are text, clear the grid and disable result actions; history restores an earlier result', async () => {
    assert.equal(await page.locator('#message').textContent(), errorText);
    assert.equal(await page.locator('#message').getAttribute('class'), 'error');
    assert.equal(await page.locator('#message img').count(), 0);
    assert.equal(await page.evaluate(() => window.__errorXss), undefined);
    assert.equal(await page.locator('#grid table').count(), 0);
    assert.equal(await page.locator('#copy').isDisabled(), true);
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.getByRole('button', { name: `Result ${firstId}`, exact: true }).click();
    assert.equal(await page.locator('tbody td.null').textContent(), 'NULL');
    assert.equal(await page.getByRole('button', { name: `Result ${firstId}`, exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#copy').isDisabled(), false);
  });

  const thirdId = host.begin('SELECT 1 WHERE false', 'Offline demo');
  await lastPost;
  await t.test('running and empty results have distinct states; refreshing a running result preserves a deliberately selected older tab', async () => {
    assert.match(await page.locator('#message').textContent(), /Running query/);
    assert.equal(await page.locator('#copy').isDisabled(), true);
    await page.getByRole('button', { name: `Result ${firstId}`, exact: true }).click();
    host.finish(thirdId, { columns: ['empty'], rows: [], rowCount: 0, truncated: false, durationMs: 0.1 });
    await lastPost;
    assert.equal(await page.getByRole('button', { name: `Result ${firstId}`, exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: `Result ${thirdId}`, exact: true }).click();
    assert.equal(await page.locator('#message').textContent(), 'Query completed. No rows returned.');
    assert.equal(await page.locator('thead th').nth(1).textContent(), 'empty');
    assert.equal(await page.locator('tbody tr').count(), 0);
    assert.equal(await page.locator('#copy').isDisabled(), false);
  });

  await t.test('write results show affected rows and manual transaction state without a read-only label', async () => {
    const id = host.begin('UPDATE tasks SET done = 1', 'test · console-2', { readOnly: false, sessionId: 'console-2' });
    host.finish(id, { columns: [], rows: [], rowCount: 0, affectedRows: 2, warningCount: 1, durationMs: 1, state: { autocommit: false, inTransaction: true } });
    await lastPost;
    assert.equal(await page.locator('#message').textContent(), 'Statement completed. 2 rows affected.');
    assert.match(await page.locator('#status').textContent(), /2 rows affected.*writes.*manual commit.*transaction.*1 warnings/);
    assert.doesNotMatch(await page.locator('#status').textContent(), /read only/);
  });

  await t.test('an interrupted write preserves the unknown outcome and does not invite blind retry', async () => {
    const id = host.begin('UPDATE tasks SET done = 1', 'test · console-2', { readOnly: false });
    host.finish(id, undefined, 'Connection lost.', { outcomeUnknown: true, needsReconnect: true });
    await lastPost;
    assert.match(await page.locator('#message').textContent(), /write may have completed.*Inspect the database before retrying/);
    assert.match(await page.locator('#status').textContent(), /Write outcome unknown/);
    assert.equal(await page.locator('#export').isDisabled(), true);
  });

  await t.test('history is bounded to eight records', async () => {
    for (let count = 0; count < 10; count++) {
      const id = host.begin('SELECT 1', 'Offline demo');
      host.finish(id, { columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 });
    }
    await lastPost;
    assert.equal(await page.locator('#tabs button').count(), 8);
    assert.equal(await page.getByRole('button', { name: `Result ${firstId}`, exact: true }).count(), 0);
  });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedRequests, []);
});
