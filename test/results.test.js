'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ResultsView } = require('../src/results');
const { tableLayoutConnectionKey } = require('../src/db/result-layouts');
const { browseQuery } = require('../src/db/grid');

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

test('result file export rechecks the original snapshot after the save dialog', async () => {
  let receive, chooseFile;
  const errors = [], writes = [];
  const vscode = {
    Uri: { joinPath: (base, ...parts) => path.posix.join(base, ...parts), file: value => value },
    window: { showSaveDialog: () => new Promise(resolve => { chooseFile = resolve; }), showErrorMessage: message => errors.push(message) },
    workspace: { fs: { writeFile: async (uri, data) => writes.push({ uri, data }) } }
  };
  const view = new ResultsView(vscode, { extensionUri: '/virtual', subscriptions: [] });
  view.resolveWebviewView({
    webview: { cspSource: 'https://rocketbrain.test', asWebviewUri: uri => uri, postMessage() {},
      onDidReceiveMessage: handler => { receive = handler; return { dispose() {} }; } },
    onDidDispose() {}
  });
  const result = { columns: ['name'], rows: [['before']] };
  const id = view.begin('SELECT name FROM people', 'MySQL');
  view.finish(id, result);
  const request = receive({ type: 'export', id, format: 'json' });
  assert.equal(typeof chooseFile, 'function');
  view.finish(id, { ...result, rows: [['after']] });
  chooseFile('/virtual/output.json');
  await request;
  assert.equal(writes.length, 0);
  assert.match(errors[0], /result changed while choosing a file/);
  view.editState(id, { hasDraft: true });
  assert.throws(() => view.exportSnapshot(id, 'json'), /apply or discard drafts/);
});

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
  let relatedSelection;
  let statementSelection;
  let browsed;
  const writes = [];
  const memories = new Map();
  const vscode = {
    Uri: { joinPath: (base, ...parts) => path.posix.join(base, ...parts), file: value => value },
    env: { clipboard: { writeText: async text => { clipboard = text; } } },
    commands: { async executeCommand(command, selection) { statementSelection = { command, ...selection }; } },
    window: { showSaveDialog: async options => '/virtual/' + options.defaultUri,
      showInputBox: async options => options.title.startsWith('Rename') ? 'Quarterly results' : 'Compound search',
      showWarningMessage: async () => undefined, showErrorMessage: message => { throw new Error(message); } },
    workspace: { fs: { writeFile: async (uri, data) => { writes.push({ uri, data, text: data.toString('utf8') }); } } },
  };
  const host = new ResultsView(vscode, {
    extensionUri: '/virtual/rocketbrain', subscriptions: [], workspaceState: {
      get: key => memories.get(key),
      async update(key, value) { memories.set(key, structuredClone(value)); }
    }
  }, { relatedAction: (id, selection) => { relatedSelection = { id, ...selection }; }, relatedReturn: id => {
    const origin = host.history.find(record => record.id === id)?.relatedOrigin;
    if (origin) return host.activateResult(origin.id, origin);
  }, datasetAction: async (id, input) => {
    input.assertFresh();
    host.editState(id, { editResponseId: input.requestId, bulkDraft: {
      id: 'comparison-bulk', modelId: input.modelId, draftRevision: input.draftRevision, ...input.changes
    } });
  }, editAction: (id, message) => {
    if (message.type === 'draftChanged') host.editState(id, { hasDraft: message.count > 0, draftRevision: message.draftRevision, review: undefined });
    if (message.type === 'reviewChanges') host.editState(id, {
      editResponseId: message.requestId, review: { statements: [{ sql: 'UPDATE fixture SET note = ?', parameters: [null] }] }
    });
    if (message.type === 'browseTable') {
      const record = host.history.find(item => item.id === id), result = record.result, prior = result.edit;
      browsed = browseQuery({ name: prior.table, columns: prior.columns }, message.query, 'fixture');
      host.finish(id, { ...result, edit: { ...prior, modelId: prior.modelId + '-next', query: browsed.query },
        browse: { ...result.browse, ...browsed.query } });
      host.editState(id, { editResponseId: message.requestId });
    }
  } });
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
  const firstResult = { columns: [heading, 'nullable', 'details', 'formula'], rows: [[attack, null, longText, '=1+1']],
    fields: [253, 6, 253, 253].map(type => ({ type, characterSet: 45 })), rowCount: 1, truncated: true, durationMs: 2.35 };
  host.finish(firstId, firstResult);
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

  await t.test('alternate views present the captured records safely and navigate within the current preview', async () => {
    host.finish(firstId, { ...firstResult, rows: [...firstResult.rows, ['Second', null, '', '']], rowCount: 2 });
    await lastPost;
    await page.locator('#result-view').selectOption('record');
    assert.match(await page.locator('#result-row-status').textContent(), /Row 1.*1 of 2/);
    assert.equal(await page.locator('.result-fields dd').first().textContent(), attack);
    await page.locator('#result-row-next').click();
    assert.equal(await page.locator('.result-fields dd').first().textContent(), 'Second');
    assert.equal(await page.locator('#result-row-next').isDisabled(), true);
    await page.locator('#result-view').selectOption('tree');
    assert.equal(await page.locator('#grid details').count(), 2);
    await page.locator('#grid summary').first().click();
    await page.locator('#grid details dd').first().waitFor();
    assert.equal(await page.locator('#grid details dd').first().textContent(), attack);
    await page.locator('#result-view').selectOption('text');
    assert.ok((await page.locator('#grid pre').textContent()).includes(JSON.stringify(attack)));
    assert.ok((await page.locator('#grid pre').textContent()).includes('\tnull\t'));
    await page.locator('#result-view').selectOption('transpose');
    assert.deepEqual(await page.locator('#grid thead th').allTextContents(), ['Column', 'Row 1', 'Row 2']);
    assert.equal(await page.locator('#grid tbody th').first().textContent(), heading);
    assert.equal(await page.locator('#grid img, #grid svg').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await page.locator('#result-view').selectOption('grid');
    host.finish(firstId, firstResult);
    await lastPost;
  });

  await t.test('column display settings pin, hide, reorder and resize by ordinal while exports retain every source column', async () => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.locator('#result-columns').click();
    await page.getByRole('checkbox', { name: 'Pin column 4 formula' }).check();
    await page.getByRole('checkbox', { name: 'Show column 3 details' }).uncheck();
    const width = page.getByRole('spinbutton', { name: 'Column 4 width in pixels' });
    await width.fill('260');
    await width.press('Tab');
    await page.getByRole('button', { name: 'Move column 2 earlier' }).click();
    assert.deepEqual(await page.locator('#grid thead th').allTextContents(), ['#', 'formula', 'nullable', heading]);
    assert.equal(await page.locator('th.result-pinned').evaluate(cell => cell.getBoundingClientRect().width), 260);
    const before = await page.locator('th.result-pinned').evaluate(cell => cell.getBoundingClientRect().left);
    await page.locator('#grid').evaluate(grid => { grid.scrollLeft = 200; });
    assert.equal(await page.locator('th.result-pinned').evaluate(cell => cell.getBoundingClientRect().left), before);

    await page.locator('#export-format').selectOption('json');
    await page.locator('#export').click();
    await page.waitForFunction(() => window.__completed.some(message => message.type === 'export' && message.format === 'json'));
    const exported = JSON.parse(writes.at(-1).text);
    assert.equal(writes.at(-1).uri, '/virtual/query-results.json');
    assert.deepEqual(exported.columns.map(column => column.name), firstResult.columns);
    assert.deepEqual(exported.rows, firstResult.rows);
    await page.locator('#export-format').selectOption('xlsx');
    await page.locator('#export').click();
    await page.waitForFunction(() => window.__completed.some(message => message.type === 'export' && message.format === 'xlsx'));
    assert.equal(writes.at(-1).uri, '/virtual/query-results.xlsx');
    assert.equal(writes.at(-1).data.readUInt32LE(), 0x04034b50);
    await page.locator('#export-format').selectOption('insert');
    await page.locator('#export').click();
    await page.locator('#export-table').fill('output');
    await page.locator('#export-schema').fill('example');
    await page.locator('#export-columns').fill('["a", "b", "c", "d"]');
    await page.getByRole('button', { name: 'Save INSERT Script' }).click();
    await page.waitForFunction(() => window.__completed.some(message => message.type === 'export' && message.format === 'insert'));
    assert.equal(writes.at(-1).uri, '/virtual/query-results.sql');
    assert.ok(writes.at(-1).text.includes('INSERT INTO `example`.`output` (`a`, `b`, `c`, `d`) VALUES'));
    await page.locator('#export-format').selectOption('csv');
    await page.locator('#result-column-reset').click();
    await page.locator('#result-columns').click();
    await page.setViewportSize({ width: 1280, height: 800 });
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
    await page.getByRole('tab', { name: `Result ${firstId}`, exact: true }).click();
    assert.equal(await page.locator('tbody td.null').textContent(), 'NULL');
    assert.equal(await page.getByRole('tab', { name: `Result ${firstId}`, exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#copy').isDisabled(), false);
  });

  const thirdId = host.begin('SELECT 1 WHERE false', 'Offline demo');
  await lastPost;
  await t.test('running and empty results have distinct states; refreshing a running result preserves a deliberately selected older tab', async () => {
    assert.match(await page.locator('#message').textContent(), /Running query/);
    assert.equal(await page.locator('#copy').isDisabled(), true);
    await page.getByRole('tab', { name: `Result ${firstId}`, exact: true }).click();
    host.finish(thirdId, { columns: ['empty'], rows: [], rowCount: 0, truncated: false, durationMs: 0.1 });
    await lastPost;
    assert.equal(await page.getByRole('tab', { name: `Result ${firstId}`, exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: `Result ${thirdId}`, exact: true }).click();
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
    assert.equal(await page.getByRole('tab', { name: `Result ${firstId}`, exact: true }).count(), 0);
  });

  await t.test('Grid and Record send only the captured row identity when following a foreign key', async () => {
    const id = host.begin('SELECT id FROM employees', 'Read-only table');
    host.finish(id,{columns:['id'],rows:[[1]],rowCount:1,durationMs:1,
      state:{readOnly:true,autocommit:true},edit:{
        modelId:'captured-relation',table:'employees',rowIds:['saved-employee'],columns:[{name:'id',type:'int'}]
      }});
    await lastPost;
    for (const mode of ['grid','record']) {
      await page.locator('#result-view').selectOption(mode);
      await page.getByRole('button',{name:'Open related rows for row 1'}).click();
      await page.waitForFunction(value => window.__completed.filter(message => message.type==='openRelatedRows' && message.id===value.id).length >= value.count,
        {id,count:mode==='grid'?1:2});
      assert.deepEqual(relatedSelection,{id,modelId:'captured-relation',rowId:'saved-employee'});
    }
    await page.locator('#close-result').click();
    await page.waitForFunction(value => window.__completed.some(message => message.type==='closeResult' && message.id===value),id);
    await lastPost;
  });

  await t.test('related previews return to the exact retained record row', async () => {
    const source = host.begin('SELECT name FROM departments', 'Source table');
    host.finish(source, { columns: ['name'], rows: [['first source'], ['second source']], rowCount: 2, durationMs: 1,
      state: { readOnly: true, autocommit: true }, edit: { modelId: 'source-related', table: 'departments',
        rowIds: ['first-id', 'second-id'], columns: [{ name: 'name', type: 'varchar(64)' }] } });
    await lastPost;
    await page.locator('#result-view').selectOption('record');
    assert.equal(await page.locator('.result-fields dd').first().textContent(), 'first source');
    const target = host.begin('SELECT name FROM employees', 'Related table', {
      relatedOrigin: { id: source, modelId: 'source-related', rowId: 'second-id' }
    });
    host.finish(target, { columns: ['name'], rows: [['related']], rowCount: 1, durationMs: 1 });
    await lastPost;
    await page.getByRole('button', { name: 'Back to Source Row' }).click();
    await page.waitForFunction(() => document.querySelector('.result-fields dd')?.textContent === 'second source');
    assert.equal(await page.getByRole('button', { name: 'Back to Source Row' }).count(), 0);
  });

  await t.test('Grid and Record share staged cells and review; a named table retains display settings after reopening', async () => {
    const connection = tableLayoutConnectionKey({ host: 'localhost', database: 'fixture', user: 'test' });
    const table = 'records';
    const allColumns = [
      { name: 'id', type: 'int', primaryKey: true, editable: false, insertable: false, nullable: false },
      { name: 'label', type: 'varchar(100)', editable: true, insertable: true, nullable: false },
      { name: 'note', type: 'varchar(100)', editable: true, insertable: true, nullable: true }
    ];
    const sample = {
      columns: allColumns.map(column => column.name), rows: [[1, 'First', 'original'], [2, 'Second', null]],
      rowCount: 2, durationMs: 1, edit: { modelId: 'model-a', table, canEdit: true, columns: allColumns, rowIds: ['a', 'b'] }
    };
    const id = host.begin('SELECT * FROM records', 'fixture', { tableLayoutConnection: connection, table, readOnly: false });
    host.finish(id, sample);
    await lastPost;

    await page.locator('#result-view').selectOption('record');
    assert.equal(await page.getByRole('button', { name: 'Edit row a column id' }).count(), 0);
    await page.getByRole('button', { name: 'Edit row a column label' }).press('Enter');
    await page.locator('#cell-value').fill('Draft Record');
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    assert.equal(await page.locator('.result-record dd.modified').textContent(), 'Draft Record');
    assert.equal(await page.locator('#result-view option[value=tree]').isDisabled(), true);
    assert.equal(await page.locator('#result-view option[value=text]').isDisabled(), true);
    assert.equal(await page.locator('#result-view option[value=transpose]').isDisabled(), true);
    assert.equal(await page.locator('#export').isDisabled(), true);
    assert.equal(await page.locator('#copy').isDisabled(), true);
    await page.locator('#result-view').selectOption('grid');
    assert.equal(await page.getByRole('button', { name: 'Edit row a column label' }).textContent(), 'Draft Record');
    await page.getByRole('button', { name: 'Edit row a column note' }).press('F2');
    await page.locator('#cell-null').check();
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    await page.locator('#result-view').selectOption('record');
    assert.equal(await page.getByRole('button', { name: 'Edit row a column note' }).textContent(), 'NULL');
    await page.locator('#result-row-next').click();
    assert.equal(await page.getByRole('button', { name: 'Edit row b column label' }).textContent(), 'Second');

    await page.locator('#add-row').click();
    assert.match(await page.locator('#result-row-status').textContent(), /New row 1.*local draft/);
    assert.equal(await page.getByRole('button', { name: 'Edit new row new-1 column label' }).textContent(), 'DEFAULT');
    await page.getByRole('button', { name: 'Delete new row new-1' }).click();
    await page.getByRole('button', { name: 'Delete row b' }).click();
    assert.match(await page.locator('#result-row-status').textContent(), /deletion staged/);
    await page.getByRole('button', { name: 'Restore row b' }).click();
    await page.locator('#review').click();
    await page.locator('#review-panel').waitFor({ state: 'visible' });
    const review = await page.evaluate(() => window.__sent.find(message => message.type === 'reviewChanges'));
    assert.deepEqual(review.changes, { updates: [{ rowId: 'a', values: {
      label: { kind: 'value', text: 'Draft Record' }, note: { kind: 'null' }
    } }], deletes: [], inserts: [] });
    await page.locator('#result-view').selectOption('grid');
    assert.equal(await page.locator('#review-panel').isVisible(), true);
    await page.locator('#discard').click();
    await page.waitForFunction(() => !document.getElementById('export').disabled);

    await page.locator('#result-columns').click();
    await page.getByRole('checkbox', { name: 'Pin column 2 label' }).check();
    await page.getByRole('checkbox', { name: 'Show column 3 note' }).uncheck();
    const width = page.getByRole('spinbutton', { name: 'Column 2 width in pixels' });
    await width.fill('245');
    await width.press('Tab');
    await page.waitForFunction(() => window.__completed.some(message =>
      message.type === 'saveLayout' && message.columns.some(column => column.name === 'label' && column.width === 245)));
    await lastPost;
    host.editState(id, { readOnly: true });
    await lastPost;
    await page.locator('#close-result').click();
    await page.getByRole('tab', { name: `Result ${id}`, exact: true }).waitFor({ state: 'detached' });

    const reopened = host.begin('SELECT * FROM records', 'fixture, renamed connection', { tableLayoutConnection: connection, table });
    const reordered = ['extra', 'note', 'id', 'label'];
    host.finish(reopened, { ...sample, columns: reordered, rows: [['new', 'original', 1, 'First']],
      edit: { ...sample.edit, modelId: 'model-b', rowIds: ['other'], columns: reordered.map(name => allColumns.find(column => column.name === name) || { name, type: 'text' }) } });
    await lastPost;
    assert.deepEqual(await page.locator('thead th').allTextContents(), ['#', 'label', 'id', 'extra']);
    assert.equal(await page.locator('th.result-pinned').evaluate(cell => cell.getBoundingClientRect().width), 245);
  });

  await t.test('captured chart draws a grouped measure, pages categories and exports exact aggregates', async () => {
    const result = {
      columns: ['Category', 'Money'], fields: [{ type: 253 }, { type: 246 }], truncated: true,
      rows: [['Store', '12345678901234567890.000000000000001'], ['Store', '-12345678901234567889.999999999999998'],
        ['Store', '0.000000000000001'], [null, null], ...Array.from({ length: 26 }, (_, index) => ['Shop ' + index, '4.25'])],
      rowCount: 30, durationMs: 1.5
    };
    const id = host.begin('SELECT category, amount FROM totals', 'DB');
    host.finish(id, result);
    await lastPost;
    await page.locator('#result-view').selectOption('chart');
    await page.locator('.chart-data tbody td').last().waitFor();
    assert.equal(await page.locator('.chart-data tbody td').last().textContent(), '30');
    await page.locator('#chart-category').selectOption('0');
    await page.locator('#chart-operation').selectOption('sum');
    await page.getByText('0.000000000000004', { exact: true }).waitFor();
    assert.match(await page.locator('#chart-status').textContent(), /30 captured rows.*28 plotted categories.*preview can omit other rows/);
    assert.deepEqual(await page.locator('.chart-data tbody tr').nth(1).locator('td').allTextContents(), ['NULL', '1', '0', 'NULL']);
    await page.locator('#chart-shape').selectOption('line');
    assert.ok(await page.locator('.result-chart-canvas').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some(value => value > 0)));
    await page.getByRole('button', { name: 'Next Categories' }).click();
    assert.equal(await page.locator('.chart-data tbody tr').count(), 4);
    assert.match(await page.locator('.chart-navigation').textContent(), /25–28 of 28 categories/);
    await page.getByRole('button', { name: 'Export Chart Data' }).click();
    await page.waitForFunction(() => window.__completed.some(message => message.type === 'exportAnalysis'));
    assert.equal(writes.at(-1).uri, '/virtual/query-analysis.json');
    const exported = JSON.parse(writes.at(-1).text);
    assert.equal(exported.groups.length, 28);
    assert.equal(exported.groups[0].value, '0.000000000000004');
    assert.equal(exported.truncated, true);
  });

  await t.test('captured map draws an offline basemap, separates SRIDs and opens the selected captured row', async () => {
    const fields = [{ type: 253 }, { type: 255 }];
    const rows = [['east coast', '{"x":127,"y":37}'], ['north coast', '{"x":129,"y":41}'],
      ['local grid', '{"x":12,"y":8}'], ['unmapped', null]];
    const spatial = [
      { row: 0, cells: { 1: { srid: 4326, node: { type: 1, coordinates: [127, 37] } } } },
      { row: 1, cells: { 1: { srid: 4326, node: { type: 1, coordinates: [129, 41] } } } },
      { row: 2, cells: { 1: { srid: 0, node: { type: 1, coordinates: [12, 8] } } } }
    ];
    const id = host.begin('SELECT label, geom FROM samples', 'DB');
    host.finish(id, { columns: ['label', 'geom <map>'], fields, rows, spatial, rowCount: rows.length, durationMs: 1 });
    await page.locator('#result-view').selectOption('map');
    const canvas = page.locator('.result-map-canvas');
    await canvas.waitFor();
    assert.match(await page.locator('.map-status').first().textContent(), /3 of 4 captured rows mapped.*1 SQL NULL/);
    assert.ok(await canvas.evaluate(surface => surface.getContext('2d').getImageData(0, 0, surface.width, surface.height).data.some(value => value > 0)));
    assert.equal(await page.getByLabel('Feature').locator('option').count(), 2);
    await page.getByRole('button', { name: 'World', exact: true }).click();
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Home');
    const marker = await canvas.evaluate(surface => {
      const width = surface.clientWidth, height = surface.clientHeight;
      const scale = Math.min((width - 52) / 2, (height - 46) / 4);
      return { x: width / 2 + scale, y: height / 2 - 2 * scale };
    });
    await canvas.click({ position: marker });
    assert.equal(await page.getByLabel('Feature').inputValue(), '1');
    await page.getByRole('button', { name: 'Open Record' }).click();
    assert.match(await page.locator('#result-row-status').textContent(), /Row 2 · 2 of 4 captured/);
    assert.match(await page.locator('#grid').textContent(), /north coast/);
    await page.locator('#result-view').selectOption('map');
    await page.getByLabel('Coordinates').selectOption('cartesian');
    assert.equal(await page.getByLabel('Feature').locator('option').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'World', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Open Record' }).click();
    assert.match(await page.locator('#grid').textContent(), /local grid/);
    const record = host.history.find(result => result.id === id);
    assert.throws(() => host.mapSnapshot(id, 1, record.chart.revision - 1), /current captured result/);
    host.editState(id, { hasDraft: true });
    assert.throws(() => host.mapSnapshot(id, 1), /apply or discard drafts/);
    host.editState(id, { hasDraft: false });
  });

  await t.test('typed editors stage original line endings, exact JSON text and binary bytes as one ordinary draft', async () => {
    const columns = [
      { name: 'body', type: 'longtext', kind: 'text', editable: true, nullable: true },
      { name: 'config', type: 'json', kind: 'json', editable: true, nullable: true },
      { name: 'payload', type: 'blob', kind: 'binary', editable: true, nullable: true }
    ];
    const original = 'first\r\nsecond\rthird\nfourth\0tail';
    const exactText = 'edited\r\nsecond\rthird\nfourth\0끝';
    const exactJson = '{\n  "exact":9007199254740993, "optional":null\n}';
    const id = host.begin('SELECT * FROM editor_types', 'DB', { readOnly: false });
    host.finish(id, { columns: columns.map(column => column.name), rows: [[original, null, '0x00ff'], ['old\r\ntext\r\n', 'null', null]], rowCount: 2,
      durationMs: 1, edit: { table: 'editor_types', modelId: 'type-model', canEdit: true, columns, rowIds: ['typed', 'crlf'] } });
    await lastPost;
    await page.getByRole('button', { name: 'Edit row typed column body' }).press('F2');
    assert.equal(await page.locator('#cell-format').inputValue(), 'escaped');
    assert.equal(await page.locator('#cell-value').inputValue(), JSON.stringify(original));
    await page.locator('#cell-value').fill(JSON.stringify(exactText));
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    await page.locator('#result-view').selectOption('record');
    await page.getByRole('button', { name: 'Edit row typed column config' }).press('Enter');
    assert.equal(await page.locator('#cell-null').isChecked(), true);
    await page.locator('#cell-null').uncheck();
    await page.locator('#cell-value').fill('{bad json}');
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    assert.match(await page.locator('#cell-error').textContent(), /Enter valid JSON/);
    await page.locator('#cell-value').fill(exactJson);
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    await page.getByRole('button', { name: 'Edit row typed column payload' }).press('Enter');
    await page.locator('#cell-format').selectOption('base64');
    assert.equal(await page.locator('#cell-value').inputValue(), 'AP8=');
    await page.locator('#cell-value').fill('AA0K/w==');
    await page.locator('#cell-format').selectOption('hex');
    assert.equal(await page.locator('#cell-value').inputValue(), '0x000d0aff');
    await page.locator('#cell-value').fill('0xf');
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    assert.match(await page.locator('#cell-error').textContent(), /even number/);
    await page.locator('#cell-value').fill('0x00 0D\n0a FF');
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    await page.locator('#result-row-next').click();
    await page.getByRole('button', { name: 'Edit row crlf column body' }).press('Enter');
    assert.equal(await page.locator('#cell-format').inputValue(), 'crlf');
    assert.equal(await page.locator('#cell-value').inputValue(), 'old\ntext\n');
    await page.locator('#cell-value').fill('new\ntext\n');
    await page.getByRole('button', { name: 'Stage Cell' }).click();
    assert.equal(await page.locator('#result-view option[value=chart]').isDisabled(), true);
    await page.locator('#review').click();
    await page.locator('#review-panel').waitFor({ state: 'visible' });
    const review = await page.evaluate(id => window.__sent.find(message => message.type === 'reviewChanges' && message.id === id), id);
    assert.deepEqual(review.changes.updates[0].values, {
      body: { kind: 'value', text: exactText }, config: { kind: 'value', text: exactJson }, payload: { kind: 'value', text: '0x000d0aff' }
    });
    assert.equal(review.changes.updates[1].values.body.text, 'new\r\ntext\r\n');
  });

  await t.test('compare pairs captured columns and stages only selected changed matching destination rows', async () => {
    const source = host.begin('SELECT number, new_text FROM changes', 'Source result');
    host.finish(source, { columns: ['number', 'new_text'], fields: [{ type: 3 }, { type: 253 }],
      rows: [[1, 'changed'], [2, 'same'], [3, 'source only']], rowCount: 3, durationMs: 1 });
    const target = host.begin('SELECT id, label FROM example', 'Destination result', { readOnly: false });
    host.finish(target, { columns: ['id', 'label'], rows: [[1, 'original'], [2, 'same']], rowCount: 2, durationMs: 1,
      edit: { modelId: 'compare-model', table: 'example', canEdit: true, rowIds: ['left-a', 'left-b'],
        columns: [{ name: 'id', kind: 'integer', type: 'int', primaryKey: true }, { name: 'label', kind: 'text', type: 'varchar(60)', editable: true, nullable: true }] } });
    await lastPost;
    await page.getByRole('tab', { name: `Result ${target}`, exact: true }).click();
    await page.locator('#result-view').selectOption('compare');
    await page.locator('#compare-source').selectOption(String(source));
    await page.getByRole('button', { name: 'Add Column Pair' }).click();
    await page.getByRole('checkbox', { name: 'Match key 1' }).check();
    await page.getByRole('button', { name: 'Add Column Pair' }).click();
    await page.getByRole('button', { name: 'Compare Captured Rows' }).click();
    await page.locator('.comparison-data tbody tr').last().waitFor();
    assert.match(await page.locator('#compare-status').textContent(), /1 equal.*1 different.*0 destination only.*1 source only/);
    assert.equal(await page.locator('.comparison-data tbody input').count(), 1);
    await page.locator('.comparison-data summary').click();
    assert.deepEqual(await page.locator('.comparison-values pre').allTextContents(), ['"original"', '"changed"']);
    await page.getByRole('checkbox', { name: 'Stage comparison row 1' }).check();
    await page.getByRole('button', { name: 'Stage Selected Updates' }).click();
    await page.locator('.modified').waitFor();
    assert.equal(await page.locator('.modified').textContent(), 'changed');
    assert.equal(await page.locator('#result-view').inputValue(), 'grid');
    assert.equal(await page.locator('tbody tr').count(), 2);
    assert.equal(await page.locator('#review').isEnabled(), true);
  });

  await t.test('naming and pinning a tab stays visible while a captured statement opens by exact index', async () => {
    const id = host.begin('SELECT 1; SELECT 2;', 'Script');
    host.finish(id, { columns: ['Statement'], rows: [[1], [2]], rowCount: 2, durationMs: 1,
      scriptStatements: [{ index: 0, label: 'Statement 1 · SELECT 1' }, { index: 1, label: 'Statement 2 · SELECT 2' }] });
    await lastPost;
    await page.getByRole('tab', { name: `Result ${id}`, exact: true }).click();
    await page.getByRole('button', { name: 'Rename Result' }).click();
    await page.getByRole('tab', { name: 'Quarterly results', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pin Result' }).click();
    await page.getByRole('tab', { name: 'Quarterly results (pinned)', exact: true }).waitFor();
    await page.locator('#script-result-selection').selectOption('1');
    await page.getByRole('button', { name: 'Open Captured Statement' }).click();
    await page.waitForFunction(() => window.__completed.some(message => message.type === 'openScriptStatement'));
    assert.deepEqual(statementSelection, { command: 'rocketbrain.sql.openScriptResult', resultId: id, index: 1 });
    await page.getByRole('button', { name: 'Close Result' }).click();
    await page.waitForFunction(id => window.__completed.some(message => message.type === 'closeResult' && message.id === id), id);
    assert.ok(await page.getByRole('tab', { name: 'Quarterly results (pinned)', exact: true }).isVisible());
    await page.getByRole('button', { name: 'Unpin Result' }).click();
    await page.getByRole('tab', { name: 'Quarterly results', exact: true }).waitFor();
  });

  await t.test('stored procedure result chooser opens output parameters through the procedure route', async () => {
    const id = host.begin('CALL sample(?, @output)', 'Procedure');
    host.finish(id, { columns: ['Result set'], rows: [[1]], rowCount: 1, durationMs: 1, captureKind: 'procedure',
      procedureOutputAvailable: true, scriptStatements: [{ index: 0, label: 'Result set 1 · 1 row(s)' },
        { index: 1, label: 'Output parameters · 1' }] });
    await lastPost;
    await page.getByRole('tab', { name: `Result ${id}`, exact: true }).click();
    const selector = page.getByRole('combobox', { name: 'Procedure results' });
    assert.deepEqual(await selector.locator('option').allTextContents(), ['Result set 1 · 1 row(s)', 'Output parameters · 1']);
    await selector.selectOption('1');
    await page.getByRole('button', { name: 'Open Result', exact: true }).click();
    await page.waitForFunction(id => window.__completed.some(message => message.type === 'openScriptStatement' && message.id === id), id);
    assert.deepEqual(statementSelection, { command: 'rocketbrain.db.openProcedureResult', resultId: id, index: 1 });
  });

  await t.test('Webview builds grouped filters from typed column search and reloads an applied named preset', async () => {
    const table = 'preset_table';
    const connection = tableLayoutConnectionKey({ host: 'localhost', database: 'fixture', user: 'reader' });
    const id = host.begin('SELECT * FROM preset_table', 'DB', { tableLayoutConnection: connection, table });
    const columns = [{ name: 'id', kind: 'integer', type: 'int', primaryKey: true },
      { name: 'label', kind: 'text', type: 'varchar(60)', editable: true, nullable: true }];
    const query = { page: 0, pageSize: 25, sort: [], filters: [] };
    host.finish(id, { columns: ['id', 'label'], rows: [[1, 'x_%']], rowCount: 1, durationMs: 1,
      browse: { ...query, pageable: true, hasPrevious: false, hasNext: false },
      edit: { table, modelId: 'filters-model', rowIds: ['r'], columns, query } });
    await lastPost;
    await page.getByRole('tab', { name: `Result ${id}`, exact: true }).click();
    await page.getByRole('button', { name: 'Sort and Filter' }).click();
    await page.getByRole('button', { name: 'Add Filter Group' }).click();
    await page.getByRole('textbox', { name: 'Filter value 1.1', exact: true }).fill('1');
    await page.getByRole('button', { name: 'Add group in group 1', exact: true }).click();
    await page.getByRole('combobox', { name: 'Filter group 1.2 mode', exact: true }).selectOption('and');
    await page.getByRole('textbox', { name: 'Filter value 1.2.1', exact: true }).fill('2');
    await page.locator('#browse-search-column').selectOption('label');
    await page.getByRole('textbox', { name: 'Column search value', exact: true }).fill('_%');
    await page.getByRole('button', { name: 'Add Search Rule' }).click();
    await page.getByRole('button', { name: 'Apply Sort and Filters' }).click();
    await page.waitForFunction(id => window.__completed.some(message => message.type === 'browseTable' && message.id === id), id);
    assert.deepEqual(browsed.parameters, ['1', '2', '%=_=%%']);
    assert.ok(browsed.sql.includes("WHERE (`id` = ? OR (`id` = ?)) AND `label` LIKE ? ESCAPE '='"));
    await page.getByRole('button', { name: 'Save Applied Filters' }).click();
    await page.locator('#saved-filter option[value="Compound search"]').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Clear Sort and Filters' }).click();
    await page.getByRole('button', { name: 'Save Applied Filters' }).waitFor();
    await page.locator('#saved-filter').selectOption('Compound search');
    await page.getByRole('button', { name: 'Load Filter' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Filter value 1.2.1' }).inputValue(), '2');
    assert.equal(await page.getByRole('textbox', { name: 'Filter value 2' }).inputValue(), '_%');
  });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedRequests, []);
});

test('query result tabs support manual keyboard activation and route focus to the selected origin', { skip: runtime.skip, timeout: 30000 }, async t => {
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
  let receive, writes = Promise.resolve();
  const sources = [];
  const v = { Uri: { joinPath: (...parts) => path.posix.join(...parts) },
    commands: { async executeCommand(command) { assert.equal(command, 'rocketbrain.results.focus'); } },
    window: { showErrorMessage: message => errors.push(message) } };
  const host = new ResultsView(v, { extensionUri: '/virtual', subscriptions: [], workspaceState: { get() {} } },
    { focusQueryEditor: target => { sources.push(target); } });
  const fakeView = { onDidDispose() {}, show(preserveFocus) { assert.equal(preserveFocus, false); },
    webview: { cspSource: 'https://rocketbrain.test',
      asWebviewUri: uri => 'https://rocketbrain.test/assets/' + path.posix.basename(uri),
      postMessage(data) {
        writes = writes.then(() => page.evaluate(payload => window.dispatchEvent(new MessageEvent('message', { data: payload })), data));
        return writes;
      },
      onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; }
    }
  };
  host.resolveWebviewView(fakeView);
  await writes;
  await page.exposeFunction('__keyboardHost', message => receive(message));
  await page.evaluate(() => {
    window.__focusReturns = 0;
    window.__selectedResult = undefined;
    window.acquireVsCodeApi = () => ({ postMessage: async message => {
      await window.__keyboardHost(message);
      if (message.type === 'focusQueryEditor') window.__focusReturns++;
      if (message.type === 'selectResult') window.__selectedResult = message.id;
    } });
  });
  await page.setContent(fakeView.webview.html);
  const first = host.begin('SELECT 1', 'MySQL', { queryEditor: { uri: 'file:/first.sql', viewColumn: 1 } });
  host.finish(first, { columns: ['n'], rows: [[1]], rowCount: 1 });
  const last = host.begin('SELECT 2', 'MariaDB', { queryEditor: { uri: 'file:/last.sql', viewColumn: 2 } });
  host.finish(last, { columns: ['n'], rows: [[2]], rowCount: 1 });
  const tabs = page.getByRole('tab');
  await tabs.nth(1).waitFor();
  await host.focus();
  assert.equal(await page.locator(':focus').getAttribute('id'), 'query-result-' + last);
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'query-result-' + first);
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'false');
  host.send();
  await writes;
  assert.equal(await page.locator(':focus').getAttribute('id'), 'query-result-' + first);
  await page.keyboard.press('Space');
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tabpanel', { name: 'Result ' + first }).getAttribute('id'), 'result-content');
  await page.waitForFunction(id => window.__selectedResult === id, first);
  await host.returnToQuery();
  await page.locator('#focus-query-editor').click();
  await page.waitForFunction(() => window.__focusReturns === 1);
  assert.deepEqual(sources, [{ uri: 'file:/first.sql', viewColumn: 1 }, { uri: 'file:/first.sql', viewColumn: 1 }]);
  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'query-result-' + last);
  await page.keyboard.press('Enter');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('role'), 'tabpanel');
  assert.deepEqual(errors, []);
});

test('the selected result can return to its query while the result view reloads', async () => {
  const sources = [];
  const view = new ResultsView({}, { workspaceState: { get() {} } }, {
    focusQueryEditor: source => sources.push(source)
  });
  const first = { uri: 'file:/first.sql', viewColumn: 1 };
  const second = { uri: 'file:/second.sql', viewColumn: 2 };
  const firstId = view.begin('SELECT 1', 'MySQL', { queryEditor: first });
  const secondId = view.begin('SELECT 2', 'MariaDB', { queryEditor: second });
  await view.returnToQuery();
  await view.activateResult(firstId);
  await view.returnToQuery();
  await view.activateResult(secondId);
  await view.returnToQuery();
  assert.deepEqual(sources, [second, first, second]);
});
