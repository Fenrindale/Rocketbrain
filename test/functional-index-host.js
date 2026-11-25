'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { JOURNAL } = require('../src/db/schema-recovery');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const approvals = { allowImplicitCommit: true, allowDestructive: true, allowDependencyChanges: true,
  allowUnverifiedDependencies: true, autoRecover: true };
const jdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const price = '9007199254740993.125000', initial = '18014398509481986.250000', amended = '18014398509481987.250000';
const quote = name => '`' + name.replaceAll('`', '``') + '`';
const field = (name, type, options = {}) => ({ name, type, nullable: true, defaultKind: 'none', defaultValue: '',
  autoIncrement: false, comment: '', charset: '', collation: '', srsId: '', generationMode: 'none', generationExpression: '', ...options });
function index(name, columns) {
  return { name, unique: false, primaryKey: false, type: 'BTREE', comment: '', columns: columns.map((value, i) => ({
    ...(typeof value === 'string' ? { name: value } : { name: null, expression: value.expression }),
    ordinal: i + 1, prefixLength: null, collation: 'A'
  })) };
}

async function verifyFunctionalIndex(runtime, adapter) {
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const name = 'rb_expr_idx_' + randomBytes(5).toString('hex'), table = quote(name), mysql = runtime.dbEngine === 'mysql';
  const plans = [];
  const count = async object => Number((await actor.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [config.database, object]))[0][0].n);
  const expr = 'qty * price', changed = 'qty * price + 1';
  const nativeIndex = index('idx_total', [{ expression: expr }]);
  const mixedIndex = index('idx_qty_total', ['qty', { expression: expr }]);
  async function indexedRead(sqlExpression, expected) {
    const predicate = 'SELECT qty,' + sqlExpression + ' AS total FROM ' + table + ' FORCE INDEX (idx_total) WHERE ' + sqlExpression + '=CAST(? AS DECIMAL(35,6))';
    const [[plan]] = await actor.execute('EXPLAIN ' + predicate, [expected]);
    assert.equal(plan.key, 'idx_total');
    assert.ok(['ref', 'range', 'const'].includes(plan.type), plan.type);
    const [rows] = await actor.execute(predicate, [expected]);
    assert.deepEqual(rows, [{ qty: 2, total: expected }]);
  }
  async function readIndexParts(object, statement = expr) {
    const [rows] = await actor.execute('SELECT INDEX_NAME name,SEQ_IN_INDEX ordinal,COLUMN_NAME col,EXPRESSION expression FROM information_schema.STATISTICS ' +
      'WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME IN (?,?) ORDER BY INDEX_NAME,SEQ_IN_INDEX', [config.database, object, 'idx_qty_total', 'idx_total']);
    const normalized = value => value?.replace(/[`\s()]/gu, '');
    const compact = normalized(statement);
    assert.deepEqual(rows.map(item => [item.name, Number(item.ordinal), item.col, normalized(item.expression)]), [
      ['idx_qty_total', 1, 'qty', undefined], ['idx_qty_total', 2, null, compact], ['idx_total', 1, null, compact]
    ]);
  }
  const seed = () => actor.execute('INSERT INTO ' + table + ' (qty,price) VALUES (?,?),(?,NULL)', [2, price, 3]);
  try {
    assert.deepEqual(await jdbcReadback(), jdbc);
    await adapter.connect(config);
    const create = await adapter.open();
    const draft = create.draft;
    draft.name = name;
    draft.columns.push(field('qty', 'INT', { nullable: false }), field('price', 'DECIMAL(24,6)'));
    if (!mysql) {
      const bad = structuredClone(draft);
      bad.indexes.push(nativeIndex);
      await assert.rejects(() => adapter.review(create.modelId, bad), /MySQL 8\.0\.13/);
      assert.equal(await count(name), 0);
      draft.columns.push(field('amount', 'DECIMAL(34,6)', { generationMode: 'virtual', generationExpression: expr }));
      draft.indexes.push(index('idx_total', ['amount']));
      const reviewed = await adapter.review(create.modelId, draft);
      await adapter.preview?.(create, reviewed);
      assert.equal((await adapter.apply(create.modelId, reviewed)).state, 'applied');
      await seed();
      await indexedRead('amount', initial);
      const reopened = await adapter.open(name);
      const observed = reopened.draft.indexes.find(value => value.name === 'idx_total');
      assert.equal(observed.columns[0].name, 'amount');
      assert.equal(Object.hasOwn(observed.columns[0], 'expression'), false);
      assert.deepEqual(await jdbcReadback(), jdbc);
      return { engine: runtime.dbEngine, version, jdbc, nativeExpressionKey: false, wrongDialectRefused: true,
        indexedNamedGeneratedColumn: true, exactDecimalIndexLookup: true };
    }

    for (const bad of ['qty', 'qty * (SELECT 1)', 'RAND() + qty']) {
      const candidate = structuredClone(draft);
      candidate.indexes.push(index('idx_total', [{ expression: bad }]));
      await assert.rejects(() => adapter.review(create.modelId, candidate), /arithmetic operator|signed numeric base columns/);
      assert.equal(await count(name), 0);
    }
    draft.indexes.push(nativeIndex, mixedIndex);
    const reviewed = await adapter.review(create.modelId, draft);
    assert.equal(reviewed.validation.cleaned, true);
    assert.match(reviewed.sql, /KEY `idx_total` \(\(`qty` \* `price`\)\)/u);
    assert.equal(await count(name), 0);
    await adapter.preview?.(create, reviewed);
    assert.equal((await adapter.apply(create.modelId, reviewed)).state, 'applied');
    await seed();
    await readIndexParts(name);
    await indexedRead('qty * price', initial);
    const [[physical]] = await actor.execute('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [config.database, name]);
    assert.equal(Number(physical.n), 3);

    const opened = await adapter.open(name);
    const observed = opened.draft.indexes.find(value => value.name === 'idx_qty_total');
    assert.deepEqual(observed.columns.map(part => [part.name, part.ordinal]), [['qty', 1], [null, 2]]);
    assert.match(observed.columns[1].expression, /qty.*\*.*price/u);
    for (const key of opened.draft.indexes.filter(value => value.name.startsWith('idx_'))) {
      key.columns.find(part => part.name === null).expression = changed;
    }
    const altered = await adapter.review(opened.modelId, opened.draft);
    const [step] = altered.plan.steps;
    assert.deepEqual(step.common, ['id', 'qty', 'price']);
    assert.doesNotMatch(step.copySql, /\*|idx_total/u);
    plans.push(altered.plan);
    await adapter.preview?.(opened, altered);
    const applied = await adapter.apply(opened.modelId, altered);
    assert.equal(applied.state, 'applied', JSON.stringify(applied.error || applied));
    await readIndexParts(name, changed);
    await readIndexParts(step.backup);
    await indexedRead(changed, amended);
    const recovered = await adapter.recover(opened.modelId, altered);
    assert.equal(recovered.state, 'recovered', JSON.stringify(recovered.error || recovered));
    await readIndexParts(name);
    await indexedRead(expr, initial);
    assert.deepEqual(await jdbcReadback(), jdbc);
    return { engine: runtime.dbEngine, version, jdbc, nativeExpressionKey: true, mixedKeyPartObserved: true,
      observedAndReopened: true, exactDecimalIndexLookup: true, reviewedRebuild: true, retainedOriginalRestored: true,
      hiddenEngineColumnsNotCopied: true, unsupportedExpressionsRefused: 3 };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try {
        const retained = plans.flatMap(plan => plan.steps.flatMap(step => [step.shadow, step.backup, step.quarantine])).filter(Boolean);
        for (const object of [name, ...retained]) {
          assert.match(object, /^rb_expr_idx_[a-f0-9]+$|^__rb_(?:shadow|backup|after)_[a-f0-9]+_0$/u);
          await actor.query('DROP TABLE IF EXISTS ' + quote(object));
        }
        if (plans.length && await count(JOURNAL)) {
          for (const plan of plans) await actor.execute('DELETE FROM ' + quote(JOURNAL) + ' WHERE operation_id=?', [plan.id]);
        }
      } finally { await actor.end(); }
    }
  }
}

async function verifyFunctionalIndexBackend() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  let db;
  return verifyFunctionalIndex(runtime, {
    async connect(config) { db = new MysqlService(config); },
    disconnect: () => db?.dispose(),
    open: table => db.openTableDesigner(table ? { table } : {}),
    review: (modelId, draft) => db.previewTableDesign({ modelId, draft }),
    apply: (_modelId, review) => db.applyTableDesign({ reviewId: review.reviewId, ...approvals }),
    recover: (_modelId, review) => db.recoverSchemaRebuild({ operationId: review.plan.id, ...approvals })
  });
}

async function runFunctionalIndexChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const author = api.dbAuthoring;
  const result = await verifyFunctionalIndex(runtime, {
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    open: table => table ? vscode.commands.executeCommand('rocketbrain.schema.editTable', { table: { name: table } }) :
      vscode.commands.executeCommand('rocketbrain.schema.createTable'),
    review: (id, draft) => author.reviewDesigner(id, draft),
    apply: id => author.applyDesigner(id, approvals),
    recover: id => author.recoverDesigner(id, approvals),
    async preview(model, reviewed) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-designer:/' + model.modelId + '/review.sql'));
      assert.equal(document.getText().replaceAll('\r\n', '\n'), reviewed.sql.replaceAll('\r\n', '\n'));
      assert.equal(document.isDirty, false);
    }
  });
  checks.push(result.nativeExpressionKey ? 'The native designer authored, observed, rebuilt and restored real MySQL functional index parts.' :
    'MariaDB rejected a native expression key and indexed the explicitly named generated result.');
  return { ...result, nativeDesignerReview: true };
}

module.exports = { runFunctionalIndexChecks, verifyFunctionalIndexBackend };
if (require.main === module) verifyFunctionalIndexBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
