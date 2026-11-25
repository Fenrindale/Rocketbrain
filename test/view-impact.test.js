'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { limits, observeViewImpact } = require('../src/db/view-impact');

const target = { schema: 'home', name: 'Base', kind: 'table' };
const request = { target, schemas: ['peer', 'home'] };
const backtick = String.fromCharCode(96);
const quoted = name => backtick + name + backtick;
const from = (schema, relation) => 'select id from ' + quoted(schema) + '.' + quoted(relation);
const definition = (schema, name, sql) => [schema, name, Buffer.byteLength(sql), sql];

function fixture(settings = {}) {
  return {
    relations: [
      ['home', 'Base', 'BASE TABLE'], ['home', 'Local', 'VIEW'], ['home', 'Opaque', 'VIEW'],
      ['home', 'Oversize', 'VIEW'], ['home', 'Withheld', 'VIEW'],
      ['peer', 'Base', 'BASE TABLE'], ['peer', 'Direct', 'VIEW'], ['peer', 'Outside', 'VIEW'],
      ['peer', 'Shadow', 'VIEW']
    ],
    definitions: [
      definition('home', 'Local', from('peer', 'Direct')),
      definition('home', 'Opaque', from('home', 'Base') + ' union select 1'),
      ['home', 'Oversize', limits.definitionBytes + 1, null],
      definition('peer', 'Direct', from('home', 'Base')),
      definition('peer', 'Shadow', from('peer', 'Base')),
      definition('peer', 'Outside', from('unknown', 'Base'))
    ],
    settings: ['8.4.13', 'home', 'reader@example', 'NONE', 0, 'STRICT_TRANS_TABLES'],
    ...settings
  };
}

function source(observation = fixture(), next = observation) {
  let capture = 0;
  const queries = [];
  async function query(sql, values) {
    assert.match(sql, /^SELECT /u);
    queries.push({ sql, values });
    if (sql.startsWith('SELECT VERSION()')) return { rows: [(++capture === 1 ? observation : next).settings] };
    const state = capture === 1 ? observation : next;
    assert.deepEqual(values, [...values].sort());
    assert.match(sql, /CAST\(\? AS BINARY\)/u);
    const within = rows => rows.filter(row => values.includes(row[0]));
    if (sql.includes('information_schema.SCHEMATA')) {
      return { rows: values.filter(name => !state.hidden?.includes(name)).map(name => [name]) };
    }
    if (sql.includes('information_schema.TABLES')) return { rows: within(state.relations), truncated: state.truncated };
    if (sql.includes('information_schema.VIEWS')) return { rows: within(state.definitions) };
    throw Error('Unexpected query: ' + sql);
  }
  return { query, queries };
}

test('uses an exact account-visible target and shortest reverse view paths across selected schemas', async () => {
  const { query, queries } = source();
  const report = await observeViewImpact(query, request);
  assert.deepEqual(report.target, target);
  assert.deepEqual(report.schemas, ['home', 'peer']);
  assert.deepEqual(report.impacted.map(item => [item.depth, item.path.map(value => [value.schema, value.name])]), [
    [1, [['home', 'Base'], ['peer', 'Direct']]],
    [2, [['home', 'Base'], ['peer', 'Direct'], ['home', 'Local']]]
  ]);
  assert.equal(report.edges.length, 2);
  assert.deepEqual(report.opaqueViews.map(item => item.reason), [
    'unsupported-view-definition', 'definition-over-limit', 'definition-unavailable'
  ]);
  assert.deepEqual(report.unresolvedReferences.map(item => item.reason), ['outside-selected-schemas']);
  assert.equal(report.readOnly, true);
  assert.match(report.fingerprint, /^[a-f\d]{64}$/u);
  assert.ok(!JSON.stringify(report).includes('reader@example'));
  assert.equal(queries.length, 8);
});

