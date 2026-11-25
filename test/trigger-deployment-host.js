'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { JOURNAL } = require('../src/db/object-editor');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const flags = { allowImplicitCommit: true, allowTriggerReplacement: true };
const tick = String.fromCharCode(96);

async function verifyTriggerDeployment(runtime, adapter) {
  const config = await read(runtime.dbConfigPath), folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(owner.id, path.basename(folder));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const actor = await mysql.createConnection(config), tag = randomBytes(5).toString('hex'), operations = [];
  const table = 'rb_editor_subject_' + tag, first = 'rb_editor_first_' + tag, target = 'rb_editor_main_' + tag;
  const last = 'rb_editor_last_' + tag, update = 'rb_editor_update_' + tag;
  const create = (name, event, body, order = '') => actor.query('CREATE TRIGGER ' + name + ' BEFORE ' + event +
    ' ON ' + table + ' FOR EACH ROW ' + (order && order + ' ') + body);
  const show = async name => (await actor.query('SHOW CREATE TRIGGER ' + name))[0][0];
  const observedTrigger = async name => {
    const [[row]] = await actor.execute('SELECT ACTION_STATEMENT,DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION ' +
      'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [name]);
    return row;
  };
  const order = async () => (await actor.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS ' +
    "WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=? AND ACTION_TIMING='BEFORE' AND EVENT_MANIPULATION='INSERT' ORDER BY ACTION_ORDER", [table]))[0]
    .map(row => row.TRIGGER_NAME);
  const values = async () => (await actor.query('SELECT score FROM ' + table + ' ORDER BY id'))[0].map(row => row.score);
  const review = async (model, body) => {
    const checked = await adapter.review(model, body);
    operations.push(checked.operationId);
    assert.deepEqual(checked.validation, { compiled: true, executed: false, cleaned: true, isolatedSubject: true });
    assert.equal(checked.requiresTriggerReplacementApproval, true);
    return checked;
  };

  try {
    const [[{ datadir }]] = await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(), folder.toLowerCase());
    const spring = await adapter.probe();
    assert.equal(spring.people, 2);
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, score INT NOT NULL) ENGINE=InnoDB');
    await create(first, 'INSERT', 'SET NEW.score=NEW.score+1');
    await create(target, 'INSERT', 'BEGIN SET NEW.score=NEW.score*2; END', 'FOLLOWS ' + first);
    await create(last, 'INSERT', 'SET NEW.score=NEW.score+100', 'FOLLOWS ' + target);
    await create(update, 'UPDATE', 'SET NEW.score=OLD.score+1');
    const original = await observedTrigger(target);
    assert.match((await show(target))['SQL Original Statement'], /NEW.score=NEW.score\*2/);
    await adapter.connect(config);
    assert.ok((await adapter.list()).some(item => item.kind === 'trigger' && item.name === target));
    const model = await adapter.open(target);
    assert.equal(model.table, table);
    assert.equal(model.event, 'INSERT');
    assert.deepEqual(model.originalOrder, [first, target, last]);
    await assert.rejects(adapter.review(model, 'BEGIN INSERT INTO other(id) VALUES (NEW.id); END'), /assignments|external table/i);
    const source = 'BEGIN IF NEW.score > 0 THEN SET NEW.score=NEW.score*3; ELSE SET NEW.score=0; END IF; END';
    const firstReview = await review(model, source);
    assert.match(firstReview.sql, /DROP TRIGGER/);
    assert.match(firstReview.sql, new RegExp('PRECEDES .' + last));
    assert.deepEqual(await observedTrigger(target), original);
    assert.deepEqual(await values(), []);
    await adapter.assertReviewDocument?.(model, firstReview);
    await assert.rejects(adapter.apply(model, firstReview, { allowImplicitCommit: true }), /pause all subject-table writers/);
    const second = await review(model, source);
    const deployed = await adapter.apply(model, second, flags);
    assert.equal(deployed.state, 'applied', deployed.errorCode);
    assert.equal(deployed.bodyExecuted, false);
    assert.equal(deployed.tableWriteLock, true);
    assert.equal(deployed.orderPreserved, true);
    assert.deepEqual(await order(), [first, target, last]);
    const newTrigger = await observedTrigger(target);
    assert.deepEqual({ ...newTrigger, ACTION_STATEMENT: original.ACTION_STATEMENT }, original);
    await actor.query('INSERT INTO ' + table + ' VALUES (1,2)');
    assert.deepEqual(await values(), [109]);

    await adapter.connect(config);
    const recovered = await adapter.recover(second.operationId, flags);
    assert.equal(recovered.state, 'recovered', recovered.errorCode);
    assert.deepEqual(await observedTrigger(target), original);
    assert.deepEqual(await order(), [first, target, last]);
    await actor.query('INSERT INTO ' + table + ' VALUES (2,2)');
    assert.deepEqual(await values(), [109, 106]);

    const updateModel = await adapter.open(update);
    assert.equal(updateModel.event, 'UPDATE');
    const updateReview = await review(updateModel, 'SET NEW.score = OLD.score + 7');
    assert.equal((await adapter.apply(updateModel, updateReview, flags)).state, 'applied');
    await actor.query('UPDATE ' + table + ' SET score = 0 WHERE id=2');
    assert.deepEqual(await values(), [109, 113]);

    const staleModel = await adapter.open(target), stale = await review(staleModel, source);
    await actor.query('DROP TRIGGER ' + last);
    await create(last, 'INSERT', 'SET NEW.score=NEW.score+101', 'FOLLOWS ' + target);
    await assert.rejects(adapter.apply(staleModel, stale, flags), /table or trigger order changed/);
    assert.deepEqual(await observedTrigger(target), original);
    assert.deepEqual(await adapter.probe(), spring);
    return { compiledOnIsolatedTable: true, noBodyExecutionDuringReview: true, tableWriteLock: true, orderPreserved: true,
      exactBodyContextRestoredAfterReconnect: true, actualInsertAndUpdate: [109,106,113], staleSiblingRejected: true,
      explicitWriterPauseRequired: true, spring };
  } finally {
    try {
      await actor.query('DROP TABLE IF EXISTS ' + table);
      for (const id of operations) await actor.execute('DELETE FROM ' + tick + JOURNAL + tick + ' WHERE operation_id=?', [id]);
    } finally { await actor.end(); }
  }
}

async function runTriggerDeploymentChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const author = api.dbAuthoring;
  checks.triggerDeployment = await verifyTriggerDeployment(runtime, {
    connect: config => api.connectMysql(config),
    list: async () => (await api.listSchemaObjects()).objects,
    open: name => author.openObject({ kind: 'trigger', name }),
    async review(model, source) {
      const uri = vscode.Uri.parse(model.uri), document = await vscode.workspace.openTextDocument(uri), edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      return author.reviewObject(model.modelId);
    },
    apply: (model, _review, approved) => author.deployObject(model.modelId, approved),
    recover: (operationId, approved) => author.recoverObject(operationId, approved),
    async assertReviewDocument(model, expected) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-object-review:/' + model.modelId + '/review.sql'));
      assert.equal(doc.getText().replaceAll('\r\n','\n'), expected.sql);
    },
    async probe() {
      const response = await fetch(runtime.baseUrl + '/probe/testing-state', {signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok);
      return response.json();
    }
  });
}

module.exports = { runTriggerDeploymentChecks, verifyTriggerDeployment };
