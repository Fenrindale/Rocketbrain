'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeWriteProtection, requireConnectionMode, requireStatementScope, tableProtection } = require('../src/db/write-protection');

const q = String.fromCharCode(96);
const table = q + 'Audit Log' + q;
const qualified = q + 'app' + q + '.' + table;
const policy = normalizeWriteProtection({ tables: [{ schema: 'app', name: 'Audit Log' }] });
const writable = { mayWrite: true, userSql: true, readOnly: false };

test('write protection is opt-in and uses normalized schema and table pairs', () => {
  assert.equal(normalizeWriteProtection(undefined), undefined);
  assert.equal(normalizeWriteProtection({ connectionReadOnly: false, tables: [] }), undefined);
  assert.throws(() => normalizeWriteProtection({ tables: [{ schema: 'app', name: 'x' }, { schema: 'APP', name: 'X' }] }), /only once/);
  assert.throws(() => normalizeWriteProtection({ tables: [{ schema: 'app', name: 'x', extra: true }] }), /exact schema and table/);
  assert.match(tableProtection(policy, 'APP', 'audit log'), /protects this table/);
  assert.equal(tableProtection(policy, 'another', 'Audit Log'), '');
  const locked = normalizeWriteProtection({ connectionReadOnly: true });
  assert.throws(() => requireConnectionMode(locked, false), /locked to read-only/);
  assert.doesNotThrow(() => requireConnectionMode(locked, true));
});

test('protected DML includes quoted, unqualified and qualified targets while ambiguous writes fail closed', () => {
  for (const sql of ['UPDATE ' + table + ' SET id = 2 WHERE id = 1',
    'DELETE QUICK FROM ' + qualified + ' WHERE id = 1',
    'INSERT IGNORE INTO app.' + table + ' (id) VALUES (1)', 'REPLACE INTO ' + qualified + ' VALUES (1)']) {
    assert.throws(() => requireStatementScope(policy, sql, 'app', writable), /protects this table/);
  }
  assert.equal(requireStatementScope(policy, 'UPDATE other.' + table + ' SET id = 2 WHERE id = 1', 'app', writable).schema, 'other');
  assert.equal(requireStatementScope(policy, 'INSERT INTO ledger (id) VALUES (?)', 'app', writable).name, 'ledger');
  for (const sql of ['UPDATE ledger l JOIN ' + table + ' a SET a.id = 2 WHERE l.id = 1',
    'DELETE a FROM ledger l JOIN ' + table + ' a WHERE l.id = a.id',
    'WITH a AS (SELECT id FROM ledger) UPDATE ledger SET id = 2 WHERE id = 1',
    'ALTER TABLE ' + table + ' RENAME TO bad', 'CALL write_audit()', 'CREATE TABLE temp AS SELECT 1']) {
    assert.throws(() => requireStatementScope(policy, sql, 'app', writable), /Identify one base table/);
    assert.equal(requireStatementScope(undefined, sql, 'app', writable), undefined);
  }
});

test('protected writable SQL rejects unverified functions but leaves read-only sessions and ordinary reads available', () => {
  const reads = { mayWrite: false, userSql: true, readOnly: false };
  assert.equal(requireStatementScope(policy, 'SELECT 1, VERSION()', 'app', reads), undefined);
  assert.throws(() => requireStatementScope(policy, 'SELECT COUNT(*) FROM ledger', 'app', reads), /read-only console/);
  assert.equal(requireStatementScope(policy, 'SELECT COUNT(*) FROM ledger', 'app', { ...reads, readOnly: true }), undefined);
  assert.throws(() => requireStatementScope(policy, 'SELECT app.write_audit()', 'app', reads), /unverified SQL functions/);
  assert.throws(() => requireStatementScope(policy, 'UPDATE ledger SET id = write_audit() WHERE id = 1', 'app', writable), /unverified SQL functions/);
  assert.throws(() => requireStatementScope(policy, 'INSERT INTO ledger SELECT id FROM reported_audit', 'app', writable), /Identify one base table/);
  assert.equal(requireStatementScope(policy, 'SELECT app.write_audit()', 'app', { ...reads, readOnly: true }), undefined);
  const locked = normalizeWriteProtection({ connectionReadOnly: true });
  assert.equal(requireStatementScope(locked, 'WITH t AS (SELECT 1 AS v) SELECT * FROM t', 'app', { ...reads, mayWrite: true, readOnly: true }), undefined);
});
