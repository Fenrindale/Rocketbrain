'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { traceColumnOrigin, originExplanation } = require('../src/db/sql-column-origin');
const { storedViewSelect } = require('../src/db/sql-ddl-location');

const db = 'workspace_db', foreign = 'external_catalog';
const context = { database: db, dialect: 'mysql', version: '8.4.13' };
const catalog = { database: db, dialect: 'mysql', semanticContextObserved: true };
const options = { dialect: 'mysql', database: db, sqlMode: [], tableNameCaseSensitive: true };
const nested = 'WITH c(outer_id) AS (SELECT v.shared_id FROM external_catalog.shared v) ' +
  'SELECT s.renamed FROM (SELECT c.outer_id AS renamed FROM c) s';
const tableSql = 'CREATE TABLE base (id INT NOT NULL, CHECK (id > 0))';
const viewSql = 'CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW shared (shared_id) AS ' +
  '(SELECT b.id FROM workspace_db.base AS b) WITH LOCAL CHECK OPTION';

function adapter({ view = viewSql, later, denied = false, changeColumns = false } = {}) {
  const recorded = [], tracked = { view: 0, catalog: 0 };
  const tables = [
    { schema: db, name: 'base', kind: 'BASE TABLE', column: 'id', type: 'int' },
    { schema: foreign, name: 'shared', kind: 'VIEW', column: 'shared_id', type: 'int' }
  ];
  const query = async (sql, parameters = []) => {
    recorded.push(sql);
    if (/^SHOW CREATE/u.test(sql)) {
      if (sql.startsWith('SHOW CREATE VIEW')) {
        if (denied) throw Object.assign(Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
        return { columns: ['View', 'Create View'], rows: [['shared', ++tracked.view > 1 && later ? later : view]] };
      }
      return { columns: ['Table', 'Create Table'], rows: [['base', tableSql]] };
    }
    const selected = tables.filter(item => parameters.some((value, index) => index % 2 === 0 &&
      value === item.schema && parameters[index + 1] === item.name));
    if (/SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE/u.test(sql)) return { rows: selected.map(item => [item.schema, item.name, item.kind]) };
    if (/FROM information_schema.COLUMNS/u.test(sql)) {
      tracked.catalog++;
      return { rows: selected.map(item => [item.schema, item.name, item.column,
        changeColumns && tracked.catalog > 2 ? 'bigint' : item.type, 'NO', null, null, '']) };
    }
    if (/SELECT TABLE_NAME FROM information_schema.TABLES/u.test(sql)) return { rows: selected.map(item => [item.name]) };
    assert.fail('Only scoped metadata may be read: ' + sql);
  };
  return { query, recorded };
}

test('canonical SHOW CREATE VIEW separates an explicit output list, parenthesized SELECT and check option', () => {
  const loaded = { object: { kind: 'view', schema: foreign, name: 'shared' }, source: viewSql };
  assert.deepEqual(storedViewSelect(loaded, options), { labels: ['shared_id'], text: 'SELECT b.id FROM workspace_db.base AS b' });
  assert.equal(storedViewSelect({ ...loaded, source: viewSql.replace('shared_id', 'shared_id, SHARED_ID') }, options), undefined);
});

test('nested aliases and a qualified view lead to the exact table declaration with a bounded metadata-only explanation', async () => {
  const { query, recorded } = adapter();
  const found = await traceColumnOrigin(query, context, { text: nested, offset: nested.indexOf('renamed') + 2, catalog, options });
  assert.equal(found.loaded.source.slice(found.anchor.start, found.anchor.end), 'id');
  assert.deepEqual(found.chain.map(item => [item.object.name, item.column]), [['shared', 'shared_id'], ['base', 'id']]);
  assert.match(originExplanation(found), /table workspace_db.base.id/);
  assert.match(originExplanation(found), /No user SQL was executed/);
  assert.equal(found.executedSql, false);
  assert.equal(recorded.filter(sql => sql.startsWith('SHOW CREATE')).length, 4);
});

test('MySQL canonical stored-view source can qualify observable base aliases without relaxing the editor grammar', async () => {
  const view = viewSql.replace('b.id', 'workspace_db.b.id').replace('FROM workspace_db.base', 'FROM base');
  const result = await traceColumnOrigin(adapter({ view }).query, context,
    { text: nested, offset: nested.indexOf('renamed') + 1, catalog, options });
  assert.equal(result.chain.at(-1).column, 'id');
  const text = 'SELECT workspace_db.b.id FROM workspace_db.base b';
  await assert.rejects(traceColumnOrigin(adapter().query, context, { text, offset: text.indexOf('.id') + 2, catalog, options }),
    /visible SQL sources do not prove/);
});

test('expression outputs and inaccessible definitions are not physical navigation targets', async () => {
  const input = { text: nested, offset: nested.indexOf('renamed') + 2, catalog, options };
  await assert.rejects(traceColumnOrigin(adapter({ view: viewSql.replace('b.id', 'b.id + 1') }).query, context, input), /view output is an expression/);
  await assert.rejects(traceColumnOrigin(adapter({ denied: true }).query, context, input), /cannot read this object definition/);
  const blocked = adapter();
  await assert.rejects(traceColumnOrigin(blocked.query, context,
    { ...input, text: 'SELECT id FROM base UNION SELECT id FROM base', offset: 8 }), /nonrecursive origin/);
  assert.deepEqual(blocked.recorded, []);
});

test('a concurrently replaced definition, column catalog drift or invalid editor aborts proof', async () => {
  const input = { text: nested, offset: nested.indexOf('renamed') + 2, catalog, options };
  await assert.rejects(traceColumnOrigin(adapter({ later: viewSql.replace('b.id', 'b.id + 1') }).query, context, input), /definition changed/);
  await assert.rejects(traceColumnOrigin(adapter({ changeColumns: true }).query, context, input), /Catalog columns changed/);
  const canceled = adapter();
  await assert.rejects(traceColumnOrigin(canceled.query, context, input, () => { throw Error('Editor closed.'); }), /Editor closed/);
  assert.ok(canceled.recorded.every(sql => !sql.startsWith('SHOW CREATE')));
});
