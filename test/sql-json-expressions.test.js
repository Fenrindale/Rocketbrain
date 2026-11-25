'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeSql } = require('../src/db/sql-analysis');

const catalog = {database:'fixture',tables:[{name:'documents',columns:[
  {name:'document',type:'json'},{name:'runtime_path',type:'varchar(40)'}
]}],coverage:{tables:'loaded',columns:'loaded'}};
const run = (sql,dialect='mysql',sqlMode=[])=>analyzeSql(sql,catalog,{dialect,sqlMode});
const diagnostics = (sql,dialect='mysql')=>run(sql,dialect).diagnostics.map(issue=>[issue.code, sql.slice(issue.start,issue.end)]);

test('ordinary JSON calls keep typed returns and physical column references in nested SELECTs', () => {
  const sql = "WITH d AS (SELECT document FROM documents) SELECT JSON_LENGTH(d.document,'$.items'), JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.name')), JSON_SET(d.document,'$.flag',1) FROM d";
  for (const dialect of ['mysql','mariadb']) {
    const model = run(sql,dialect);
    assert.equal(model.state,'known',JSON.stringify(model.coverage));
    assert.deepEqual(model.projections.map(column=>column.type.family),['integer','string','json']);
    assert.equal(model.references.filter(ref=>ref.kind==='column'&&ref.name==='document').length,4);
    assert.equal(model.validityVerified,false);
    assert.equal(model.executedSql,false);
  }
});

test('literal JSON diagnostics target the call or the exact argument, including malformed slots', () => {
  const sql = "SELECT JSON_EXTRACT(document), JSON_SET(document,'$.enabled'), JSON_OBJECT('only'), JSON_EXTRACT(document,,'$.name'), JSON_EXTRACT(document,'missing_root'), JSON_SET(document,('$.items[*]'),1), JSON_CONTAINS_PATH(document,'some','$.x'), JSON_TYPE('not json'), JSON_OBJECT(NULL,1), JSON_EXTRACT(document,'$.bad[') FROM documents";
  for (const dialect of ['mysql','mariadb']) {
    assert.deepEqual(diagnostics(sql,dialect),[
      ['sql.json.arity','JSON_EXTRACT'],['sql.json.arity','JSON_SET'],['sql.json.arity','JSON_OBJECT'],
      ['sql.json.arity','JSON_EXTRACT'],['sql.json.path',"'missing_root'"],['sql.json.path.multiple',"'$.items[*]'"],
      ['sql.json.mode',"'some'"],['sql.json.document',"'not json'"],...(dialect==='mysql' ? [['sql.json.key','NULL']] : []),['sql.json.path',"'$.bad['"]
    ]);
  }
});

test('JSON validation and JSON string conversions accept intentional invalid document text', () => {
  const sql = "SELECT JSON_VALID('not json'), JSON_QUOTE('not json'), JSON_UNQUOTE('not json'), JSON_EXTRACT(document,NULL), JSON_OBJECT(), JSON_ARRAY() FROM documents";
  const model = run(sql);
  assert.deepEqual(model.diagnostics,[]);
  assert.deepEqual(model.projections.map(column=>column.type.family),['integer','string','string','json','json','json']);
});

test('quoted members, dialect modes and runtime JSON paths are distinguished', () => {
  assert.deepEqual(diagnostics("SELECT JSON_SET(document,'$.\"literal*dot.key\"',1) FROM documents"),[]);
  assert.deepEqual(diagnostics("SELECT JSON_EXTRACT(document,'lax $.inner[0]') FROM documents",'mariadb'),[]);
  assert.deepEqual(diagnostics("SELECT JSON_EXTRACT(document,'lax $.inner[0]') FROM documents"),[['sql.json.path',"'lax $.inner[0]'"]]);
  const runtime = run('SELECT JSON_EXTRACT(document,runtime_path), JSON_LENGTH(document,?) FROM documents');
  assert.ok(runtime.coverage.unknown.some(item=>item.reason.includes('path value or string decoding')));
  assert.ok(runtime.references.some(item=>item.name==='runtime_path'));
  for (const literal of ['$[-1]','$[last-1]','$[0 to 3]','$.café']) {
    const model = run("SELECT JSON_EXTRACT(document,'" + literal + "') FROM documents");
    assert.deepEqual(model.diagnostics,[]);
    assert.ok(model.coverage.unknown.some(item=>item.reason.includes('unverified JSON path form')));
  }
});

test('JSON_LENGTH preserves the observed engine-specific wildcard capability', () => {
  const sql = "SELECT JSON_LENGTH(document,'$.inner[*]') FROM documents";
  assert.deepEqual(analyzeSql(sql,catalog,{dialect:'mysql',serverVersion:'8.4.13'}).diagnostics,[]);
  assert.equal(analyzeSql(sql,catalog,{dialect:'mysql',serverVersion:'8.0.25'}).diagnostics[0].code,'sql.json.path.multiple');
  assert.equal(analyzeSql(sql,catalog,{dialect:'mariadb',serverVersion:'11.4.8-MariaDB'}).diagnostics[0].code,'sql.json.path.multiple');
  assert.deepEqual(analyzeSql(sql,catalog,{dialect:'mysql'}).diagnostics,[]);
});

test('SQL string escaping is interpreted with the observed SQL mode', () => {
  const sql = "SELECT JSON_EXTRACT('{\"a\":\"line\\nend\"}','$.a')";
  assert.deepEqual(diagnostics(sql),[['sql.json.document',"'{\"a\":\"line\\nend\"}'"]]);
  assert.deepEqual(run(sql,'mysql',['NO_BACKSLASH_ESCAPES']).diagnostics,[]);
  assert.equal(analyzeSql(sql,catalog,{dialect:'mysql'}).state,'unknown');
  assert.deepEqual(analyzeSql(sql,catalog,{dialect:'mysql'}).diagnostics,[]);
});

test('MySQL arrows provide typed projection and predicate references at the original source offsets', () => {
  const sql = "SELECT d.document->'$.x', d.document->>'$.y' FROM documents d WHERE d.document->>'invalid'='yes'";
  const model = run(sql);
  assert.deepEqual(model.projections.map(column=>column.type.family),['json','string']);
  assert.deepEqual(diagnostics(sql),[['sql.json.path',"'invalid'"]]);
  assert.equal(model.references.filter(ref=>ref.kind==='column'&&ref.name==='document').length,3);
  const maria = run(sql,'mariadb');
  assert.deepEqual(maria.diagnostics,[]);
  assert.ok(maria.coverage.unknown.some(item=>item.reason.includes('no verified MariaDB source contract')));
});
