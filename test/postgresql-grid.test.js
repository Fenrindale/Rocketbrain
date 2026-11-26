'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { gridNames, gridCell, wireGridEdit } = require('../src/db/postgresql-grid');
const { gridHtml, openPostgreSqlGrid } = require('../src/db/postgresql-grid-vscode');
const { createJdbcProfiles } = require('../src/db/jdbc-profiles');
const { verifyPostgreSqlGrid } = require('./postgresql-grid-host');

test('PostgreSQL grid requires a distinct write approval and preserves exact typed values', () => {
  const postgresql = { schema: 'pilot' };
  assert.throws(() => gridNames({ postgresql }, 'people'), /approved/);
  assert.throws(() => gridNames({ postgresql, postgresqlGridEditing: 'true' }, 'people'), /approved/);
  assert.deepEqual(gridNames({ postgresql, postgresqlGridEditing: true }, 'people'), { schema: 'pilot', table: 'people' });
  const text = { name: 'note', type: 'text', nullable: true, number: 2, typeModifier: -1 };
  assert.equal(gridCell('0009007199254740994', { type: 'int8' }), '9007199254740994');
  assert.equal(gridCell('', text), '');
  assert.equal(gridCell(null, text), null);
  assert.throws(() => gridCell('2147483648', { type: 'int4' }), /exceeds/);
  assert.throws(() => gridCell('text\0another', text), /UTF-8/);
  assert.throws(() => gridCell('\ud800', text), /UTF-8/);
  const good = { relation: '5', rowVersion: '8', identity: { column: 'id', type: 'int8', number: 1, value: '123' },
    column: text, original: null, replacement: '' };
  assert.deepEqual(wireGridEdit(good).split('\0').slice(7), ['0', '', '1', '', '1', '2', '-1']);
});

test('PostgreSQL webview shows a stable row key and safely escapes editable table data', () => {
  const html = gridHtml({ schema: 'pilot', table: 'people', columns: [{ name: 'id', type: 'int8' }, { name: 'note', type: 'text' }],
    rows: [{ values: ['123', '<script>alert(1)</script>'] }, { values: ['124', null] }] }, 'knownnonce');
  assert.match(html, /<th scope="row">123<\/th>/);
  assert.match(html, /data-row="0" data-field="1"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /SQL NULL/);
  assert.match(html, /script-src 'nonce-knownnonce'/);
});

test('PostgreSQL grid command writes only after the exact cell confirmation', async () => {
  const preview = { id: 'preview', schema: 'pilot', table: 'people',
    columns: [{ name: 'id', type: 'int8' }, { name: 'note', type: 'text', nullable: false }],
    rows: [{ values: ['9007199254740994', 'before'] }] };
  const edit = { id: 'reviewed', database: 'fixture', schema: 'pilot', table: 'people',
    identity: { column: 'id', value: '9007199254740994' }, column: { name: 'note' }, original: 'before', replacement: 'after' };
  const disposed = { dispose() {} };
  let receive, approve = false;
  const confirmations = [], writes = [], messages = [];
  const panel = { webview: { onDidReceiveMessage(fn) { receive = fn; return disposed; }, async postMessage(value) { messages.push(value); } },
    onDidDispose() { return disposed; } };
  const vscode = { ViewColumn: { Active: 1 }, window: {
    createWebviewPanel() { return panel; },
    async showInputBox() { return 'after'; },
    async showWarningMessage(message, options, button) {
      confirmations.push({ message, detail: options.detail });
      return approve ? button : undefined;
    }
  } };
  const api = { supportsPostgreSqlGrid: () => true, async previewPostgreSqlGrid() { return preview; },
    preparePostgreSqlGridEdit(...args) { assert.deepEqual(args, ['preview', 0, 1, 'after']); return edit; },
    async applyPostgreSqlGridEdit(id, approved) { writes.push({ id, approved }); } };
  await openPostgreSqlGrid({ vscode, api, progress: async (_, action) => action(), table: 'people' });
  await receive({ type: 'edit', row: 0, field: 0 });
  assert.deepEqual(confirmations, []);
  await receive({ type: 'edit', row: 0, field: 1 });
  assert.match(confirmations[0].detail, /id = 9007199254740994\nnote before  "before"\nnote after  "after"/);
  assert.deepEqual(writes, []);
  approve = true;
  await receive({ type: 'edit', row: 0, field: 1 });
  assert.deepEqual(writes, [{ id: 'reviewed', approved: true }]);
  assert.equal(messages[0].type, 'completed');
});

const { ROCKETBRAIN_POSTGRES_TEST_BIN: bin, ROCKETBRAIN_POSTGRES_TEST_JAR: jar, ROCKETBRAIN_POSTGRES_JAVA_HOME: javaHome } = process.env;
test('actual PostgreSQL JDBC grid binds approval, row version and typed commit to one cell', { skip: !bin || !jar || !javaHome, timeout: 180000 }, async t => {
  let saved;
  const api = createJdbcProfiles({ state: { get: () => saved, async update(_, value) { saved = value; } },
    getJavaHome: () => javaHome, isTrusted: () => true });
  try { t.diagnostic(JSON.stringify(await verifyPostgreSqlGrid(api, { bin, jar }))); }
  finally { api.dispose(); }
});
