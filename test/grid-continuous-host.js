'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const pageSize = 2;
const sort = [{ column: 'priority', direction: 'asc' }, { column: 'bits', direction: 'desc' }];
const columns = ['id', 'priority', 'bits', '__rb_grid_seek_0'];

async function verifyContinuousGrid(runtime, adapter) {
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const name = '`rb_choices_' + randomBytes(5).toString('hex') + '`';
  const table = name.slice(1, -1), members = Array.from({ length: 64 }, (_, index) => 'm' + index);
  const readSpring = async () => {
    const endpoint = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  try {
    await actor.query('CREATE TABLE ' + name + " (id BIGINT UNSIGNED PRIMARY KEY, priority ENUM('zeta','','alpha','10') NULL, bits SET(" +
      members.map(member => "'" + member + "'").join(',') + ") NULL, `__rb_grid_seek_0` VARCHAR(30)) ENGINE=InnoDB");
    const start = 9007199254740993n;
    const rows = Array.from({ length: 21 }, (_, index) => [String(start + BigInt(index)),
      [null, 'zeta', '', 'alpha', '10'][index % 5], [null, '', 'm63', 'm0,m63', 'm0,m1', members.join(',')][index % 6], 'label-' + index]);
    // The engine's invalid ENUM record and a declared empty-string member display the same text with different ordinals.
    rows[4][1] = 'invalid choice';
    await actor.query('INSERT IGNORE INTO ' + name + ' VALUES ?', [rows]);
    const projection = 'SELECT CAST(id AS CHAR) AS id,priority,bits,`__rb_grid_seek_0` AS label FROM ' + name;
    const [nativeRows] = await actor.query(projection + ' ORDER BY priority ASC,bits DESC,id ASC');
    const expected = nativeRows.map(({ id, priority, bits, label }) => [id, priority, bits, label]);
    const [[engineValues]] = await actor.query('SELECT CAST(MAX(CAST(bits AS UNSIGNED)) AS CHAR) maxMask,' +
      "SUM(priority = '' AND CAST(priority AS UNSIGNED) = 0) emptySentinel,SUM(priority = '' AND CAST(priority AS UNSIGNED) = 2) declaredEmpty FROM " + name);
    assert.equal(engineValues.maxMask, '18446744073709551615');
    assert.ok(Number(engineValues.emptySentinel) > 0 && Number(engineValues.declaredEmpty) > 0);
    await readSpring();
    await adapter.connect(config);
    const id = await adapter.open(table, { pageSize, sort });
    const record = () => adapter.record(id);
    const current = () => {
      const entry = record();
      assert.ok(!entry.editError, entry.editError);
      return entry.result;
    };
    const action = async (type, values = {}) => {
      await adapter.action(id, { type, modelId: record().result.edit.modelId, ...values });
      return current();
    };
    function verifyWindow(result) {
      const { firstPage, lastPage } = result.browse.window;
      assert.deepEqual(result.rows, expected.slice(firstPage * pageSize, (lastPage + 1) * pageSize));
      assert.equal(new Set(result.edit.rowIds).size, result.rows.length);
      assert.ok(result.rows.length <= 8);
      assert.deepEqual(result.columns, columns);
      assert.deepEqual(result.fields?.map(field => field.name), columns);
      assert.equal(result.state.readOnly, true);
      assert.equal(result.edit.canEdit, false);
    }
    const first = current(), connection = first.state.connectionId;
    assert.deepEqual(first.rows, expected.slice(0, pageSize));
    assert.equal(first.browse.keyset, true);
    verifyWindow(await action('setContinuousScroll', { enabled: true }));
    const before = await action('scrollTable', { direction: 'next' });
    await actor.execute('UPDATE ' + name + " SET priority='alpha',bits=NULL WHERE id=CAST(? AS UNSIGNED)", [expected[3][0]]);
    await actor.execute('DELETE FROM ' + name + ' WHERE id=CAST(? AS UNSIGNED)', [expected[6][0]]);
    await actor.execute('INSERT INTO ' + name + ' VALUES (?,?,?,?)', ['18014398509481985', null, null, 'outside snapshot']);
    await adapter.action(id, { type: 'scrollTable', direction: 'next', modelId: first.edit.modelId });
    assert.match(record().editError, /window changed/u);
    assert.deepEqual(record().result.rows, before.rows);
    let result = await action('scrollTable', { direction: 'next' });
    const forward = new Set();
    while (true) {
      verifyWindow(result);
      assert.equal(result.state.connectionId, connection);
      result.rows.forEach(row => forward.add(row[0]));
      if (!result.browse.hasNext) break;
      result = await action('scrollTable', { direction: 'next' });
    }
    assert.equal(forward.size, expected.length);
    assert.ok(result.browse.window.firstPage > 0);
    while (result.browse.hasPrevious) {
      result = await action('scrollTable', { direction: 'previous' });
      verifyWindow(result);
      assert.equal(result.state.connectionId, connection);
    }
    assert.equal(result.browse.window.firstPage, 0);
    const ordinary = await action('setContinuousScroll', { enabled: false });
    assert.deepEqual(ordinary.rows, expected.slice(0, pageSize));
    assert.equal(ordinary.browse.window, undefined);
    const later = await action('browseTable', { query: { page: 1, pageSize, sort, filters: [] } });
    assert.deepEqual(later.rows, expected.slice(pageSize, pageSize * 2));
    if (adapter.activate) await adapter.activate(id);
    await adapter.disconnect();
    await adapter.connect(config);
    const reopened = await adapter.open(table, { pageSize: 100, sort });
    const newRows = adapter.record(reopened).result.rows;
    assert.ok(newRows.some(row => row[0] === '18014398509481985'));
    assert.ok(!newRows.some(row => row[0] === expected[6][0]));
    await readSpring();
    return { engine: runtime.dbEngine, version, exactEnumOrdinals: true, setMask64Bit: true, exactBigintPrimaryKey: true,
      nullAndEmptyLabels: true, rows: expected.length, boundedForwardAndBackwardWindow: true,
      privateCursorColumnsExcluded: true, concurrentWritesExcludedUntilReopen: true, staleWindowRefused: true,
      nativeResultActivated: Boolean(adapter.activate), springIsolation: expectedSpring };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + name); }
      finally { await actor.end(); }
    }
  }
}

async function runContinuousGridChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.openTableSnapshot'));
  const result = await verifyContinuousGrid(runtime, {
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    open: (table, options) => api.openTableSnapshot(table, options), record: id => api.results().find(item => item.id === id),
    action: (id, message) => api.tableAction(id, message), activate: id => api.activateResult(id)
  });
  checks.push('Loaded bounded forward and backward read-only grid windows with native ENUM and exact unsigned SET and primary-key positions.');
  checks.push('Retained one snapshot across concurrent writers, refused stale result messages, and verified Spring JDBC isolation.');
  return result;
}

module.exports = { verifyContinuousGrid, runContinuousGridChecks };
