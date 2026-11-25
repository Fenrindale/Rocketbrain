'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ddlDefinitionLocation } = require('../src/db/sql-ddl-location');
const { liveNavigation, quickInfo } = require('../src/db/sql-live-navigation');

const q = String.fromCharCode(96);
const quoted = name => q + name.replaceAll(q, q + q) + q;
const column = name => ({ name, kind: 'column' });
const object = (kind, name, schema = 'app') => ({ kind, name, schema });
const ddl = (metadata, source, settings) => ({ object: metadata, source, dialect: 'mysql', settings });
const locate = (loaded, member, sqlMode) => {
  const span = ddlDefinitionLocation(loaded, member, sqlMode);
  return span && { ...span, selected: loaded.source.slice(span.start, span.end) };
};

test('DDL anchors select table name and top-level column declarations exactly', () => {
  const text = 'CREATE TABLE ' + quoted('odd`name') + ' (\n  ' + quoted('id') + ' int,\n  ' + quoted('score') +
    " int DEFAULT ',' COMMENT 'id',\n  KEY " + quoted('score_key') + ' (' + quoted('score') + ')\n)';
  const loaded = ddl(object('table', 'odd`name'), text);
  assert.equal(locate(loaded).selected, quoted('odd`name'));
  assert.equal(locate(loaded, column('id')).start, text.indexOf(quoted('id')));
  assert.equal(locate(loaded, column('score')).start, text.indexOf(quoted('score')));
  assert.equal(locate(loaded, column('score_key')), undefined);
  assert.equal(locate({ ...loaded, object: object('table', 'elsewhere') }), undefined);
  const ansi = ddl(object('table', 'order'), 'CREATE TABLE "order" ("odd column" int)');
  assert.equal(locate(ansi, column('odd column'), ['ANSI_QUOTES']).selected, '"odd column"');
  assert.equal(locate(ansi, column('odd column')), undefined);
});

test('view columns anchor exact output aliases or explicit column lists and never same-named inputs', () => {
  const text = 'CREATE ALGORITHM=UNDEFINED DEFINER=' + quoted('admin') + '@' + quoted('localhost') + ' SQL SECURITY DEFINER VIEW ' +
    quoted('app') + '.' + quoted('v') + ' AS SELECT x.score AS raw_score, x.id AS score, x.direct FROM data AS x';
  const loaded = ddl(object('view', 'v'), text);
  assert.equal(locate(loaded).selected, quoted('v'));
  assert.equal(locate(loaded, column('score')).start, text.indexOf('AS score') + 3);
  assert.equal(locate(loaded, column('direct')).selected, 'direct');
  assert.equal(locate(loaded, column('id')), undefined);
  assert.equal(locate(ddl(object('view','v'), 'CREATE VIEW v(main_value) AS SELECT score FROM data'), column('main_value')).selected, 'main_value');
  assert.equal(locate(ddl(object('view','v'), 'CREATE VIEW v AS SELECT score AS x, id AS x FROM data'), column('x')), undefined);
  assert.equal(locate(ddl(object('view','v'), 'CREATE VIEW v AS WITH k AS (SELECT score AS inside FROM data) SELECT inside AS outward FROM k'), column('outward')).selected, 'outward');
});

test('routine anchors use the actual CREATE name and declared lexical mode', () => {
  const procedure = ddl(object('procedure', 'walk'), 'CREATE DEFINER=' + quoted('admin') + '@' + quoted('localhost') +
    ' PROCEDURE ' + quoted('walk') + '(IN n INT) BEGIN SELECT n; END', { sql_mode: '' });
  assert.equal(locate(procedure).selected, quoted('walk'));
  const fn = ddl(object('function', 'same'), 'CREATE DEFINER=' + quoted('admin') + '@' + quoted('localhost') +
    ' FUNCTION "same"(n INT) RETURNS INT RETURN n+1', { sql_mode: 'ANSI_QUOTES' });
  assert.equal(locate(fn).selected, '"same"');
  assert.equal(locate({ ...fn, dialect: 'mariadb', settings: { sql_mode: '' } }), undefined);
});

