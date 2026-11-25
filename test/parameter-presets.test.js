'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createParameterPresets, presetSignature } = require('../src/db/parameter-presets');
const { inferScriptParameters } = require('../src/db/parameter-inference');
const { analyzeScript } = require('../src/db/sql-script');
const { registerSqlScripts } = require('../src/db/sql-script-vscode');

const common = { parameterScope: 'a'.repeat(64), sourceSqlHash: 'b'.repeat(64), parameterEvidence: 'c'.repeat(64),
  sqlMode: ['STRICT_TRANS_TABLES'], parameterStyle: 'named',
  parameterDefinitions: [{ key: 'privateToken', name: 'privateToken', occurrences: 1 }] };
const secret = { privateToken: { kind: 'binary', value: '0xA0B1C2D3' } };
const ok = () => {};

function storage() {
  const data = new Map(), encrypted = new Map();
  let rejectWrite = false;
  const state = { get: (key, fallback) => data.get(key) ?? fallback, async update(key, value) {
    if (rejectWrite) throw Error('Metadata write failed');
    data.set(key, structuredClone(value));
  } };
  const secrets = { async get(key) { return encrypted.get(key); }, async store(key, value) { encrypted.set(key, value); },
    async delete(key) { encrypted.delete(key); } };
  return { data, encrypted, state, secrets, failWrites() { rejectWrite = true; } };
}

test('a reopened preset store exposes metadata only and binds exact SQL, account, names, mode and type evidence', async () => {
  const fixture = storage();
  const save = createParameterPresets(fixture), created = await save.save(common, 'Private binary', secret, ok);
  assert.equal(fixture.encrypted.size, 1);
  assert.doesNotMatch(JSON.stringify([...fixture.data]), /0xA0B1C2D3|privateToken/);
  const reopened = createParameterPresets(fixture);
  assert.deepEqual(reopened.list(presetSignature(common)), [created]);
  assert.deepEqual({ ...(await reopened.load(common, created.id, ok)) }, secret);
  for (const alternate of [
    { ...common, sourceSqlHash: 'd'.repeat(64) }, { ...common, parameterScope: 'e'.repeat(64) },
    { ...common, parameterEvidence: 'f'.repeat(64) }, { ...common, sqlMode: ['ANSI_QUOTES'] },
    { ...common, parameterDefinitions: [{ key: 'other', name: 'other', occurrences: 1 }] }
  ]) {
    assert.deepEqual(reopened.list(presetSignature(alternate)), []);
    await assert.rejects(reopened.load(alternate, created.id, ok), /does not match/);
  }
  const key = [...fixture.encrypted.keys()][0], payload = JSON.parse(fixture.encrypted.get(key));
  payload.values.privateToken = { kind: 'text', value: '0xA0B1C2D3' };
  fixture.encrypted.set(key, JSON.stringify(payload));
  await assert.rejects(reopened.load(common, created.id, ok), /types no longer match/);
  assert.equal(await reopened.remove(created.id, ok), true);
  assert.equal(fixture.encrypted.size, 0);
  assert.deepEqual(reopened.list(), []);
});

test('saving rejects wrong descriptor names, and a failed metadata commit removes the new secret', async () => {
  const fixture = storage(), store = createParameterPresets(fixture);
  await assert.rejects(store.save(common, 'Wrong name', { other: { kind: 'text', value: 'internal' } }, ok), /exactly match/);
  fixture.failWrites();
  await assert.rejects(store.save(common, 'Unavailable', secret, ok), /Metadata write failed/);
  assert.equal(fixture.encrypted.size, 0);
  assert.deepEqual(store.list(), []);
});

