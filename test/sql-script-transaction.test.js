'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeScript, bindScript, publicScript } = require('../src/db/sql-script');
const { transactionSql } = require('../src/db/sql-script-transaction');

const read = { sqlMode: [], readOnly: true, allowTransactions: true };
const write = { ...read, readOnly: false };

test('reviewed transaction model retains named parameters and normalizes control forms', () => {
  const sql = 'BEGIN WORK; SAVEPOINT `MyPoint`; SELECT :n; ROLLBACK WORK TO SAVEPOINT MYPOINT; RELEASE SAVEPOINT mypoint; COMMIT WORK;';
  const parsed = analyzeScript(sql, read);
  assert.deepEqual(parsed.transactionBlock, { mode: 'read-only', finish: 'commit', requiresCommitApproval: false });
  assert.deepEqual(parsed.statements.map(item => item.transaction?.kind), ['begin', 'savepoint', undefined, 'rollback-to', 'release', 'commit']);
  const bound = bindScript(parsed, { n: { kind: 'integer', value: '9007199254740993' } });
  assert.deepEqual(bound.statements[2].values, ['9007199254740993']);
  assert.deepEqual(publicScript(bound).transactionBlock, parsed.transactionBlock);
  assert.equal(transactionSql(parsed.statements[0].transaction, parsed.transactionBlock), 'START TRANSACTION READ ONLY');
  assert.equal(transactionSql(parsed.statements[3].transaction, parsed.transactionBlock), 'ROLLBACK TO SAVEPOINT `mypoint`');
  assert.equal(transactionSql(parsed.statements[5].transaction, parsed.transactionBlock), 'COMMIT AND NO CHAIN NO RELEASE');
});

test('transaction controls require a balanced opt-in block and active simple savepoints', () => {
  for (const sql of [
    'COMMIT;', 'BEGIN; SELECT 1;', 'BEGIN; SELECT 1; COMMIT; SELECT 2;',
    'BEGIN; START TRANSACTION; COMMIT;', 'BEGIN; SAVEPOINT x; SAVEPOINT X; COMMIT;',
    'BEGIN; SAVEPOINT x; SAVEPOINT y; ROLLBACK TO x; RELEASE SAVEPOINT y; COMMIT;',
    'BEGIN; SAVEPOINT `点`; COMMIT;', 'BEGIN; SELECT 1; COMMIT AND CHAIN;',
    'BEGIN; ALTER TABLE a ADD x INT; COMMIT;', 'BEGIN; CALL p(); COMMIT;'
  ]) assert.throws(() => analyzeScript(sql, { ...write, allowCalls: true }), { code: 'ROCKETBRAIN_SCRIPT_TRANSACTION' }, sql);
  assert.throws(() => analyzeScript('BEGIN; SELECT 1; ROLLBACK;', { ...write, allowTransactions: false }), /controls/);
  assert.throws(() => analyzeScript('START TRANSACTION READ WRITE; SELECT 1; COMMIT;', read), /read\/write console/);
  assert.throws(() => analyzeScript('START TRANSACTION READ ONLY; INSERT INTO a VALUES(1); COMMIT;', write), /cannot contain a write/);
});

test('transaction commit approval follows actual reviewed writes and final control', () => {
  const body = 'START TRANSACTION READ WRITE; INSERT INTO a VALUES(1); ';
  assert.equal(analyzeScript(body + 'COMMIT;', write).transactionBlock.requiresCommitApproval, true);
  assert.equal(analyzeScript(body + 'ROLLBACK;', write).transactionBlock.requiresCommitApproval, false);
});
