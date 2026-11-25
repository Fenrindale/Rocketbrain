'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { JOURNAL } = require('../src/db/object-editor');

const configPath = process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG || process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG;
const quoted = name => String.fromCharCode(96) + name + String.fromCharCode(96);

test('LIVE TRIGGER EDITOR recovers an exact original after interruption following DROP', { skip: !configPath, timeout: 90000 }, async () => {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const folder = path.dirname(await fs.realpath(configPath));
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(owner.id, path.basename(folder));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const actor = await mysql.createConnection(config), suffix = randomBytes(5).toString('hex');
  const table = 'rb_fault_subject_' + suffix, name = 'rb_fault_trigger_' + suffix;
  const original = 'SET NEW.score = NEW.score + 1', approved = { allowImplicitCommit: true, allowTriggerReplacement: true };
  let db, operationId;
  try {
    const [[{ datadir }]] = await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(), folder.toLowerCase());
    await actor.query('CREATE TABLE ' + table + '(id INT PRIMARY KEY, score INT NOT NULL) ENGINE=InnoDB');
    await actor.query('CREATE TRIGGER ' + name + ' BEFORE INSERT ON ' + table + ' FOR EACH ROW ' + original);
    db = new MysqlService(config);
    const model = await db.inspectSchemaObject({ kind: 'trigger', name });
    const review = await db.previewSchemaObject({ modelId: model.modelId, source: 'SET NEW.score = NEW.score + 2' });
    operationId = review.operationId;
    const stream = db._stream.bind(db), drop = 'DROP TRIGGER ' + quoted(config.database) + '.' + quoted(name);
    let interrupted = false;
    db._stream = async (session, statement, ...options) => {
      const result = await stream(session, statement, ...options);
      if (statement === drop) {
        interrupted = true;
        db._lose(session, Object.assign(Error('Owned fixture interrupted after trigger drop'), { code: 'RB_FIXTURE_INTERRUPT' }));
      }
      return result;
    };
    const stopped = await db.applySchemaObject({ reviewId: review.reviewId, ...approved });
    assert.equal(interrupted, true);
    assert.equal(stopped.state, 'needs-inspection');
    assert.equal(stopped.autoRetried, false);
    assert.deepEqual((await actor.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [name]))[0], []);
    await db.dispose();
    db = new MysqlService(config);
    assert.ok((await db.listSchemaObjectRecoveries()).some(value => value.operationId === operationId && value.state === 'drop-pending'));
    assert.equal((await db.recoverSchemaObject({ operationId, ...approved })).state, 'recovered');
    const [[observed]] = await actor.execute('SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [name]);
    assert.equal(observed.ACTION_STATEMENT, original);
    await actor.query('INSERT INTO ' + table + ' VALUES(1,2)');
    assert.equal((await actor.query('SELECT score FROM ' + table))[0][0].score, 3);
  } finally {
    try {
      await db?.dispose();
      await actor.query('DROP TABLE IF EXISTS ' + table);
      if (operationId) await actor.execute('DELETE FROM ' + quoted(JOURNAL) + ' WHERE operation_id=?', [operationId]);
    } finally { await actor.end(); }
  }
});
