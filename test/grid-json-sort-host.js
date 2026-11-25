'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const springBaseline = { people: 2, departments: 1, rolledBackNames: 0 };
const values = [
  -9223372036854775808n, 18446744073709551615n, 9007199254740992n, 9007199254740993n,
  18446744073709551615n, 9007199254740993n, 0n, -2n, true, false, true, false,
  'A', 'a', 'a ', '', '강', '🐙', 'slash\\literal', 'x'.repeat(256), 'y'.repeat(257),
  null, undefined, 2.25, '9007199254740993', 'object array auto-wrap', 'scalar array auto-wrap', 9007199254740993n
];
const idBase = 9007199254740993n;
const labels = ['A', 'a', 'b', 'B', null, 'a'];

function testRows() {
  const rows = values.map((value, index) => {
    const raw = typeof value === 'bigint' ? String(value) : JSON.stringify(value);
    const nested = value === undefined ? '{"nested":[{}]}' : '{"nested":[{"item":' + raw + '}]}';
    const json = index === 25 ? '{"nested":{"item":"object array auto-wrap"}}' :
      index === 26 ? '{"nested":"scalar array auto-wrap"}' : nested;
    return { id: String(idBase + BigInt(index)), value: index === 25 || index === 26 ? undefined : value, json, label: index === 27 ? 'b' : labels[index % labels.length] };
  });
  rows.push({ id: String(idBase + BigInt(rows.length)), value: undefined, json: null, label: null });
  return rows;
}

const cmp = (a, b) => a > b ? 1 : a < b ? -1 : 0;
const rowIds = result => result.rows.map(row => String(row[0]));
const idCmp = (a, b) => cmp(BigInt(a.id), BigInt(b.id));
function orderRows(rows, kind, direction, nulls, byLabel) {
  const observed = row => {
    if (kind === 'integer') return typeof row.value === 'bigint' ? row.value : null;
    if (kind === 'boolean') return typeof row.value === 'boolean' ? Number(row.value) : null;
    return typeof row.value === 'string' && Buffer.byteLength(row.value) <= 256 ? Buffer.from(row.value) : null;
  };
  function compare(left, right, dir, missing, compareScalar) {
    if (left === null || right === null) {
      return left === right ? 0 : left === null ? missing === 'first' ? -1 : 1 : missing === 'first' ? 1 : -1;
    }
    return compareScalar(left, right) * (dir === 'asc' ? 1 : -1);
  }
  return rows.slice().sort((a, b) =>
    compare(observed(a), observed(b), direction, nulls, kind === 'text' ? Buffer.compare : cmp) ||
    (byLabel ? compare(a.label?.toLowerCase() ?? null, b.label?.toLowerCase() ?? null, 'desc', 'first', cmp) : 0) ||
    idCmp(a, b)).map(row => row.id);
}

