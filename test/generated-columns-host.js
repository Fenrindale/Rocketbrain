'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { JOURNAL } = require('../src/db/schema-recovery');

const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const price = '9007199254740993.125000', scaled = 9007199254740993125000n;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = name => '`' + name.replaceAll('`', '``') + '`';
const amount = multiplier => {
  const value = BigInt(multiplier) * scaled;
  return (value / 1000000n) + '.' + String(value % 1000000n).padStart(6, '0');
};
const field = (name, type, options = {}) => ({ name, type, nullable: true, defaultKind: 'none', defaultValue: '',
  autoIncrement: false, comment: '', charset: '', collation: '', srsId: '', generationMode: 'none', generationExpression: '', ...options });
const approvals = { allowImplicitCommit: true, allowDestructive: true, allowDependencyChanges: true,
  allowUnverifiedDependencies: true, autoRecover: true };

async function verifyGeneratedColumns(runtime, adapter) {
  const directory = path.dirname(await fs.realpath(runtime.dbConfigPath)), marker = await read(path.join(directory, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(marker.id, path.basename(directory));
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const assertSpring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  const actor = await mysql.createConnection({ ...config, supportBigNumbers: true, bigNumberStrings: true });
  const name = 'rb_gen_' + randomBytes(6).toString('hex'), literalName = quote(name);
  const rebuilds = [];
  const returns = async () => (await actor.query('SELECT qty,price,line_total,weighted FROM ' + literalName + ' ORDER BY id'))[0];
  const existing = async table => Number((await actor.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [config.database, table]))[0][0].n);
  try {
    const [[server]] = await actor.query('SELECT VERSION() version,@@datadir datadir');
    assert.equal(path.dirname(await fs.realpath(server.datadir)).toLowerCase(), directory.toLowerCase());
    const maria = /MariaDB/i.test(server.version), engine = maria ? 'mariadb' : 'mysql';
    assert.equal(engine, runtime.dbEngine);
    await assertSpring();
    await adapter.connect(config);
    const create = await adapter.open();
    const draft = create.draft;
    draft.name = name;
    draft.columns.push(
      field('qty', 'INT', { nullable: false }), field('price', 'DECIMAL(24,6)'),
      field('line_total', 'DECIMAL(34,6)', { generationMode: 'virtual', generationExpression: 'qty * price' }),
      field('weighted', 'DECIMAL(34,6)', { generationMode: 'stored', generationExpression: '(qty + 3) * price' })
    );
    const unsafe = [
      ['id + 1', /without AUTO_INCREMENT/],
      ['NOW()', /earlier signed numeric/],
      ['weighted + 1', /earlier signed numeric/],
      ['qty * (SELECT 1)', /earlier signed numeric/],
      ['qty + 1; DROP TABLE people', /Use signed numeric/]
    ];
    for (const [expression, reason] of unsafe) {
      const candidate = structuredClone(draft);
      candidate.columns.find(column => column.name === 'line_total').generationExpression = expression;
      await assert.rejects(adapter.review(create.modelId, candidate), reason);
      assert.equal(await existing(name), 0);
    }
    const indexed = structuredClone(draft);
    indexed.indexes.push({ name: 'idx_computed', unique: false, primaryKey: false, type: 'BTREE', comment: '',
      columns: [{ name: 'line_total', ordinal: 1, prefixLength: null, collation: 'A' }] });
    await assert.rejects(adapter.review(create.modelId, indexed), /foreign keys on generated columns/);
    const reviewed = await adapter.review(create.modelId, draft);
    assert.equal(reviewed.kind, 'create');
    assert.equal(reviewed.validation.cleaned, true);
    assert.match(reviewed.sql, /GENERATED ALWAYS AS .* VIRTUAL/u);
    assert.match(reviewed.sql, maria ? /GENERATED ALWAYS AS .* PERSISTENT/u : /GENERATED ALWAYS AS .* STORED/u);
    assert.equal(await existing(name), 0);
    if (adapter.preview) await adapter.preview(create, reviewed);
    const created = await adapter.apply(create.modelId, reviewed);
    assert.equal(created.state, 'applied', JSON.stringify(created.error || created));
    await actor.query('INSERT INTO ' + literalName + ' (qty,price) VALUES (?,?),(?,NULL)', [2, price, 1]);
    assert.deepEqual(await returns(), [{ qty: 2, price, line_total: amount(2), weighted: amount(5) },
      { qty: 1, price: null, line_total: null, weighted: null }]);
    await actor.query('UPDATE ' + literalName + ' SET qty=4 WHERE price IS NOT NULL');
    assert.deepEqual((await returns())[0], { qty: 4, price, line_total: amount(4), weighted: amount(7) });
    await assert.rejects(actor.query('UPDATE ' + literalName + ' SET weighted=5'));

    const modify = await adapter.open(name);
    assert.equal(modify.mode, 'alter');
    const clone = structuredClone(modify.draft);
    assert.equal(clone.columns.find(column => column.name === 'line_total').generationMode, 'virtual');
    assert.equal(clone.columns.find(column => column.name === 'weighted').generationMode, 'stored');
    assert.match(clone.columns.find(column => column.name === 'weighted').generationExpression, /`qty` \+ 3/u);
    clone.columns.find(column => column.name === 'weighted').generationExpression = '(qty + 7) * price';
    clone.columns.push(field('extra_total', 'DECIMAL(34,6)', { generationMode: 'virtual', generationExpression: 'qty * price + 1' }));
    const altered = await adapter.review(modify.modelId, clone);
    rebuilds.push(altered);
    assert.equal(altered.kind, 'rebuild');
    const [plan] = altered.plan.steps;
    assert.deepEqual(plan.common, ['id', 'qty', 'price']);
    assert.match(plan.copySql, /\(`id`,`qty`,`price`\) SELECT /u);
    assert.doesNotMatch(plan.copySql, /line_total|weighted|extra_total/u);
    if (adapter.preview) await adapter.preview(modify, altered);
    const applied = await adapter.apply(modify.modelId, altered);
    assert.equal(applied.state, 'applied', JSON.stringify(applied.error || applied.originalError || applied));
    assert.equal((await returns())[0].weighted, amount(11));
    assert.equal((await actor.query('SELECT extra_total FROM ' + literalName + ' WHERE price IS NOT NULL'))[0][0].extra_total,
      (scaled * 4n / 1000000n + 1n) + '.500000');
    assert.equal((await actor.query('SELECT weighted FROM ' + quote(plan.backup) + ' WHERE price IS NOT NULL'))[0][0].weighted, amount(7));
    const recovered = await adapter.recover(modify.modelId, altered);
    assert.equal(recovered.state, 'recovered', JSON.stringify(recovered.error || recovered));
    assert.equal((await returns())[0].weighted, amount(7));
    const after = await adapter.open(name);
    assert.equal(after.draft.columns.some(column => column.name === 'extra_total'), false);
    assert.match(after.draft.columns.find(column => column.name === 'weighted').generationExpression, /\+ 3/u);
    const overflowDraft = structuredClone(after.draft), tooNarrow = overflowDraft.columns.find(column => column.name === 'line_total');
    tooNarrow.type = 'INT';
    tooNarrow.generationMode = 'stored';
    const overflow = await adapter.review(after.modelId, overflowDraft);
    rebuilds.push(overflow);
    const declined = await adapter.apply(after.modelId, overflow);
    assert.ok(['recovered', 'needs-recovery'].includes(declined.state), JSON.stringify(declined.error || declined));
    assert.equal((await returns())[0].line_total, amount(4));
    assert.equal((await returns())[0].weighted, amount(7));
    await assertSpring();
    return { engine, version: server.version, virtualAndStoredCreation: true, storedSyntax: maria ? 'PERSISTENT' : 'STORED',
      readonlyReview: Boolean(adapter.preview), exactDecimalsAndNullPropagation: true, recalculatedAfterWrite: true,
      directGeneratedWriteRefused: true, unsafeExpressionsRefused: unsafe.length, generatedIndexRefused: true,
      editableObservedModel: true, writableInputsOnlyCopied: true, originalRestored: true, overflowRefusedWithoutPublication: true,
      springIsolation: expectedSpring };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try {
        const retained = rebuilds.flatMap(review => review.plan.steps.flatMap(step => [step.shadow, step.backup, step.quarantine])).filter(Boolean);
        for (const table of [name, ...retained]) {
          assert.match(table, /^rb_gen_[a-f0-9]+$|^__rb_(?:shadow|backup|after)_[a-f0-9]+_0$/u);
          await actor.query('DROP TABLE IF EXISTS ' + quote(table));
        }
        if (rebuilds.length && await existing(JOURNAL)) {
          for (const { plan } of rebuilds) await actor.execute('DELETE FROM ' + quote(JOURNAL) + ' WHERE operation_id=?', [plan.id]);
        }
      } finally { await actor.end(); }
    }
  }
}

async function runGeneratedColumnChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG), author = api.dbAuthoring;
  assert.ok(author);
  const result = await verifyGeneratedColumns(runtime, {
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    open: table => table ? vscode.commands.executeCommand('rocketbrain.schema.editTable', { table: { name: table } })
      : vscode.commands.executeCommand('rocketbrain.schema.createTable'),
    review: (id, draft) => author.reviewDesigner(id, draft),
    apply: id => author.applyDesigner(id, approvals), recover: id => author.recoverDesigner(id, approvals),
    async preview(model, reviewed) {
      assert.ok(author.designerViews().some(view => view.modelId === model.modelId));
      const view = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-designer:/' + model.modelId + '/review.sql'));
      assert.equal(view.getText().replaceAll('\r\n', '\n'), reviewed.sql.replaceAll('\r\n', '\n'));
      assert.equal(view.isDirty, false);
    }
  });
  checks.push('Native table designer reviewed and deployed exact virtual and stored generation, including signed decimal precision and null propagation.');
  checks.push('The review copied only ordinary inputs, verified engine-derived output, restored original generation, and refused unsupported expressions and indexes.');
  return result;
}

module.exports = { runGeneratedColumnChecks, verifyGeneratedColumns };
