'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function verifyColumnOrigin(runtime, adapter) {
  const config = await read(runtime.dbConfigPath);
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder, 'owner.json'));
  const cross = await read(path.join(folder, 'cross-schema.json'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(owner.id, path.basename(folder));
  assert.equal(owner.id, cross.fixtureId);
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const raw = await mysql.createConnection(config);
  const suffix = randomBytes(5).toString('hex'), inner = 'rb_origin_input_' + suffix, outer = 'rb_origin_outer_' + suffix;
  const remoteBase = 'rb_origin_remote_base_' + suffix, remoteView = 'rb_origin_remote_view_' + suffix;
  const [local, remote] = cross.schemas;
  const direct = 'SELECT p.id FROM rb_spring_person p';
  const nested = 'WITH ids(person_id) AS (SELECT v.output_id FROM ' + outer + ' v) ' +
    'SELECT d.nested_id FROM (SELECT c.person_id AS nested_id FROM ids c) d';
  const dataSource = local + '.rb_spring_person';
  const withAlias = alias => 'CREATE OR REPLACE SQL SECURITY INVOKER VIEW ' + remote + '.' + inner +
    ' (person_key) AS SELECT ' + alias + ' FROM ' + dataSource + ' p';
  const locate = async (text, cursor) => {
    const result = await adapter.resolve(text, text.indexOf(cursor) + 1);
    assert.equal(result.executedSql, false);
    assert.ok(Number.isFinite(Date.parse(result.observedAt)));
    return result;
  };
  try {
    const [[{ datadir }]] = await raw.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(), folder.toLowerCase());
    const spring = await adapter.probe();
    assert.equal(spring.people, 2);
    await raw.query(withAlias('p.id'));
    await raw.query('CREATE SQL SECURITY INVOKER VIEW ' + local + '.' + outer +
      ' AS SELECT v.person_key AS output_id FROM ' + remote + '.' + inner + ' v WITH LOCAL CHECK OPTION');
    await raw.query('CREATE TABLE ' + remote + '.' + remoteBase + ' (record_id BIGINT PRIMARY KEY) ENGINE=InnoDB');
    await raw.query('CREATE SQL SECURITY INVOKER VIEW ' + remote + '.' + remoteView +
      ' AS SELECT p.record_id AS source_record FROM ' + remote + '.' + remoteBase + ' p');
    await adapter.connect(config);
    const directResult = await locate(direct, 'id');
    assert.deepEqual(directResult.chain.map(item => [item.object.name, item.column]), [['rb_spring_person', 'id']]);
    const nestedResult = await locate(nested, 'nested_id');
    assert.deepEqual(nestedResult.chain.map(item => [item.object.schema, item.object.kind, item.object.name, item.column]), [
      [local, 'view', outer, 'output_id'], [remote, 'view', inner, 'person_key'], [local, 'table', 'rb_spring_person', 'id']
    ]);
    assert.ok(nestedResult.quickExplanation.includes(remote + '.' + inner + '.person_key'));
    assert.ok(nestedResult.quickExplanation.includes(dataSource + '.id'));
    assert.equal(await adapter.anchor(nestedResult), 'id');
    const remoteResult = await locate('SELECT v.source_record FROM ' + remote + '.' + remoteView + ' v', 'source_record');
    assert.deepEqual(remoteResult.chain.map(item => [item.object.schema,item.object.name,item.column]), [
      [remote,remoteView,'source_record'], [remote,remoteBase,'record_id']
    ]);
    await adapter.assertLocalAndHover?.(nested, nested.indexOf('nested_id') + 1, nestedResult);
    await assert.rejects(adapter.resolve('SELECT d.result FROM (SELECT p.id + 1 AS result FROM rb_spring_person p) d', 11),
      /no unique pass-through database origin/);
    await assert.rejects(adapter.resolve('SELECT p.id FROM rb_spring_person p UNION ALL SELECT p.id FROM rb_spring_person p', 10), /unique, nonrecursive origin/);
    await raw.query(withAlias('p.id + 1'));
    await assert.rejects(adapter.resolve(nested, nested.indexOf('nested_id') + 1), /view output is an expression/);
    assert.deepEqual(await adapter.probe(), spring);
    return { localAliasDefinition: Boolean(adapter.assertLocalAndHover), ddlAnchor: true, quickExplanation: true, viewLayers: 2, crossSchema: true,
      canonicalForeignViewScopes: true,
      exactTerminalColumn: true, expressionAndSetRejected: true, changedDefinitionRejected: true, noUserSqlExecuted: true, spring };
  } finally {
    try {
      await raw.query('DROP VIEW IF EXISTS ' + local + '.' + outer);
      await raw.query('DROP VIEW IF EXISTS ' + remote + '.' + inner);
      await raw.query('DROP VIEW IF EXISTS ' + remote + '.' + remoteView);
      await raw.query('DROP TABLE IF EXISTS ' + remote + '.' + remoteBase);
    } finally { await raw.end(); }
  }
}

async function runSqlColumnOriginChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['goToColumnOrigin', 'explainColumnOrigin']) assert.ok(commands.includes('rocketbrain.sql.' + name));
  const editors = new Map();
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const suffix = randomBytes(8).toString('hex');
  const files = [];
  async function editor(text) {
    if (!editors.has(text)) {
      const file = path.join(workspace, 'rb-origin-' + suffix + '-' + editors.size + '.sql');
      await fs.writeFile(file, text, {flag:'wx'});
      files.push(file);
      editors.set(text, await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }
    return editors.get(text);
  }
  try {
    checks.sqlColumnOrigin = await verifyColumnOrigin(runtime, {
      connect: config => api.connectMysql(config),
      async resolve(text, offset) {
        const document = await editor(text);
        return api.sqlAnalysis.resolveColumnOrigin(document, document.positionAt(offset));
      },
      async anchor(result) {
        const document = await vscode.workspace.openTextDocument(result.location.uri);
        assert.equal(document.uri.scheme, 'rocketbrain-object-source');
        return document.getText(result.location.range).replaceAll(String.fromCharCode(96), '');
      },
      async assertLocalAndHover(text, offset, result) {
        const document = await editor(text), position = document.positionAt(offset);
        const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
        assert.ok(definitions.some(item => (item.uri ?? item.targetUri).toString() === document.uri.toString()));
        const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position);
        const markdown = hovers.flatMap(hover => hover.contents.map(item => item.value ?? item)).join('\n');
        const label = new vscode.MarkdownString().appendText(result.chain[1].object.name).value;
        assert.ok(markdown.includes(label), 'The native hover shows the verified inner view.');
      },
      async probe() {
        const response = await fetch(runtime.baseUrl + '/probe/testing-state', {signal:AbortSignal.timeout(5000)});
        assert.ok(response.ok);
        return response.json();
      }
    });
    if (Array.isArray(checks)) checks.push('The installed SQL origin commands resolved the exact physical column from live view metadata.');
    return checks.sqlColumnOrigin;
  } finally {
    await Promise.all(files.map(file => fs.rm(file, {force:true})));
  }
}

module.exports = { runSqlColumnOriginChecks, verifyColumnOrigin };
