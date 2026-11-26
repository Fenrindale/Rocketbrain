'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSql, completionsAt } = require('../src/db/sql-analysis');
const { analyzeDmlUsage } = require('../src/db/sql-dml-usages');
const { liveNavigation, quickInfo } = require('../src/db/sql-live-navigation');
const { analyzeLiveDdlScript } = require('../src/db/ddl-model');

const column = (name, type = 'int') => ({ name, type, nullable:false, extra:'' });
const tables = [
  { name:'dst', kind:'table', columns:[column('id'), column('amount','decimal(12,2)'), column('status','varchar(20)')] },
  { name:'src', kind:'table', columns:[column('id'), column('amount','int'), column('incoming','varchar(20)')] }
];
const maria = { dialect:'mariadb', serverVersion:'11.4.8-MariaDB', database:'work', catalogComplete:true, sqlMode:[] };
const oracle = { ...maria, dialect:'mysql', serverVersion:'8.4.13' };
const catalog = { ...maria, semanticContextObserved:true, tables, views:[], coverage:{ tables:'loaded', columns:'loaded' } };
const span = (sql, item) => sql.slice(item.start,item.end);

test('RETURNING binds the written target separately from INSERT SELECT input and records expression origins', () => {
  const sql = 'INSERT INTO dst (id,amount) SELECT id,amount FROM src RETURNING id, amount AS saved, amount+1 AS next';
  const model = analyzeSql(sql,catalog,maria);
  assert.equal(model.state,'known');
  assert.equal(model.executedSql,false);
  assert.equal(model.validityVerified,false);
  assert.equal(model.returning.rowImage,'written');
  assert.equal(span(sql,model.returning),'RETURNING');
  assert.deepEqual(model.projections.map(item=>[item.name,item.type.family,item.inputs.map(input=>input.table+'.'+input.column)]),
    [['id','integer',['dst.id']],['saved','decimal',['dst.amount']],['next','decimal',['dst.amount']]]);
  const usages = analyzeDmlUsage(sql,catalog,maria);
  assert.equal(usages.state,'known');
  assert.ok(usages.references.some(ref=>ref.usage==='read' && ref.physicalColumn?.table==='src' && ref.physicalColumn.column==='amount'));
  const selected = usages.references.find(ref=>ref.returning && ref.physicalColumn?.column==='amount');
  assert.equal(span(sql,selected),'amount');
  assert.equal(selected.physicalColumn.table,'dst');
});

test('ordinary INSERT, REPLACE and single-table DELETE expose target fields with exact source replacement spans', () => {
  const cases = [
    'INSERT dst VALUES (1,10,DEFAULT) RETURNING am',
    'REPLACE INTO dst SET id=1, amount=20 RETURNING am',
    'INSERT INTO dst(id,amount) VALUES(1,2) ON DUPLICATE KEY UPDATE amount=2 RETURNING am',
    'DELETE FROM dst ORDER BY id LIMIT 1 RETURNING dst.am'
  ];
  for (const sql of cases) {
    const model=analyzeSql(sql,catalog,maria);
    const fields=completionsAt(model,sql.length);
    assert.deepEqual(fields.map(item=>item.label),['amount'],sql);
    assert.equal(span(sql,fields[0]),'am');
  }
  const cut='REPLACE INTO dst (id,amount) VALUES (1,20) RETURNING amount, ';
  const fields=completionsAt(analyzeSql(cut,catalog,maria),cut.length);
  assert.deepEqual(fields.map(item=>item.label).sort(),['amount','id','status']);
  assert.ok(fields.every(item=>item.start===cut.length&&item.end===cut.length));
  const alias='DELETE FROM dst RETURNING id AS ';
  assert.deepEqual(completionsAt(analyzeSql(alias,catalog,maria),alias.length),[]);
});

