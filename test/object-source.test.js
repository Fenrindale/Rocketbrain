'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { contextOf, listNames, loadSource } = require('../src/db/object-source');

const metadata = version => contextOf(async sql => {
  assert.equal(sql, 'SELECT VERSION(), DATABASE()');
  return { rows: [[version, 'current_db']] };
});

test('object source lists account-visible kinds and paginates a literal name prefix', async () => {
  const mysql = await metadata('8.4.13'), maria = await metadata('5.5.5-11.4.8-MariaDB');
  assert.deepEqual(mysql.kinds.map(row => row.kind), ['schema', 'table', 'view', 'procedure', 'function', 'trigger', 'event']);
  assert.deepEqual(maria.kinds.map(row => row.kind).slice(-3), ['sequence', 'package', 'package-body']);
  assert.deepEqual((await metadata('10.2.10-MariaDB')).kinds, mysql.kinds);
  const page = await listNames(async (sql, values) => {
    assert.match(sql, /information_schema\.TABLES .*TABLE_TYPE = 'VIEW'.*LIMIT 101$/);
    assert.match(sql, /ORDER BY CAST\(TABLE_NAME AS BINARY\)/);
    assert.deepEqual(values, ['other_db', 'audit=_=%==%', 'audit_resume']);
    return { rows: Array.from({ length: 101 }, (_, index) => ['other_db', 'audit_' + String(index).padStart(3, '0')]) };
  }, mysql, { schema: 'other_db', kind: 'view', prefix: 'audit_%=', after: 'audit_resume' });
  assert.equal(page.items.length, 100);
  assert.deepEqual(page.items[0], { schema: 'other_db', name: 'audit_000', kind: 'view' });
  assert.equal(page.next, 'audit_099');
  await assert.rejects(listNames(assert.fail, mysql, { kind: 'package', schema: 'current_db' }), /supported by/);
  await assert.rejects(listNames(assert.fail, mysql, { kind: 'view', schema: 'current_db', prefix: 'a\n' }), /prefix/);
});

test('object source returns the exact SHOW CREATE text and observed creation settings', async () => {
  const context = await metadata('8.4.13'), calls = [];
  const object = { schema: 'a`db', name: 'r`tag', kind: 'trigger' };
  const source = "CREATE DEFINER=`owner`@`localhost` TRIGGER `r``tag` BEFORE INSERT ON t FOR EACH ROW\nBEGIN\n SET NEW.c='same text';\nEND";
  const result = await loadSource(async (sql, args) => {
    calls.push(sql);
    if (calls.length === 1) {
      assert.match(sql, /information_schema\.TRIGGERS .*CAST\(TRIGGER_SCHEMA AS BINARY\).*CAST\(TRIGGER_NAME AS BINARY\)/);
      assert.deepEqual(args, ['a`db', 'r`tag']);
      return { rows: [['r`tag']] };
    }
    assert.equal(sql, 'SHOW CREATE TRIGGER `a``db`.`r``tag`');
    return { columns: ['Trigger', 'sql_mode', 'SQL Original Statement', 'character_set_client', 'Database Collation'],
      rows: [['r`tag', '', source, 'utf8mb4', 'utf8mb4_0900_ai_ci']] };
  }, context, object);
  assert.deepEqual(result, { scope: 'account-visible', object, dialect: 'mysql', version: '8.4.13', source,
    settings: { sql_mode: '', character_set_client: 'utf8mb4', 'database collation': 'utf8mb4_0900_ai_ci' }, rowDataIncluded: false });
  assert.equal(calls.length, 2);
});

test('object source distinguishes missing and withheld definitions and does not return incomplete DDL', async () => {
  const context = await metadata('11.4.8-MariaDB'), object = { schema: 'current_db', name: 'visible_name', kind: 'procedure' };
  const observe = load => (sql, args) => {
    if (args) return { rows: [[object.name]] };
    return load();
  };
  const createProcedure = (source, name = object.name) => ({ columns: ['Procedure', 'Create Procedure'], rows: [[name, source]] });
  const unavailable = { code: 'ROCKETBRAIN_OBJECT_SOURCE_UNAVAILABLE' };
  await assert.rejects(loadSource(async () => ({ rows: [] }), context, object), unavailable);
  await assert.rejects(loadSource(observe(() => createProcedure('CREATE PROCEDURE different()', 'different')), context, object), unavailable);
  await assert.rejects(loadSource(observe(() => createProcedure(null)), context, object), { code: 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION' });
  await assert.rejects(loadSource(observe(() => { throw Object.assign(Error('private error'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }); }),
    context, object), error => error.code === 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION' && !error.message.includes('private'));
  await assert.rejects(loadSource(observe(() => createProcedure('INSERT INTO u VALUES (1)')), context, object), { code: 'ROCKETBRAIN_OBJECT_SOURCE_DEFINITION' });
  await assert.rejects(loadSource(observe(() => createProcedure('CREATE PROCEDURE ' + 'a'.repeat(1024 * 1024))), context, object),
    { code: 'ROCKETBRAIN_OBJECT_SOURCE_SIZE' });
});