async function verifyGridJsonSort(runtime, adapter) {
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const table = 'rb_json_order_' + randomBytes(5).toString('hex');
  const rows = testRows(), pageSize = 3, columns = ['id', 'payload', 'label', '__rb_grid_seek_0'];
  const base = { pageSize, filters: [] };
  async function spring() {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springBaseline);
  }
  const details = [
    { kind: 'integer', direction: 'asc', nulls: 'last', byLabel: true },
    { kind: 'boolean', direction: 'desc', nulls: 'first', byLabel: false },
    { kind: 'text', direction: 'asc', nulls: 'first', byLabel: false }
  ];
  try {
    await actor.query('CREATE TABLE ' + table + " (id BIGINT UNSIGNED PRIMARY KEY, payload JSON, label VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, __rb_grid_seek_0 VARCHAR(25)) ENGINE=InnoDB");
    for (const [index, row] of rows.entries()) {
      await actor.execute('INSERT INTO ' + table + ' VALUES (?,?,?,?)', [row.id, row.json, row.label, 'visible-'+index]);
    }
    await spring();
    await adapter.connect(config, table);
    const proofs = [];
    for (const { kind, direction, nulls, byLabel } of details) {
      const sort = [{ column: 'payload', direction, nulls, jsonPath: '$.nested[0].item', jsonType: kind },
        ...(byLabel ? [{ column: 'label', direction: 'desc', nulls: 'first', collation: 'utf8mb4_general_ci' }] : [])];
      const options = { ...base, sort }, expected = orderRows(rows, kind, direction, nulls, byLabel);
      const opened = await adapter.open(table, options);
      try {
        assert.ok(opened.result.browse.keyset);
        assert.ok(opened.result.browse.sortOptions.snapshot);
        assert.ok(opened.result.browse.sortOptions.columns.some(column => column.name === 'payload' && column.jsonScalar));
        assert.ok(opened.result.browse.sortOptions.collations.utf8mb4.includes('utf8mb4_general_ci'));
        assert.deepEqual(opened.result.browse.sort, sort);
        const actual = [];
        let result = opened.result, page = 0;
        for (;;) {
          assert.deepEqual(result.columns, columns);
          assert.deepEqual(result.fields?.map(field => field.name), columns);
          assert.doesNotMatch(result.browse.sql, /\bOFFSET\b/u);
          assert.ok(result.rows.every(row => row.length === columns.length && /^visible-/u.test(row.at(-1))));
          actual.push(...rowIds(result));
          if (!result.browse.hasNext) break;
          result = await adapter.page(opened.id, { ...options, page: ++page });
        }
        assert.deepEqual(actual, expected, kind + ' forward');
        assert.equal(new Set(actual).size, rows.length);
        for (let reverse = page - 1; reverse >= 0; reverse--) {
          result = await adapter.page(opened.id, { ...options, page: reverse });
          assert.deepEqual(rowIds(result), expected.slice(reverse * pageSize, (reverse + 1) * pageSize), kind + ' backward');
        }
        const offset = await adapter.offset(table, { ...options, page: 2 });
        assert.deepEqual(rowIds(offset), expected.slice(2 * pageSize, 3 * pageSize), kind + ' ordinary offset');
        if (adapter.scroll && kind === 'integer') {
          const window = await adapter.scroll(opened.id, result.edit.modelId, options);
          assert.deepEqual(rowIds(window), expected.slice(0, pageSize * 2));
          assert.deepEqual(window.columns, columns);
        }
        proofs.push({ kind, rows: actual.length, pages: page + 1, mixedCollation: byLabel });
      } finally { await adapter.close?.(opened.id); }
    }
    await spring();
    return { engine: runtime.dbEngine, version, scalarSorts: proofs, nestedArrayPath: true, arrayAutowrapExcluded: true,
      exactSignedUnsignedIntegers: true, explicitNullsAndPrimaryKeyTies: true, utf8BinaryAndTrailingSpaces: true,
      boundTooLongTypeMismatchAndNull: true, cursorColumnsPrivate: true, bothDirectionsAndOffset: true,
      continuousNativeWindow: Boolean(adapter.scroll), springIsolation: springBaseline };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + table); }
      finally { await actor.end(); }
    }
  }
}

async function runGridJsonSortChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.openTableSnapshot'));
  let offsetId, offsetSession;
  const record = id => api.results().find(item => item.id === id);
  const latest = id => {
    const item = record(id);
    assert.ok(item?.result && !item.editError, item?.editError || item?.error);
    return item.result;
  };
  const result = await verifyGridJsonSort(runtime, {
    async connect(config, table) {
      await api.connectMysql(config);
      await vscode.commands.executeCommand('rocketbrain.openTable', table);
      const current = api.results().at(-1);
      assert.equal(current?.result?.edit?.table, table, current?.error);
      offsetId = current.id;
      offsetSession = current.sessionId;
    },
    async disconnect() {
      if (offsetSession) await api.closeConsoleSession(offsetSession);
      await api.disconnectMysql();
    },
    async open(table, options) {
      const id = await api.openTableSnapshot(table, options);
      return { id, result: latest(id) };
    },
    async page(id, query) {
      await api.tableAction(id, { type: 'browseTable', query });
      return latest(id);
    },
    async offset(_table, query) {
      await api.tableAction(offsetId, { type: 'browseTable', query });
      return latest(offsetId);
    },
    async scroll(id, modelId) {
      await api.tableAction(id, { type: 'setContinuousScroll', enabled: true, modelId });
      await api.tableAction(id, { type: 'scrollTable', direction: 'next', modelId: latest(id).edit.modelId });
      return latest(id);
    }
  });
  checks.push('Native SQL grid walked exact nested JSON integer, Boolean and byte text sort keys on every forward and backward page and in a rolling window.');
  checks.push('Ordinary server paging matched the same NULL, PK and collation ordering, with private cursor fields kept out of the result.');
  return result;
}

module.exports = { verifyGridJsonSort, runGridJsonSortChecks };