const people = { kind: 'table', name: 'people', columns: [{ name: 'id', type: 'int', nullable: false }] };
const view = { kind: 'view', name: 'summary', columns: [{ name: 'key_value', type: 'int', nullable: true }] };
const catalog = {
  database: 'app', coverage: { tables: 'loaded', columns: 'loaded', routines: 'loaded' },
  tables: [people], views: [view], routines: [{ name: 'calc', type: 'FUNCTION', returnType: 'int' }, { name: 'fetch_data', type: 'PROCEDURE' }]
};
const options = { sqlMode: [], tableNameCaseSensitive: true };
const plan = (text, target, remote, ownCatalog = catalog) => liveNavigation(text, text.indexOf(target) + Math.floor(target.length / 2), ownCatalog, options, remote);

test('binding gives local declarations priority and resolves account-observed table, view and columns', () => {
  assert.deepEqual(plan('SELECT p.id FROM people p', 'people').object, object('table', 'people'));
  const id = plan('SELECT p.id FROM people p', 'id');
  assert.deepEqual(id, { object: object('table','people'), member: column('id'), observed: true, type: 'int', nullable: false });
  assert.match(quickInfo(id), /table column app\.people\.id · int · NOT NULL/);
  assert.deepEqual(plan('SELECT s.key_value FROM summary s', 'key_value').object, object('view','summary'));
  assert.equal(plan('SELECT p.id FROM people p', 'p.'), undefined);
  assert.equal(plan('WITH s(key_value) AS (SELECT id FROM people) SELECT x.key_value FROM s x', 'x.key_value'), undefined);
  assert.equal(plan("SELECT ''", 'no target'), undefined);
  assert.equal(plan('SELECT missing.id FROM people p', 'id'), undefined);
  assert.equal(plan('SELECT /* ! closed */ nonexistent FROM people', 'nonexistent'), undefined);
  assert.equal(plan('SELECT "quoted" FROM people', 'quoted'), undefined);
});

test('qualified remote roots are fetched only for bound tokens and rebound before navigation', () => {
  const remote = { ...people, schema: 'other', columns: [{ name: 'foreign_id', type: 'bigint', nullable: false }] };
  const source = 'SELECT r.foreign_id FROM other.people r';
  assert.deepEqual(plan(source, 'foreign_id'), { endpoints: [{ schema: 'other', table: 'people' }] });
  assert.deepEqual(plan(source, 'people'), { endpoints: [{ schema: 'other', table: 'people' }] });
  assert.deepEqual(plan(source, 'foreign_id', [remote]).object, object('table','people','other'));
  assert.equal(plan(source, 'r.'), undefined);
  assert.equal(plan('SELECT unknown.id FROM other.people r', 'id'), undefined);
  assert.equal(plan('SELECT r.foreign_id FROM other.people r, people r', 'foreign_id'), undefined);
  assert.equal(plan('SELECT r.nothing FROM other.people r', 'nothing', [remote]), undefined);
  assert.equal(plan('SELECT id FROM other.people r, people p', 'id', [{ ...people, schema: 'other' }]), undefined);
});

test('qualified stored functions and direct CALL resolve exact routines independent of built-ins', () => {
  const procedure = plan('CALL fetch_data(7);', 'fetch_data');
  assert.deepEqual(procedure.object, object('procedure', 'fetch_data'));
  assert.match(quickInfo(procedure), /stored procedure app\.fetch_data/);
  assert.deepEqual(plan('SELECT app.calc(7)', 'calc'), { object: object('function','calc'), observed: true, type: 'int' });
  const remote = plan('CALL other.remote_proc(7)', 'remote_proc');
  assert.deepEqual(remote.object, object('procedure', 'remote_proc', 'other'));
  assert.equal(quickInfo(remote), undefined);
  assert.match(quickInfo(remote, true), /current account/);
  assert.equal(plan('SELECT calc(7)', 'calc'), undefined);
  assert.equal(plan('SELECT * FROM app.calc(7)', 'calc'), undefined);
  assert.equal(plan('SELECT COUNT(*) FROM people', 'COUNT'), undefined);
  assert.equal(plan('CALL unknown(7)', 'unknown'), undefined);
  assert.equal(plan('SELECT app.calc(7)', 'calc', [], { ...catalog, coverage: { tables: 'loaded', columns: 'loaded' } }), undefined);
});
