'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { initializationStatements, sessionLifecycle } = require('../src/db/session-lifecycle');

test('connection lifecycle normalizes only reviewed session statements and intervals', () => {
  assert.deepEqual(sessionLifecycle({ initialSql: "set session time_zone='+09:00';\r\n SET SESSION sql_safe_updates = 1;", keepAliveSeconds: 15, idleSeconds: 240 }), {
    initialSql: "SET SESSION time_zone = '+09:00';\nSET SESSION sql_safe_updates = 1", keepAliveSeconds: 15, idleSeconds: 240
  });
  assert.equal(sessionLifecycle({ initialSql: ' ' }), undefined);
  assert.deepEqual(initializationStatements("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'"),
    ["SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'"]);
  for (const settings of [{ idleSeconds: 1 }, { keepAliveSeconds: '1' }, { keepAliveSeconds: 3601 }, { reconnect: true }]) {
    assert.throws(() => sessionLifecycle(settings), { code: 'ROCKETBRAIN_SESSION_LIFECYCLE' });
  }
});

test('connection initialization refuses SQL with side effects and SQL modes that change lexing', () => {
  for (const sql of ["SET SESSION sql_mode='ANSI_QUOTES'", "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'", 'SET SESSION autocommit=0',
    'SET GLOBAL sql_safe_updates=0', 'SELECT 1', 'SET SESSION sql_safe_updates=3', 'SET SESSION group_concat_max_len=2',
    "SET SESSION time_zone='+00:00'; DROP TABLE data", 'SET SESSION sql_safe_updates=1; SET SESSION sql_safe_updates=0']) {
    assert.throws(() => initializationStatements(sql), { code: 'ROCKETBRAIN_SESSION_LIFECYCLE' });
  }
});