test('bounded inference uses actual column types for equality and explicit INSERT without guessing joins or mixed classes', async () => {
  const sqlMode = ['ANSI_QUOTES'];
  const fields = [['id', 'bigint unsigned', 'NO'], ['amount', 'decimal(30,6)', 'NO'], ['note', 'varchar(50)', 'YES']];
  const read = async (schema, table) => schema === 'fixture' && table === 'invoices' ? fields : [];
  const query = analyzeScript('SELECT i.amount FROM "fixture"."invoices" AS i WHERE i.id=:id AND i.note=:note;', { sqlMode });
  const select = await inferScriptParameters(query, 'fixture', read);
  assert.deepEqual(select.parameterHints.map(hint => [hint.key, hint.kind, hint.columnType]), [
    ['id', 'integer', 'bigint unsigned'], ['note', 'text', 'varchar(50)']
  ]);
  const insert = analyzeScript('INSERT INTO invoices (id,amount) VALUES (?,?),(?,?)', { sqlMode, readOnly: false });
  assert.deepEqual((await inferScriptParameters(insert, 'fixture', read)).parameterHints.map(hint => hint.kind),
    ['integer', 'decimal', 'integer', 'decimal']);
  const join = analyzeScript('SELECT a.id FROM invoices a JOIN invoices b ON a.id=b.id WHERE a.id=?', { sqlMode });
  assert.deepEqual((await inferScriptParameters(join, 'fixture', read)).parameterHints, []);
  const repeated = analyzeScript('SELECT id FROM invoices WHERE id=:mixed AND amount=:mixed', { sqlMode });
  assert.deepEqual((await inferScriptParameters(repeated, 'fixture', read)).parameterHints, []);
  const changed = await inferScriptParameters(query, 'fixture', async () => [fields[0], fields[1], ['note', 'varchar(50)', 'NO']]);
  assert.notEqual(changed.parameterEvidence, select.parameterEvidence);
});

test('the Save command only stores values and choosing a preset requires separate execution approval', async () => {
  const fixture = storage(), commands = new Map();
  const document = { uri: { toString: () => 'untitled:preset.sql' }, languageId: 'sql', version: 1, getText: () => 'SELECT :privateToken;' };
  const described = { ...common, parameterAccountScope: 'd'.repeat(64), connectionId: 42, connectionEpoch: 3,
    sessionId: 'preset-console', statementCount: 1, readOnly: true, autocommit: true, documentUri: document.uri.toString() };
  let runs = 0, previews = 0, approved = false, recordedContext, discarded;
  const database = {
    source: () => 'owned fixture', savedQueryTarget: () => ({ connectionEpoch: 3 }),
    async describeSqlScript() { return described; },
    async previewSqlScript(_sql, options) {
      previews++;
      recordedContext = options.presetContext;
      assert.deepEqual({ ...options.parameters }, { privateToken: { kind: 'text', value: 'secret fixture value' } });
      return { ...described, parameterDefinitions: [{ ...described.parameterDefinitions[0], valueKind: 'text' }],
        reviewId: 'preset-review', expiresAt: Date.now() + 10000 };
    },
    scriptResultBegin: () => 1, scriptResultFinish() {}, async showResults() {},
    discardSqlScript(reviewId, connectionEpoch) { discarded = { reviewId, connectionEpoch }; },
    async runSqlScript() {
      runs++;
      return { state: 'completed', statements: [], completed: 0, failed: 0, notRun: 0 };
    }
  };
  const dispose = () => ({ dispose() {} });
  const vscode = {
    Uri: { parse: value => value },
    commands: { registerCommand(id, callback) { commands.set(id, callback); return dispose(); } },
    workspace: { isTrusted: true, registerTextDocumentContentProvider: dispose, onDidCloseTextDocument: dispose,
      openTextDocument: async uri => uri },
    window: {
      activeTextEditor: { document, selection: { isEmpty: true } },
      async showQuickPick(items, options) {
        return options.title === 'Choose SQL parameter values' ? items.find(item => item.id) : items.find(item => item.kind === 'text');
      },
      async showInputBox(options) { return options.title.startsWith('Save') ? 'Private fixture' : 'secret fixture value'; },
      async showInformationMessage() {}, async showTextDocument() {},
      async showWarningMessage() { return approved ? 'Run Script' : undefined; },
      async showErrorMessage(message) { assert.fail(message); }
    }
  };
  const app = registerSqlScripts({ workspaceState: fixture.state, secrets: fixture.secrets }, vscode, { database });
  try {
    await commands.get('rocketbrain.sql.saveParameterPreset')();
    assert.equal(fixture.encrypted.size, 1);
    assert.equal(previews, 0);
    assert.equal(runs, 0);
    await commands.get('rocketbrain.sql.runWithParameters')();
    assert.equal(previews, 1);
    assert.equal(runs, 0);
    assert.deepEqual(discarded, { reviewId: 'preset-review', connectionEpoch: 3 });
    assert.deepEqual(recordedContext, { accountScope: described.parameterAccountScope, evidence: described.parameterEvidence });
    approved = true;
    await commands.get('rocketbrain.sql.runWithParameters')();
    assert.equal(previews, 2);
    assert.equal(runs, 1);
  } finally { await app.dispose(); }
});
