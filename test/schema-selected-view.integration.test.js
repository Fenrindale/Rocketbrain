'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash, randomBytes} = require('node:crypto');
const mysql = require('mysql2/promise');
const {MysqlService} = require('../src/db/mysql');
const {captureSchema, compareSnapshots} = require('../src/db/schema-diff');
const {JOURNAL} = require('../src/db/schema-recovery');
const {ownedConfig, q, flags} = require('./helpers/schema-column-mapping-fixture');
const {springJdbcClasspath, runJavaFixture} = require('./helpers/instance-inline-fixture');

const database = process.env.ROCKETBRAIN_SCHEMA_COLUMN_MAP_CONFIG;
const runtime = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const cpFile = process.env.ROCKETBRAIN_SCHEMA_COLUMN_MAP_SPRING_CLASSPATH;

async function springQuery(work, config, engine, javaHome, nested) {
  const file = path.join(work, 'SelectedDependencyView.java');
  const sql = 'SELECT id FROM ' + nested + ' ORDER BY id';
  await fs.writeFile(file, [
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class SelectedDependencyView {',
    '  public static void main(String[] args) {',
    '    var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_VIEW_JDBC_URL"),',
    '      System.getenv("RB_VIEW_JDBC_USER"), System.getenv("RB_VIEW_JDBC_PASSWORD")));',
    '    System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|");',
    '    System.out.print(jdbc.queryForList("' + sql + '", Integer.class));',
    '  }',
    '}', ''
  ].join('\n'));
  const result = await runJavaFixture({
    javaHome, file, binaryDirectory: work, className: 'SelectedDependencyView',
    classpath: await springJdbcClasspath(cpFile, engine), config, engine, jdbcPrefix: 'RB_VIEW'
  });
  return {version: result.server, rows: result.output};
}

test('actual selected table and dependent view rebuild validates nested reads, preserves staged-out data, and restores exact original definitions', {
  skip: !database || !runtime || !cpFile,
  timeout: 240000
}, async () => {
  const {config, engine} = await ownedConfig(database);
  const {javaHome} = JSON.parse(await fs.readFile(runtime, 'utf8'));
  const actor = await mysql.createConnection(config);
  let service = new MysqlService(config);
  const table = 'rb_selview_' + randomBytes(5).toString('hex');
  const view = table + '_view';
  const nested = table + '_nested';
  const scope = {tables: [table, view, nested]};
  const capture = () => captureSchema(service, scope);
  const tempRoot = await fs.realpath(os.tmpdir());
  const work = await fs.mkdtemp(path.join(tempRoot, 'rb-selview-spring-'));
  const jdbc = () => springQuery(work, config, engine, javaHome, nested);
  const plans = [];
  const initialRows = [[1, 'Alpha', 'preserve one'], [2, 'ALPha', 'preserve two'], [3, 'Beta', 'preserve three']];
  const keys = changes => changes.map(({kind, table, object}) => [kind, table, object]);
  const condition = projected => projected ? 'ALPha%' : 'Alpha%';

  async function writeView(action, match) {
    await actor.query(action + ' ALGORITHM=MERGE SQL SECURITY INVOKER VIEW ' + q(view) +
      ' AS SELECT id,note AS display_note FROM ' + q(table) + " WHERE note LIKE '" + match + "'");
  }
  async function create(projected) {
    await actor.query('CREATE TABLE ' + q(table) + ' (id INT PRIMARY KEY,note VARCHAR(' +
      (projected ? '64' : '32') + ') NOT NULL' + (projected ? '' : ',retained VARCHAR(32) NOT NULL') +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    await writeView('CREATE', condition(projected));
    await actor.query('CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW ' + q(nested) +
      ' AS SELECT id,display_note FROM ' + q(view));
  }
  async function dropFixture() {
    await actor.query('DROP VIEW IF EXISTS ' + q(nested));
    await actor.query('DROP VIEW IF EXISTS ' + q(view));
    await actor.query('DROP TABLE IF EXISTS ' + q(table));
  }
  async function definitions() {
    const snapshots = await capture();
    return [view, nested].map(name => snapshots.tables.find(value => value.name === name).createSql);
  }
  async function rows() {
    const [result] = await actor.query({sql:'SELECT id,note,retained FROM ' + q(table) + ' ORDER BY id', rowsAsArray:true});
    return result;
  }

  try {
    await create(true);
    const desired = await capture();
    await dropFixture();
    await create(false);
    for (const row of initialRows) await actor.execute('INSERT INTO ' + q(table) + ' VALUES (?,?,?)', row);
    const current = await capture();
    const originalDefinitions = await definitions();
    const before = await jdbc();
    assert.equal(before.rows, '[1]');
    assert.deepEqual(await rows(), initialRows);
    const differences = compareSnapshots(current, desired).changes;
    const selected = differences.filter(change => change.kind === 'change-view' && change.table === view ||
      change.kind === 'change-column' && change.table === table && change.object === 'note');
    const unselected = differences.find(change => change.kind === 'drop-column' && change.object === 'retained');
    assert.equal(selected.length, 2);
    assert.ok(unselected);
    const changeIds = selected.map(change => change.id);
    const input = {current, desired, changeIds};
    const opts = {...flags, allowDependencyChanges:true};
    await assert.rejects(service.previewSchemaRebuild({...input, changeIds: selected.filter(c => c.kind === 'change-view').map(c => c.id)}),
      /table|dependen|select/iu);

    const stale = await service.previewSchemaRebuild(input);
    plans.push(stale.plan);
    await writeView('ALTER', 'Beta%');
    const stopped = await service.applySchemaRebuild({...opts, reviewId:stale.reviewId});
    assert.equal(stopped.state, 'preflight-refused', JSON.stringify(stopped));
    assert.deepEqual(await rows(), initialRows);
    await writeView('ALTER', condition(false));
    assert.deepEqual(await definitions(), originalDefinitions);

    const review = await service.previewSchemaRebuild(input);
    plans.push(review.plan);
    assert.equal(review.plan.formatVersion, 7);
    assert.deepEqual(review.plan.steps.map(s => s.table), [table]);
    assert.deepEqual([...review.plan.selectedChangeIds].sort(), [...changeIds].sort());
    assert.ok(review.plan.requiresDependencyChangeApproval);
    assert.equal(review.plan.atomicAcrossTables, false);
    const previous = review.plan.dependencies.before.views.find(v => v.name === view);
    const proposed = review.plan.dependencies.after.views.find(v => v.name === view);
    assert.match(previous.definition, /'Alpha%'/u);
    assert.match(proposed.definition, /'ALPha%'/u);
    assert.equal(review.plan.dependencies.before.views.find(v => v.name === nested).definition,
      review.plan.dependencies.after.views.find(v => v.name === nested).definition);
    assert.match(review.plan.sql, /'ALPha%'/u);
    await assert.rejects(service.applySchemaRebuild({...opts, reviewId:review.reviewId, allowDependencyChanges:false}), /dependenc|approve|fence/iu);
    input.changeIds.push(unselected.id);
    proposed.definition = previous.definition;
    const applied = await service.applySchemaRebuild({...opts, reviewId:review.reviewId});
    assert.equal(applied.state, 'applied', JSON.stringify(applied));

    const after = await jdbc();
    assert.equal(after.rows, '[2]');
    assert.equal(after.version, before.version);
    assert.deepEqual(await rows(), initialRows);
    assert.deepEqual(keys(compareSnapshots(await capture(),desired).changes), keys([unselected]));
    assert.equal((await definitions())[1], originalDefinitions[1]);
    const [[saved]] = await actor.execute('SELECT payload FROM ' + q(JOURNAL) + ' WHERE operation_id=?', [review.plan.id]);
    const tampered = JSON.parse(saved.payload);
    const graph = tampered.plan.dependencies;
    graph.after.views.find(v => v.name === view).definition = previous.definition;
    delete graph.fingerprint;
    graph.fingerprint = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
    await actor.execute('UPDATE ' + q(JOURNAL) + ' SET payload=? WHERE operation_id=?', [JSON.stringify(tampered), review.plan.id]);
    await service.dispose();
    service = new MysqlService(config);
    await assert.rejects(service.recoverSchemaRebuild({...opts, operationId:review.plan.id}), /journal|selected|view|project|scope/iu);
    assert.deepEqual(await rows(), initialRows);
    await actor.execute('UPDATE ' + q(JOURNAL) + ' SET payload=? WHERE operation_id=?', [saved.payload, review.plan.id]);
    const recovered = await service.recoverSchemaRebuild({...opts, operationId:review.plan.id});
    assert.equal(recovered.state, 'recovered', JSON.stringify(recovered));
    const restored = await jdbc();
    assert.deepEqual(restored, before);
    assert.deepEqual(await definitions(), originalDefinitions);
    assert.deepEqual(await rows(), initialRows);
    assert.deepEqual(compareSnapshots(await capture(),current).changes, []);
    const receipt = process.env.ROCKETBRAIN_SCHEMA_SELECTED_VIEW_RECEIPT;
    if (receipt) await fs.writeFile(path.resolve(receipt), JSON.stringify({
      engine, version:before.version, before, after, restored,
      exactOriginalDefinitionsRecovered:true, selectedViewBodyVerified:true,
      nestedViewUnchangedAndReadable:true, unselectedRowsPreserved:true,
      dependencyApprovalRequired:true, staleBeforeApplyRefused:true,
      tamperedSelectedViewRefused:true, selectedReviewImmutable:true, atomicAcrossTables:false
    }, null, 2) + '\n', {flag:'wx'});
  } finally {
    try {
      await service.dispose();
      await dropFixture();
      for (const plan of plans) {
        for (const step of plan.steps) for (const name of [step.shadow, step.quarantine, step.backup].filter(Boolean)) {
          await actor.query('DROP TABLE IF EXISTS ' + q(name));
        }
        try { await actor.execute('DELETE FROM ' + q(JOURNAL) + ' WHERE operation_id=?', [plan.id]); }
        catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error; }
      }
    } finally {
      await actor.end();
      const ownedWork = await fs.realpath(work);
      assert.equal(path.dirname(ownedWork), tempRoot);
      assert.ok(path.basename(ownedWork).startsWith('rb-selview-spring-'));
      await fs.rm(ownedWork, {recursive:true, force:false, maxRetries:8, retryDelay:250});
    }
  }
});
