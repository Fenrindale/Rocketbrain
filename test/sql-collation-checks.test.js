'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { compileRegistry, inspectCollations, observeCollationRegistry } = require('../src/db/sql-collation-checks');
const { analyzeSql } = require('../src/db/sql-analysis');

const rows = [['utf8mb4_general_ci','utf8mb4',45],['utf8mb4_unicode_ci','utf8mb4',224],
  ['latin1_swedish_ci','latin1',8],['utf8mb3_general_ci','utf8mb3',33]];
const catalog = { database:'app', dialect:'mysql', semanticContextObserved:true, sqlMode:[], tableNameCaseSensitive:true,
  coverage:{tables:'loaded',columns:'loaded'}, views:[],
  tables:[{name:'person',columns:[{name:'id',type:'int',charset:null},{name:'label',type:'varchar(32)',charset:'utf8mb4'}]},
    {name:'peer',columns:[{name:'label',type:'varchar(32)',charset:'latin1'}]}] };
const actual = compileRegistry('mysql', rows);
const issues = (text, source = catalog, registry = actual) => inspectCollations(text, source, registry)
  .map(item => [item.code,text.slice(item.start,item.end)]);

test('collation names and charsets are grounded in observed columns, explicit casts and literal introducers', () => {
  assert.deepEqual(issues('SELECT p.label COLLATE latin1_swedish_ci FROM person p;'), [['sql.collation.charset','latin1_swedish_ci']]);
  assert.deepEqual(issues("SELECT _utf8mb4'x' COLLATE nonexistent;"), [['sql.collation.unknown','nonexistent']]);
  assert.deepEqual(issues("SELECT CAST('x' AS CHAR(32) CHARACTER SET latin1) COLLATE utf8mb4_general_ci;"),
    [['sql.collation.charset','utf8mb4_general_ci']]);
  assert.deepEqual(issues("SELECT _utf8'x' COLLATE utf8_general_ci;"), []);
  assert.deepEqual(issues("SELECT 'x' COLLATE latin1_swedish_ci, p.id COLLATE utf8mb4_unicode_ci FROM person p;"), []);
  assert.ok(!analyzeSql("SELECT _utf8mb4'x' COLLATE utf8mb4_general_ci", catalog, {sqlMode:[]}).diagnostics.length);
});

test('MariaDB applicability links canonical multi-charset names and shared identities', async () => {
  const native = [['uca1400_ai_ci','utf8mb4','utf8mb4_uca1400_ai_ci',2304], ['uca1400_ai_ci','utf8mb3','utf8mb3_uca1400_ai_ci',2048]];
  const registry = await observeCollationRegistry(async sql => sql.includes('APPLICABILITY') ? native : [...rows,['uca1400_ai_ci',null,null]], 'mariadb');
  const maria = { ...catalog, dialect:'mariadb' };
  assert.deepEqual(issues("SELECT _utf8mb4'x' COLLATE uca1400_ai_ci = _utf8mb4'y' COLLATE utf8mb4_uca1400_ai_ci",maria,registry),[]);
  assert.deepEqual(issues("SELECT _latin1'x' COLLATE uca1400_ai_ci",maria,registry),[['sql.collation.charset','uca1400_ai_ci']]);
  assert.throws(() => compileRegistry('mariadb',rows,[['utf8mb4_general_ci','utf8mb4','utf8mb4_general_ci',99]]), /conflicting identities/);
});

test('only adjacent direct string comparisons diagnose incompatible explicit collations', () => {
  assert.deepEqual(issues("SELECT _utf8mb4'x' COLLATE utf8mb4_general_ci = _utf8mb4'y' COLLATE utf8mb4_unicode_ci;"),
    [['sql.collation.explicitConflict','=']]);
  assert.deepEqual(issues("SELECT 1 + _utf8mb4'x' COLLATE utf8mb4_general_ci = _utf8mb4'y' COLLATE utf8mb4_unicode_ci"),[]);
  assert.deepEqual(issues("SELECT _utf8mb4'x' COLLATE utf8mb4_general_ci = _latin1'y' COLLATE latin1_swedish_ci"),[]);
  assert.deepEqual(issues("SELECT _utf8mb4'x' COLLATE utf8mb4_general_ci = _utf8mb4'y' COLLATE utf8mb4_unicode_ci + 1"),[]);
});

test('bound nested references retain their charset and ambiguous, cached or changed scopes stay silent', () => {
  assert.deepEqual(issues('WITH c AS (SELECT p.label FROM person p) SELECT c.label COLLATE latin1_swedish_ci FROM c'),
    [['sql.collation.charset','latin1_swedish_ci']]);
  assert.deepEqual(issues("SELECT label COLLATE latin1_swedish_ci FROM person,peer"),[]);
  assert.deepEqual(issues("SELECT p.label COLLATE latin1_swedish_ci FROM person p",{...catalog,cachedMetadata:{}}),[]);
  assert.deepEqual(issues('SELECT 1; SET NAMES latin1; SELECT p.label COLLATE latin1_swedish_ci FROM person p'),[]);
  assert.deepEqual(issues("SELECT 'COLLATE bogus'; -- COLLATE bogus\nSELECT 1"),[]);
  assert.deepEqual(issues("WITH RECURSIVE c AS (SELECT label FROM person) SELECT c.label COLLATE latin1_swedish_ci FROM c"),[]);
});
