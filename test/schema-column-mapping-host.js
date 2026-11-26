'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const F = require('./helpers/schema-column-mapping-fixture');

async function runSchemaColumnMappingChecks(api, vscode, checks) {
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const {config, engine} = await F.ownedConfig(spring.dbConfigPath);
  assert.equal(engine, spring.dbEngine);
  const cpFile = process.env.ROCKETBRAIN_SCHEMA_COLUMN_MAP_SPRING_CLASSPATH || path.join(spring.projectPath, 'build', 'runtime-classpath.txt');
  const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
  const javaHome = runtimeFile ? JSON.parse(await fs.readFile(runtimeFile, 'utf8')).javaHome :
    api.java.getState().javaHome || vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');
  assert.ok(javaHome);
  const s = await F.fixture(config);
  const schema = api.schemaComparison;
  const capture = scope => schema.capture(scope);
  const jdbc = projected => F.springRead(s, {javaHome, cpFile, engine, projected});
  try {
    await api.connectMysql({...config, readOnly: true});
    await s.prepare(capture);
    const before = await jdbc(false);
    const comparison = await schema.compare(s.desired);
    await assert.rejects(schema.planRebuild(comparison.id, [s.tables.parent], {columnMappings: s.columnMappings}), /FK|foreign key|affected/iu);
    const plan = await schema.planRebuild(comparison.id, s.tableNames, {columnMappings: s.columnMappings});
    s.plans.push(plan);
    assert.equal(plan.formatVersion, 5);
    assert.equal(plan.atomicAcrossTables, false);
    const uri = vscode.Uri.parse('rocketbrain-schema-compare:/' + plan.id + '/migration.sql');
    const preview = await vscode.workspace.openTextDocument(uri);
    assert.match(preview.getText(), /Retain source values.*legacy_code.*current_code/u);
    assert.match(preview.getText(), /REFERENCES [^\r\n]+\x60zone_id\x60,\x60current_code\x60/u);
    assert.equal((await schema.applyRebuild(plan.id, F.flags)).state, 'applied');
    await s.checkGraph(capture, true);
    assert.deepEqual(await jdbc(true), before);
    await api.connectMysql({...config, readOnly: true});
    const recoveries = await schema.listRecoveries();
    assert.ok(recoveries.operations.some(item => item.operationId === plan.id));
    const restored = await schema.recoverRebuild(plan.id, {...F.flags, connectionEpoch: recoveries.connectionEpoch});
    assert.equal(restored.state, 'recovered');
    assert.equal(restored.originalSchemaAndDataVerified, true);
    await s.checkGraph(capture, false);
    assert.deepEqual(await jdbc(false), before);
    const isolation = await (await fetch(spring.baseUrl + '/probe/testing-state')).json();
    assert.deepEqual(isolation, {people: 2, departments: 1, rolledBackNames: 0});
    checks.push('Reviewed rebuild displayed the explicit renamed value lineage and ordered composite foreign key, applied both selected owners, and restored original values on a new connection.');
    return {engine, spring: before, reviewedMapping: true, formatVersion: 5, bothOwnersRequired: true,
      originalValuesRestored: true, foreignKeyAndIndexPreserved: true, independentPeerPreserved: true, isolation};
  } finally {
    try {await vscode.commands.executeCommand('rocketbrain.useDemo');}
    finally {await s.close();}
  }
}

module.exports = {runSchemaColumnMappingChecks};
