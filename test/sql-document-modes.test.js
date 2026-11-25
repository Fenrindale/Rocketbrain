'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeLiveDdlScript } = require('../src/db/ddl-model');
const { statementRanges, sourceTokens } = require('../src/db/sql-analysis');

const slash = String.fromCharCode(92);
const unusual = 'quoted' + slash + 'column';
const seed = { database: 'app', dialect: 'mysql', serverVersion: '8.4.13', semanticContextObserved: true,
  sqlMode: ['STRICT_TRANS_TABLES'], coverage: { tables: 'loaded', columns: 'loaded' },
  tables: [{ name: 'example', columns: [{ name: unusual, type: 'int' }, { name: 'normal', type: 'int' }] }], views: [] };
const set = mode => "SET SESSION sql_mode='" + mode + "';";
const modeOptions = { ...seed, documentSqlModes: true };

test('document ranges and catalog binding use successive exact literal session modes without mutating the seed', () => {
  const example = [
    set('ANSI_QUOTES'), 'SELECT "p"."' + unusual + '" FROM "example" "p";',
    set('ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES'),
    "SELECT 'ends" + slash + "' AS literal_text, " + '"p"."normal" FROM "example" "p";',
    "SET LOCAL sql_mode='';", 'SELECT "now;a string" AS item FROM example;'
  ].join('\n');
  const report = analyzeLiveDdlScript(example, seed);
  assert.equal(report.state, 'known');
  assert.deepEqual(report.unknown, []);
  assert.deepEqual(report.modeTransitions.map(item => item.sqlMode), [
    ['ANSI_QUOTES'], ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES', 'STRICT_TRANS_TABLES'], []
  ]);
  assert.equal(report.statements.length, 6);
  assert.equal(report.statements[1].model.references.find(item => item.name === unusual).type.family, 'integer');
  assert.deepEqual(report.statements[3].model.projections.map(item => item.type.family), ['string', 'integer']);
  assert.equal(report.statements[5].model.projections[0].type.family, 'string');
  assert.ok(report.statements.every(item => item.model.executedSql === false));
  assert.ok(report.modeTransitions.every(item => example.slice(item.start, item.end).startsWith('SET')));
  assert.deepEqual(seed.sqlMode, ['STRICT_TRANS_TABLES']);
  assert.ok(statementRanges(example, modeOptions).statements.length > statementRanges(example, seed).statements.length);
});

test('ANSI identifiers preserve literal backslashes and doubled delimiters even when string escapes are enabled', () => {
  const tokens = sourceTokens('SELECT "' + unusual + '", "double""quote"', { sqlMode: ['ANSI_QUOTES'] });
  const names = tokens.filter(token => token.kind === 'identifier').map(token => token.value);
  assert.deepEqual(names, [unusual, 'double"quote']);
});

test('unknown, compound, incomplete, global and bundled mode commands stop later context instead of guessing', () => {
  const tail = ' SELECT "normal" FROM example;';
  const rejected = [
    "SET SESSION sql_mode=CONCAT('ANSI','_QUOTES');",
    "SET GLOBAL sql_mode='ANSI_QUOTES';",
    "SET SESSION sql_mode='ORACLE';",
    "SET SESSION sql_mode='UNKNOWN_BROWSER_MODE';",
    "SET SESSION sql_mode='ANSI_QUOTES', @other=1;",
    "/*!80000 SET @x=1 */ SET LOCAL sql_mode='ANSI_QUOTES';",
    "CALL existing_method(); " + set('ANSI_QUOTES')
  ];
  for (const source of rejected) {
    const report = analyzeLiveDdlScript(source + tail, seed);
    assert.equal(report.modeTransitions.length, 0, source);
    assert.equal(report.statements.at(-1).contextUncertain, true, source);
  }
  assert.equal(analyzeLiveDdlScript("SET LOCAL sql_mode='ANSI_QUOTES'", seed).modeTransitions.length, 0);
});

test('cached, unobserved or profile-specific catalog modes cannot be inferred from the document', () => {
  const text = set('ANSI_QUOTES') + ' SELECT "normal" FROM example;';
  assert.equal(analyzeLiveDdlScript(text, { ...seed, semanticContextObserved: false }), null);
  assert.equal(analyzeLiveDdlScript(text, { ...seed, sqlMode: ['ORACLE'] }), null);
  assert.equal(analyzeLiveDdlScript(text, { ...seed, cachedMetadata: {} }), null);
  const unresolved = statementRanges('SELECT );' + text, modeOptions);
  assert.ok(unresolved.unknown.some(item => /Unbalanced/u.test(item.reason)));
  assert.ok(unresolved.statements.every(item => !item.modeTransition));
});
