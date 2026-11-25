'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { attachCheckMetadata } = require('../src/db/metadata');
const { runCatalogOperation, selectedNames } = require('../src/db/catalog-refresh');
const { stableCreate } = require('../src/db/schema-rename');

test('only a top-level, volatile AUTO_INCREMENT option is excluded from refresh signatures', () => {
  const base = "CREATE TABLE `p` (id INT AUTO_INCREMENT) ENGINE=InnoDB COMMENT='AUTO_INCREMENT=<counter>'";
  const next = base.replace(' COMMENT', ' AUTO_INCREMENT=815 COMMENT');
  assert.equal(stableCreate(next, { omitCounter: true }), base);
  assert.match(stableCreate(next), /ENGINE=InnoDB AUTO_INCREMENT=<counter> COMMENT/);
  assert.notEqual(stableCreate(next.replace('COMMENT=', 'COMMENT="different" #'), { omitCounter: true }), base);
});

test('check metadata branches by dialect and keeps the exact table association', async () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const catalog = { database: 'app', dialect, tables: [{ name: 'p' }, { name: 'P' }],
      views: [], coverage: {}, warnings: [], complete: true };
    await attachCheckMetadata(async (sql, parameters) => {
      assert.deepEqual(parameters, ['app', 'p']);
      assert.match(sql, dialect === 'mariadb' ? /WHERE CAST\(CONSTRAINT_SCHEMA AS BINARY\)/ : /tc.ENFORCED/);
      return { rows: [['p', 'bounded', 'id > 0', dialect === 'mysql' ? 'YES' : null]] };
    }, catalog, 'p');
    assert.deepEqual(catalog.tables[0].checks, [{ name: 'bounded', expression: 'id > 0', enforced: dialect === 'mysql' ? true : null }]);
    assert.deepEqual(catalog.tables[1].checks, []);
    assert.equal(catalog.coverage.checks, 'loaded');
  }
});

test('a refresh holds the catalog slot, rejects stale source identity and releases after failure', async () => {
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const state = { db: {}, epoch: 4, mysql: true, metadata: {}, running: new Set() };
  const options = { needsMysql: true, trusted: () => true, busy: () => false, assertReady: () => {}, updateStatus: () => {} };
  const first = runCatalogOperation(state, async ({ assertCurrent }) => {
    await paused;
    assertCurrent();
  }, options);
  await assert.rejects(runCatalogOperation(state, () => assert.fail('unexpected work'), options), /Another metadata refresh/);
  state.metadata = {};
  resume();
  await assert.rejects(first, /live catalog changed/);
  assert.equal(state.running.size, 0);
  assert.deepEqual(selectedNames(['T', 't']), ['T', 't']);
  assert.throws(() => selectedNames(['T', 'T']), /different/);
});
