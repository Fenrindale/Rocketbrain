'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserRuntime } = require('./helpers/browser-runtime');
const { designerHtml } = require('../src/db/schema-designer-vscode');

const browser = browserRuntime();

test('the designer form stages a generated expression and exact ordered index parts', { skip: browser.skip, timeout: 30000 }, async () => {
  const chromium = await browser.chromium.launch({ executablePath: browser.executablePath, headless: true });
  try {
    const page = await chromium.newPage();
    const errors = [];
    let received;
    const pending = new Promise(resolve => { received = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__post', message => { if (message.type === 'review') received(message); });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: payload => window.__post(payload) }); });
    await page.setContent(designerHtml('generated-form-fixture'));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', revision: 0, model: { modelId: 'generated-fixture', mode: 'create', database: 'fixture', references: [], draft: {
        name: 'invoice', comment: '', charset: 'utf8mb4', collation: 'utf8mb4_bin', columns: [
          { name: 'amount', type: 'DECIMAL(24,6)', nullable: true, defaultKind: 'none', defaultValue: '', autoIncrement: false,
            charset: '', collation: '', comment: '', srsId: '', generationMode: 'none', generationExpression: '' }
        ], indexes: [], foreignKeys: [], checks: []
      } }
    } })));
    await page.getByRole('button', { name: 'Add column' }).click();
    await page.getByRole('textbox', { name: 'Column 2 name', exact: true }).fill('total');
    await page.getByRole('textbox', { name: 'Column 2 type', exact: true }).fill('DECIMAL(34,6)');
    const mode = page.getByRole('combobox', { name: 'Column 2 generation storage', exact: true });
    const expression = page.getByRole('textbox', { name: 'Column 2 generation expression', exact: true });
    assert.equal(await expression.isDisabled(), true);
    await mode.selectOption('stored');
    assert.equal(await expression.isEnabled(), true);
    assert.equal(await page.getByRole('combobox', { name: 'Column 2 default kind', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'Column 2 auto increment', exact: true }).isDisabled(), true);
    await expression.fill('(amount + 2) * 3');
    await page.getByRole('button', { name: 'Add key or index' }).click();
    await page.getByRole('textbox', { name: 'Index 1 name', exact: true }).fill('idx_amount_total');
    await page.getByRole('combobox', { name: 'Index 1 kind', exact: true }).selectOption('BTREE');
    await page.getByRole('textbox', { name: 'Index 1 ordered columns', exact: true }).fill('amount,total');
    await page.getByRole('button', { name: 'Review and validate' }).click();
    const review = await pending;
    assert.equal(review?.draft.columns[1].generationMode, 'stored');
    assert.equal(review.draft.columns[1].generationExpression, '(amount + 2) * 3');
    assert.equal(review.draft.columns[1].defaultKind, 'none');
    assert.deepEqual(review.draft.indexes[0], { name: 'idx_amount_total', type: 'BTREE', unique: false, primaryKey: false, comment: '',
      columns: [{ name: 'amount', ordinal: 1, prefixLength: null, collation: 'A' },
        { name: 'total', ordinal: 2, prefixLength: null, collation: 'A' }] });
    assert.equal(await page.getByRole('button', { name: 'Apply reviewed design' }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await chromium.close(); }
});