test('known vendor issues select the exact clause or offending aggregate and respect release thresholds', () => {
  const sql='INSERT INTO dst (id,amount) VALUES (1,10) RETURNING id';
  for (const [options,code] of [
    [oracle,'sql.returning.dialect'],[{...maria,serverVersion:'10.4.28-MariaDB'},'sql.returning.version']
  ]) {
    const m=analyzeSql(sql,catalog,options);assert.equal(m.state,'invalid');
    assert.deepEqual(m.diagnostics.map(item=>[item.code,span(sql,item)]),[[code,'RETURNING']]);
  }
  const unknown=analyzeSql(sql,catalog,{...maria,serverVersion:undefined});
  assert.equal(unknown.state,'unknown');
  assert.equal(unknown.diagnostics[0].severity,'information');
  const deleteSql='DELETE FROM dst WHERE id=1 RETURNING amount';
  assert.equal(analyzeSql(deleteSql,catalog,{...maria,serverVersion:'10.0.4-MariaDB'}).diagnostics[0].code,'sql.returning.version');
  assert.equal(analyzeSql(deleteSql,catalog,{...maria,serverVersion:'5.5.5-10.0.5-MariaDB'}).state,'known');

  const aliasSql='DELETE FROM dst AS d WHERE d.id=1 RETURNING d.amount';
  assert.equal(analyzeSql(aliasSql,catalog,maria).diagnostics[0].code,'sql.returning.deleteAlias');
  for (const statement of [aliasSql,aliasSql.replace(' AS d',' d')]) {
    const model=analyzeSql(statement,catalog,{...maria,serverVersion:'12.3.4-MariaDB'});
    assert.equal(model.returning.rowImage,'deleted');
    assert.equal(model.state,'known');
  }
  const update='UPDATE dst SET amount=20 WHERE id=1 RETURNING amount';
  assert.equal(analyzeSql(update,catalog,{...maria,serverVersion:'12.3.4-MariaDB'}).diagnostics[0].code,'sql.returning.version');
  const newer=analyzeSql(update,catalog,{...maria,serverVersion:'13.0.1-MariaDB'});
  assert.equal(newer.diagnostics[0].severity,'information');
  assert.equal(newer.state,'unknown');

  const agg='DELETE FROM dst WHERE id=1 RETURNING COALESCE(SUM(amount),0)';
  const aggregate=analyzeSql(agg,catalog,maria).diagnostics[0];
  assert.equal(aggregate.code,'sql.returning.aggregate');
  assert.equal(span(agg,aggregate),'SUM');
  const subquery='DELETE FROM dst WHERE id=1 RETURNING (SELECT MAX(amount) FROM src) AS output';
  const sub=analyzeSql(subquery,catalog,maria);
  assert.equal(sub.state,'known');
  assert.deepEqual(sub.projections[0].inputs,[{database:'work',table:'src',column:'amount'}]);
});

test('supported RETURNING claims neither lookalike identifiers nor multi-table mutation results', () => {
  for (const sql of [
    'INSERT INTO dst (id) SELECT id AS returning FROM src',
    'INSERT INTO dst (id) SELECT id FROM src returning',
    'INSERT INTO dst (id) SELECT id FROM src returning WHERE returning.id=1',
    'UPDATE dst SET returning=1 WHERE id=1',
    'DELETE FROM dst WHERE amount BETWEEN returning+1 AND 7',
    'INSERT INTO dst (id) SELECT DISTINCT returning+1 FROM src',
    "DELETE FROM dst WHERE status='RETURNING'",
    'DELETE FROM returning WHERE id=1',
    'DELETE FROM dst WHERE id=1 /* RETURNING amount */'
  ]) assert.equal(analyzeSql(sql,catalog,oracle).returning,undefined,sql);
  const joined='DELETE d FROM dst AS d JOIN src AS s ON d.id=s.id RETURNING d.amount';
  assert.equal(analyzeSql(joined,catalog,maria).diagnostics[0].code,'sql.returning.singleTable');
});

test('live destination hover/definition and per-statement ANSI_QUOTES analysis consume the same approved catalog', () => {
  const sql='DELETE FROM work.dst WHERE id=1 RETURNING work.dst.amount';
  const target=liveNavigation(sql,sql.lastIndexOf('amount')+1,catalog,maria);
  assert.deepEqual(target.object,{schema:'work',kind:'table',name:'dst'});
  assert.deepEqual(target.member,{name:'amount',kind:'column'});
  assert.match(quickInfo(target),/DELETE RETURNING deleted row/);
  const other='REPLACE INTO related.dst (id,amount) VALUES (1,10) RETURNING amount';
  const pending=analyzeSql(other,catalog,maria);
  assert.deepEqual(pending.pending,[{schema:'related',table:'dst'}]);
  const complete=analyzeSql(other,catalog,{...maria,joinTables:[{...tables[0],schema:'related'}]});
  assert.deepEqual(complete.projections[0].inputs,[{database:'related',table:'dst',column:'amount'}]);

  const script="SET SESSION sql_mode='ANSI_QUOTES';\nDELETE FROM \"dst\" WHERE \"id\"=1 RETURNING \"amount\";";
  for (const [seed,expected] of [[catalog,'known'],[{...catalog,...oracle},'invalid']]) {
    const report=analyzeLiveDdlScript(script,seed);
    const projected=report.statements[1];
    assert.deepEqual(projected.sqlMode,['ANSI_QUOTES']);
    assert.equal(projected.model.state,expected);
    assert.equal(projected.model.returning.command,'DELETE');
  }
});
