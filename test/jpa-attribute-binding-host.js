'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { ObserverClient } = require('../src/jpa/observer-client');
const { summarizePerformance } = require('../src/jpa/fetch-performance');
const { jdbcReadback } = require('./java-source-analysis-host');

const entityJavaType = 'fixture.boot.AttributeBindingEntry';
const unitJavaType = 'fixture.boot.AttributeBindingProbe$Units';
const converter = name => 'fixture.boot.AttributeBindingProbe$' + name + 'Converter';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function withAttributeFixture(run) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  for (const url of [runtime.baseUrl, runtime.observerUrl]) assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const file = await fs.realpath(runtime.dbConfigPath);
  const folder = path.dirname(file);
  const owner = await read(path.join(folder, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(path.basename(folder), owner.id);
  const config = await read(file);
  assert.deepEqual([config.host, config.database], ['127.0.0.1', 'rocketbrain_fixture']);
  const token = (await fs.readFile(runtime.observerTokenFile, 'utf8')).trim();
  const verification = await jdbcReadback();
  const connection = await mysql.createConnection(config);
  const id = 398520861027512;
  let seeded = false;
  try {
    const [[server]] = await connection.query('SELECT @@datadir AS datadir');
    assert.equal(path.relative(folder, path.dirname(await fs.realpath(server.datadir))), '');
    await connection.execute('INSERT INTO rb_attribute_binding (id, unit_count, label_text, plain_note) VALUES (?, ?, ?, ?)',
      [id, 678391270581901, 'RB_BINDING_3704', 'fixture-only-note']);
    seeded = true;
    const [columns] = await connection.execute(
      'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType FROM information_schema.columns WHERE table_schema=? AND table_name=?',
      [config.database, 'rb_attribute_binding']);
    const physical = Object.fromEntries(columns.map(column => [column.name, column.dataType]));
    assert.deepEqual([physical.unit_count, physical.label_text, physical.plain_note], ['bigint', 'varchar', 'varchar']);
    async function app(operation) {
      const response = await fetch(runtime.baseUrl + '/probe/jpa-attribute-binding/' + operation,
        { signal: AbortSignal.timeout(8000), redirect: 'error' });
      assert.equal(response.ok, true, operation + ' HTTP ' + response.status);
      return response.json();
    }
    const proof = await run({ runtime, token, app });
    assert.deepEqual(await jdbcReadback(), verification);
    return { engine: runtime.dbEngine, jdbc: verification, physical, ...proof };
  } finally {
    try {
      if (seeded) await connection.execute('DELETE FROM rb_attribute_binding WHERE id=?', [id]);
    } finally { await connection.end(); }
  }
}

async function confirmAttributeBindings({ refresh, inspect, fixture }) {
  const { app, token } = fixture;
  assert.deepEqual(await app('read'), { matched: 1 });
  const beforeCounters = await app('counters');
  assert.ok(Object.values(beforeCounters).every(count => count > 0));
  const before = await refresh();
  assert.equal(before.capabilities.attributeBinding, true);
  const factories = before.factories.filter(candidate => candidate.entities.some(value => value.javaType === entityJavaType));
  assert.equal(factories.length, 1);
  const factory = factories[0];
  assert.equal(factory.statistics.enabled, true);
  const target = { factoryId: factory.id, entityJavaType };
  const results = [];
  for (const propertyPath of ['units', 'labels.normalized', 'note', 'labels', 'absent']) {
    results.push(await inspect({ ...target, propertyPath }));
  }
  const [unitsResult, labelResult, noteResult, unsupportedResult, absentResult] = results;
  for (const report of results) {
    assert.equal(report.factoryId, factory.id);
    assert.equal(report.observerExecutedSql, false);
    assert.equal(report.valuesRetained, false);
    assert.equal(report.applicationCallbacksInvoked, false);
  }
  assert.deepEqual(results.map(report => report.state), ['observed', 'observed', 'observed', 'partial', 'unknown'], JSON.stringify(results, null, 2));
  assert.deepEqual(unitsResult.declaration, { basis: 'jakarta-persistence-metamodel', kind: 'BASIC', javaType: unitJavaType });
  assert.equal(unitsResult.mapping.domainJavaType, unitJavaType);
  assert.equal(unitsResult.mapping.relationalJavaType, 'java.lang.Long');
  assert.equal(unitsResult.mapping.column, 'unit_count');
  assert.equal(unitsResult.mapping.jdbcType, 'BIGINT');
  assert.equal(unitsResult.mapping.jdbcTypeCode, -5);
  assert.match(unitsResult.mapping.binderClass, /BigIntJdbcType\$/u);
  assert.deepEqual(unitsResult.mapping.conversion, { kind: 'attribute-converter', javaType: converter('Units') });
  assert.equal(labelResult.mapping.column, 'label_text');
  assert.equal(labelResult.mapping.jdbcType, 'VARCHAR');
  assert.equal(labelResult.mapping.jdbcTypeCode, 12);
  assert.deepEqual(labelResult.mapping.conversion, { kind: 'attribute-converter', javaType: converter('Label') });
  assert.deepEqual(noteResult.mapping.conversion, { kind: 'no-registered-converter' });
  assert.equal(noteResult.mapping.column, 'plain_note');
  assert.equal(unsupportedResult.reason, 'unsupported_jpa_kind');
  assert.equal(unsupportedResult.declaration.kind, 'EMBEDDED');
  assert.equal(absentResult.reason, 'attribute_unavailable');

  const wrongFactory = await inspect({ ...target, factoryId: 'factory-999999', propertyPath: 'units' });
  assert.equal(wrongFactory.state, 'unknown');
  assert.equal(wrongFactory.reason, 'factory_unavailable');
  const post = await refresh();
  const afterFactory = post.factories.find(value => value.id === factory.id);
  assert.deepEqual(afterFactory.statistics, factory.statistics, 'Inspection changed Hibernate statement or query counters');
  assert.deepEqual(await app('counters'), beforeCounters, 'Inspection invoked an application converter');

  const measured = summarizePerformance(post.performance).requests.find(sample => sample.route === '/probe/jpa-attribute-binding/read');
  assert.ok(measured?.selects.length === 1, JSON.stringify(measured));
  const [selection] = measured.selects;
  assert.equal(selection.table, 'rb_attribute_binding');
  assert.equal(selection.binds.state, 'complete');
  assert.deepEqual(selection.binds.positions.map(value => [value.index, value.jdbcType]), [[1, 'BIGINT'], [2, 'VARCHAR']]);
  const result = { inspected: [unitsResult, labelResult, noteResult], unavailable: [unsupportedResult.reason, absentResult.reason, wrongFactory.reason],
    actualBindPositions: selection.binds.positions, converterCountersUnchanged: true, statementCountersUnchanged: true, matchingRows: 1 };
  for (const value of [token, 'RB_BINDING_3704', 'rb_binding_3704', '678391270581901', 'fixture-only-note']) {
    assert.ok(!JSON.stringify(result).includes(value), 'The inspected output disclosed a fixture value');
  }
  return result;
}

async function runJpaAttributeBindingChecks(api, vscode, checks) {
  const observer = api.jpa.observer;
  const proof = await withAttributeFixture(async fixture => {
    try {
      await observer.connect({ url: fixture.runtime.observerUrl, token: fixture.token });
      return await confirmAttributeBindings({ fixture, refresh: () => observer.refresh(), async inspect(target) {
        const report = await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectAttributeBinding', target);
        assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()), report);
        return report;
      } });
    } finally { observer.disconnect(); }
  });
  checks.push('The native attribute inspector showed declared JPA types, converted Hibernate relational types and effective JDBC binder metadata. The live application exercised equivalent BIGINT and VARCHAR binds, while inspection left query and converter counts unchanged.');
  return { ...proof, nativeView: true };
}

if (require.main === module) withAttributeFixture(async fixture => {
  const observer = new ObserverClient({ url: fixture.runtime.observerUrl, token: fixture.token });
  try {
    return await confirmAttributeBindings({ fixture, refresh: () => observer.refresh(),
      inspect: target => observer.inspectAttributeBinding(target) });
  } finally { observer.dispose(); }
}).then(proof => console.log(JSON.stringify(proof)), error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runJpaAttributeBindingChecks };
