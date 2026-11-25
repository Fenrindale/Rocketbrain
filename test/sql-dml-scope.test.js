'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectDmlScope } = require('../src/db/sql-dml-scope');

test('DML scope distinguishes outer WHERE from comments, nested queries and quoted text', () => {
  const input = "/* WHERE other = 1 */ UPDATE tab SET note = 'WHERE col=1', total = (SELECT SUM(t) FROM tmp WHERE id=1) LIMIT 10;";
  const scope = inspectDmlScope(input);
  assert.deepEqual(scope, { command:'UPDATE', start:22, end:28, hasWhere:false, hasLimit:true });
  assert.equal(inspectDmlScope('DELETE t FROM tab t JOIN other o ON t.id=o.id').hasWhere, false);
  assert.equal(inspectDmlScope('DELETE FROM tab WHERE id IN (SELECT id FROM tmp)').hasWhere, true);
  assert.equal(inspectDmlScope('UPDATE tab SET `WHERE` = "WHERE"').hasWhere, false);
  assert.equal(inspectDmlScope('UPDATE tab SET note = :where').hasWhere, false);
});

test('DML scope finds the statement after common table expressions without treating locking SELECT as UPDATE', () => {
  assert.equal(inspectDmlScope('WITH RECURSIVE t(n) AS (SELECT 1 WHERE TRUE) UPDATE data SET a=5').hasWhere, false);
  assert.equal(inspectDmlScope('WITH t AS (SELECT 1) DELETE FROM data WHERE id=(SELECT 1 FROM t)').command, 'DELETE');
  assert.equal(inspectDmlScope('WITH t AS (SELECT 1) SELECT * FROM data FOR UPDATE'), undefined);
  assert.equal(inspectDmlScope('EXPLAIN UPDATE data SET a=5'), undefined);
  assert.throws(() => inspectDmlScope('UPDATE data SET a=5; SELECT 1'), /one statement/);
});