test('a view target leads downstream and a narrowed scope reports unresolved edges without following them', async () => {
  const { query } = source();
  const result = await observeViewImpact(query, {
    target: { schema: 'peer', name: 'Direct', kind: 'view' }, schemas: ['peer', 'home']
  });
  assert.deepEqual(result.impacted.map(item => item.relation.name), ['Local']);
  const limited = await observeViewImpact(source().query, { target, schemas: ['home'] });
  assert.equal(limited.impacted.length, 0);
  assert.equal(limited.unresolvedReferences[0].view.name, 'Local');
  assert.equal(limited.unresolvedReferences[0].reason, 'outside-selected-schemas');
});

test('applies observed case mode to physical references and never merges colliding dictionary keys', async () => {
  const base = fixture();
  const state = fixture({ settings: [...base.settings.slice(0, 4), 2, base.settings[5]], definitions: [
    definition('home', 'Local', from('PEER', 'DIRECT')), definition('peer', 'Direct', from('HOME', 'BASE'))
  ] });
  const resolved = await observeViewImpact(source(state).query, request);
  assert.deepEqual(resolved.impacted.map(item => item.relation.name), ['Direct', 'Local']);
  const exact = await observeViewImpact(source({ ...state, settings: base.settings }).query, request);
  assert.equal(exact.impacted.length, 0);
  const ambiguous = await observeViewImpact(source({
    ...state, relations: [...state.relations, ['home', 'base', 'BASE TABLE']]
  }).query, request);
  assert.equal(ambiguous.impacted.length, 0);
  assert.equal(ambiguous.unresolvedReferences[0].reason, 'ambiguous-catalog-name');
});

test('refuses a changed source or role between metadata passes', async () => {
  const base = fixture();
  const revised = [...base.definitions];
  revised[0] = definition('home', 'Local', from('peer', 'Base'));
  await assert.rejects(() => observeViewImpact(source(base, { ...base, definitions: revised }).query, request), /changed during analysis/u);
  const switchedRole = [...base.settings];
  switchedRole[3] = 'different';
  await assert.rejects(() => observeViewImpact(source(base, { ...base, settings: switchedRole }).query, request), /changed during analysis/u);
});

test('refuses missing, unauthorised, truncated or oversized scopes and contradictory relation identities', async () => {
  await assert.rejects(() => observeViewImpact(source(fixture({ hidden: ['peer'] })).query, request), /missing or not visible/u);
  await assert.rejects(() => observeViewImpact(source(fixture({ truncated: true })).query, request), /exceeds its bound/u);
  const relations = Array.from({ length: limits.views + 1 }, (_, index) => ['home', 'V' + index, 'VIEW']);
  await assert.rejects(() => observeViewImpact(source(fixture({ relations })).query, request), /more than 64 views/u);
  await assert.rejects(() => observeViewImpact(source().query, { ...request, target: { ...target, name: 'base' } }), /missing, hidden/u);
  await assert.rejects(() => observeViewImpact(source().query, { target, schemas: ['home', 'mysql'] }), /application schemas/u);
  await assert.rejects(() => observeViewImpact(source().query, { target, schemas: ['home', 'home'] }), /distinct/u);
  const observed = fixture();
  const invalid = { ...observed, definitions: [...observed.definitions, definition('home', 'Unknown', from('home', 'Base'))] };
  await assert.rejects(() => observeViewImpact(source(invalid).query, request), /definitions disagree/u);
});

test('a grouped comma join becomes opaque instead of reporting an incomplete definition as resolved', async () => {
  const observed = fixture({ definitions: [
    definition('home', 'Local', 'SELECT 1 FROM (' + quoted('home') + '.' + quoted('Base') + ', ' + quoted('peer') + '.' + quoted('Base') + ')')
  ] });
  const report = await observeViewImpact(source(observed).query, request);
  assert.equal(report.impacted.length, 0);
  assert.equal(report.opaqueViews.find(item => item.relation.name === 'Local').reason, 'unsupported-view-definition');
});

test('escape-sensitive text stays opaque without the stored view creation SQL mode', async () => {
  const sql = from('home', 'Base') + " where id = 'a\\b'";
  const report = await observeViewImpact(source(fixture({ definitions: [definition('home', 'Local', sql)] })).query, request);
  assert.deepEqual(report.impacted, []);
  assert.equal(report.opaqueViews.find(item => item.relation.name === 'Local').reason, 'unsupported-view-definition');
});
