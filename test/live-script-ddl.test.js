'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { analyzeLiveDdlScript } = require('../src/db/ddl-model');
const { indexHintCompletions } = require('../src/db/ddl-script-indexes');
const { verifyActualLiveScriptDdl } = require('./live-script-ddl-host');

const seed = { database: 'app', dialect: 'mysql', serverVersion: '8.4.13', semanticContextObserved: true,
  sqlMode: [], coverage: { tables: 'loaded', columns: 'loaded', indexes: 'loaded' }, tables: [], views: [] };

test('ordinary script catalog isolates each statement, preserves offsets and withholds stale picks after drops', () => {
  const before = structuredClone(seed);
  const source = 'CREATE TABLE t (id INT PRIMARY KEY, code VARCHAR(16), KEY first_key (code)) ENGINE=InnoDB;\n' +
    'ALTER TABLE t ADD amount DECIMAL(24,8), ADD INDEX ix_amount (amount);\n' +
    'ALTER TABLE t RENAME COLUMN amount TO cost, RENAME INDEX ix_amount TO ix_cost;\n' +
    'SELECT p.cost FROM t AS p USE INDEX (ix_cost);\n' +
    'DROP INDEX ix_cost ON t; SELECT id FROM t FORCE INDEX (ix_);';
  const result = analyzeLiveDdlScript(source, seed);
  assert.deepEqual(seed, before);
  assert.equal(result.contextMayChange, true);
  assert.equal(result.statements[3].model.state, 'known');
  assert.equal(result.statements[3].model.projections[0].type.dbType, 'DECIMAL(24,8)');
  const indexes = part => indexHintCompletions(part.model.text, part.model.text.indexOf('(ix_') + '(ix_'.length, part.scriptCatalog);
  assert.deepEqual(indexes(result.statements[3]).map(item => item.label), ['ix_cost']);
  assert.deepEqual(indexes(result.statements[5]), []);
  const column = result.statements[3].model.references.find(item => item.kind === 'column' && item.name === 'cost');
  assert.equal(source.slice(column.start + result.statements[3].start, column.end + result.statements[3].start), 'cost');
  assert.equal(analyzeLiveDdlScript(source, { ...seed, sqlMode: ['ORACLE'] }), null);
  assert.equal(analyzeLiveDdlScript(source, { ...seed, semanticContextObserved: false }), null);
  assert.equal(analyzeLiveDdlScript("SELECT '/*! just a string */'; SELECT 'ALTER TABLE t';", seed), null);
});

test('unsupported index forms, same-clause reuse and context changes preserve earlier frames and stop later binding', () => {
  const prefix = 'CREATE TABLE t (id INT PRIMARY KEY, code VARCHAR(16)) ENGINE=InnoDB; SELECT q.code FROM t q; ';
  for (const rejected of ['CREATE INDEX bad ON t (code(2));', 'CREATE INDEX bad ON t ((UPPER(code)));',
    'ALTER TABLE t ADD INDEX ix_one (code), RENAME INDEX ix_one TO ix_two;', 'SET SESSION sql_mode="ANSI_QUOTES";',
    'ALTER TABLE other.t ADD extra INT;', 'CALL user_routine();']) {
    const result = analyzeLiveDdlScript(prefix + rejected + ' SELECT q.code FROM t q;', seed);
    assert.equal(result.statements[1].model.state, 'known', rejected);
    assert.equal(result.statements.at(-1).contextUncertain, true, rejected);
    assert.equal(result.statements.at(-1).model.projections[0].type.family, 'unknown', rejected);
    assert.ok(result.unknown.length, rejected);
  }
});

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('automatic script shadow matches separately executed DDL and exact row results on an owned Spring database',
  { skip: !fixture && 'Run the owned Spring/MySQL or MariaDB fixture.', timeout: 90000 }, async () => {
    console.log(JSON.stringify(await verifyActualLiveScriptDdl(JSON.parse(await fs.readFile(fixture, 'utf8')))));
  });
