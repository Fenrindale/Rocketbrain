'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createResultSnapshotStore, registerResultSnapshots } = require('../src/db/result-snapshots');

function memory() {
  const records = new Map();
  return { records, keys: () => [...records.keys()], get: key => records.get(key), async update(key, value) {
    if (value === undefined) records.delete(key);
    else records.set(key, JSON.parse(JSON.stringify(value)));
  } };
}

const data = {
  columns: ['number', 'region', 'price', 'label', 'label'],
  fields: [{ type: 8 }, { type: 253, characterSet: 45 }, { type: 246 }, { type: 253 }, { type: 253 }],
  rows: [['9007199254740993', 'KR', '15.1200', 'ignored', 'ignored 2'],
    ['9007199254740993', 'JP', '7.2500', 'old', 'old 2'],
    ['9007199254740994', 'JP', '1.0000', 'old', 'old 2']]
};

function host(storage, quick) {
  const documents = [], commands = new Map(), providers = new Map(), subscriptions = [];
  const context = { workspaceState: storage, subscriptions };
  const vscode = {
    workspace: {
      isTrusted: true, workspaceFolders: [{}],
      registerTextDocumentContentProvider(scheme, provider) {
        providers.set(scheme, provider);
        return { dispose: () => providers.delete(scheme) };
      },
      onDidCloseTextDocument() { return { dispose() {} }; },
      async openTextDocument(uri) {
        return { uri, getText: () => providers.get(uri.scheme).provideTextDocumentContent(uri) };
      }
    },
    Uri: { from: ({ scheme, path }) => ({ scheme, path, toString: () => scheme + ':' + path }) },
    window: {
      async showTextDocument(document, options) { documents.push({ document, options }); },
      showQuickPick: quick
    }
  };
  const results = { history: [], exportable: () => false, show: () => assert.fail('should not open a result tab') };
  const api = registerResultSnapshots(context, vscode, results, (id, handler) => commands.set(id, handler));
  return { api, commands, documents, vscode };
}

test('offline comparison binds typed composite positions and reports incomplete source coverage and omitted duplicate labels', async () => {
  const storage = memory(), firstHost = createResultSnapshotStore(storage, () => true);
  const before = await firstHost.save('Baseline', data);
  const after = await firstHost.save('Candidate', {
    ...data,
    rows: [['9007199254740993', 'JP', '7.2600', 'ignored', 'ignored 2'],
      ['9007199254740995', 'KR', '0.0000', 'ignored', 'ignored 2'],
      ['9007199254740993', 'KR', '15.12', 'ignored', 'ignored 2']],
    browse: { page: 1, hasPrevious: true, hasNext: true, filters: [{ column: 'region', value: 'private' }] }
  });
  const fresh = host(storage);
  const keys = [{ target: 0, source: 0 }, { target: 1, source: 1 }];
  const initial = fresh.api.comparison.compare(before.id, after.id, keys);
  assert.deepEqual(initial.summary, { equal: 1, changed: 1, baselineOnly: 1, candidateOnly: 1 });
  assert.deepEqual(initial.differences[0], {
    key: ['9007199254740993', 'JP'],
    state: 'changed',
    fields: [{ baseline: { name: 'price', value: '7.2500' }, candidate: { name: 'price', value: '7.2600' } }]
  });
  assert.deepEqual(initial.baseline.coverage, { kind: 'query-capture', truncated: false });
  assert.deepEqual(initial.candidate.coverage, { kind: 'table-page', truncated: true,
    page: 2, filtered: true, hasPrevious: true, hasNext: true });
  assert.deepEqual(initial.omittedColumns.candidate.map(item => item.ordinal), [4, 5]);
  assert.equal(initial.executedSql, false);
  assert.equal(initial.readOnly, true);
  assert.match(initial.baseline.contentSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(initial), /private/);
  const opened = await fresh.api.comparison.open(before.id, after.id, keys);
  assert.equal(fresh.documents.length, 1);
  assert.deepEqual(JSON.parse(fresh.documents[0].document.getText()), initial);
  assert.equal(opened.documentUri, fresh.documents[0].document.uri.toString());
  assert.throws(() => fresh.api.comparison.compare(before.id, before.id, keys), /two different/);
  await fresh.api.remove(after.id);
  await assert.rejects(fresh.api.comparison.open(before.id, after.id, keys), /snapshot is unavailable/);
});

test('same-name ordinal ambiguity prompts for a candidate mapping and duplicate or NULL keys fail', async () => {
  const storage = memory(), shelf = createResultSnapshotStore(storage, () => true);
  const before = await shelf.save('Baseline', data);
  const duplicateLabel = await shelf.save('Candidate', {
    columns: ['number', 'number', 'zone', 'price'],
    fields: [{ type: 8 }, { type: 253 }, { type: 253 }, { type: 246 }],
    rows: data.rows.map(row => [row[0], 'irrelevant', row[1], row[2]])
  });
  const duplicateRows = await shelf.save('Dupes', { ...data, rows: [data.rows[0], data.rows[0]] });
  const nullKey = await shelf.save('Null key', { ...data, rows: [[null, ...data.rows[0].slice(1)]] });
  const template = await shelf.save('Legacy entry', data);
  delete storage.records.get(storage.keys().find(key => key.endsWith(template.id))).payload.coverage;
  const observed = [];
  const view = host(storage, async (items, options) => {
    observed.push(options.title);
    if (options.title === 'Choose Baseline Query Result') return items.find(item => item.snapshot.id === before.id);
    if (options.title === 'Choose Candidate Query Result') {
      assert.equal(items.some(item => item.snapshot.id === before.id), false);
      return items.find(item => item.snapshot.id === duplicateLabel.id);
    }
    if (options.canPickMany) return items.filter(item => [0, 1].includes(item.column.index));
    if (options.title.startsWith('Map Key Column 1')) return items.find(item => item.column.index === 0);
    return items.find(item => item.column.index === 2);
  });
  const comparison = await view.commands.get('rocketbrain.results.compareSnapshots')();
  assert.equal(comparison.summary.equal, 3);
  assert.deepEqual(comparison.mappedColumns.filter(item => item.key).map(item => item.candidate.ordinal), [1, 3]);
  assert.equal(comparison.omittedColumns.candidate[0].ordinal, 2);
  assert.deepEqual(observed.slice(-2), ['Map Key Column 1 · number', 'Map Key Column 2 · region']);
  const compare = id => view.api.comparison.compare(before.id, id, [{ target: 0, source: 0 }, { target: 1, source: 1 }]);
  assert.throws(() => compare(duplicateRows.id), /source key is duplicated/);
  assert.throws(() => compare(nullKey.id), /source key contains SQL NULL/);
  assert.deepEqual(compare(template.id).candidate.coverage, { kind: 'legacy-capture', truncated: false });
  assert.throws(() => view.api.comparison.compare(before.id, duplicateLabel.id, [{ target: 0, source: 1 }]), /compatible exact typed/);
});
