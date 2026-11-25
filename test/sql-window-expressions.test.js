'use strict';

const assert = require('node:assert/strict'), test = require('node:test');
const { analyzeSql, definitionsAt } = require('../src/db/sql-analysis');

const catalog = {database:'fixture',tables:[{name:'person',columns:[
  {name:'id',type:'int'},{name:'amount',type:'decimal(12,2)'},{name:'label',type:'varchar(40)'},{name:'created_on',type:'date'}
]}],coverage:{tables:'loaded',columns:'loaded'}};
const run = (sql,dialect='mysql')=>analyzeSql(sql,catalog,{sqlMode:[],dialect});
const issues = (sql,dialect)=>run(sql,dialect).diagnostics.map(issue=>[issue.code,sql.slice(issue.start,issue.end)]);

test('window result types and partition/order bindings survive inherited source windows', () => {
  const sql = 'SELECT RANK() OVER ranked AS rank_id, FIRST_VALUE(p.label) OVER ranked AS first_label, '+
    'SUM(p.amount) OVER (ranked ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS sum_value, CUME_DIST() OVER ranked AS distribution '+
    'FROM person p WINDOW base AS (PARTITION BY p.label), ranked AS (base ORDER BY p.id)';
  for (const dialect of ['mysql','mariadb']) {
    const model=run(sql,dialect);
    assert.equal(model.state,'known',JSON.stringify(model.coverage));
    assert.deepEqual(model.projections.map(p=>p.type.family),['integer','string','decimal','floating']);
    assert.ok(model.references.some(ref=>ref.kind==='column'&&ref.start===sql.lastIndexOf('p.id')+2));
    const range=definitionsAt(model,sql.indexOf('OVER ranked')+6,{skipImplicit:true})[0];
    assert.equal(range.start,sql.indexOf('ranked AS (base'));
    assert.equal(sql.slice(range.start,range.end),'ranked');
    assert.equal(model.executedSql,false);
  }
});

test('window frames distinguish unbounded boundaries and reversed boundary categories', () => {
  for (const dialect of ['mysql','mariadb']) {
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED FOLLOWING AND UNBOUNDED FOLLOWING) FROM person',dialect),
      [['sql.window.frame.boundary','UNBOUNDED FOLLOWING']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 1 PRECEDING) FROM person',dialect),
      [['sql.window.frame.boundary','1 PRECEDING']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id ROWS 1 FOLLOWING) FROM person',dialect),[['sql.window.frame.boundary','1 FOLLOWING']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 2 PRECEDING) FROM person',dialect),[]);
  }
});

test('frame offset diagnostics separate integer ROWS from numeric and temporal RANGE', () => {
  for (const dialect of ['mysql','mariadb']) {
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ROWS -1 PRECEDING) FROM person',dialect),[['sql.window.frame.offset','-1']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ROWS 1.5 PRECEDING) FROM person',dialect),[['sql.window.frame.offset','1.5']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id,label RANGE 1 PRECEDING) FROM person',dialect),[['sql.window.frame.orderCount','RANGE']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY label RANGE 1 PRECEDING) FROM person',dialect),[['sql.window.frame.orderType','label']]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id RANGE 1.5 PRECEDING) FROM person',dialect),[]);
    assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY created_on RANGE 1 PRECEDING) FROM person',dialect),[['sql.window.frame.orderType','created_on']]);
  }
  assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY created_on RANGE INTERVAL 1 DAY PRECEDING) FROM person','mysql'),[]);
  assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY created_on RANGE INTERVAL 1 DAY PRECEDING) FROM person','mariadb'),
    [['sql.window.frame.interval','INTERVAL 1 DAY']]);
  assert.deepEqual(issues('SELECT SUM(amount) OVER (ORDER BY id RANGE INTERVAL 1 DAY PRECEDING) FROM person','mysql'),
    [['sql.window.frame.orderType','id']]);
});

test('vendor-specific window restrictions preserve actually valid controls for each engine', () => {
  const compatible = 'SELECT RANK() OVER (), RANK() OVER (ORDER BY id ROWS 1 PRECEDING), LAG(label,-1) OVER (ORDER BY id), NTILE(2) OVER (), NTH_VALUE(label,0) OVER (ORDER BY id) FROM person';
  assert.deepEqual(issues(compatible,'mysql'),[['sql.window.argument','-1'],['sql.window.argument','0']]);
  assert.deepEqual(issues(compatible,'mariadb'),[['sql.window.order.required','OVER'],['sql.window.frame.function','ROWS']]);
  const defaults = "SELECT LEAD(label,1,'empty') OVER (ORDER BY id) FROM person";
  assert.equal(run(defaults).projections[0].type.family,'string');
  assert.deepEqual(issues(defaults,'mariadb'),[['sql.window.arity','LEAD']]);
  assert.equal(run('SELECT LAG(label,1,123) OVER (ORDER BY id) FROM person').state,'unknown');
});

test('query-local names cannot cross a nested SELECT and placement restrictions use exact OVER anchors', () => {
  const sql = 'SELECT (SELECT ROW_NUMBER() OVER local_win FROM person) FROM person WINDOW local_win AS (ORDER BY id)';
  assert.deepEqual(issues(sql),[['sql.window.name','local_win']]);
  const forward = 'SELECT SUM(amount) OVER derived FROM person WINDOW derived AS (later ORDER BY id), later AS (PARTITION BY label)';
  assert.deepEqual(issues(forward,'mysql'),[]);
  assert.deepEqual(issues(forward,'mariadb'),[['sql.window.name','later']]);
  assert.deepEqual(issues('SELECT SUM(amount) OVER x FROM person WINDOW x AS (), x AS (ORDER BY id)'),
    [['sql.window.name.duplicate','x']]);
  assert.deepEqual(issues('SELECT id FROM person WHERE ROW_NUMBER() OVER (ORDER BY id)=1'),
    [['sql.window.location','OVER']]);
  assert.deepEqual(issues('SELECT id FROM person ORDER BY ROW_NUMBER() OVER (ORDER BY id)'),[]);
});

test('the supported window function grammar diagnoses arity and DISTINCT while retaining uncertainty for other providers', () => {
  assert.deepEqual(issues('SELECT ROW_NUMBER(id) OVER (), NTILE() OVER (), ROW_NUMBER() FROM person'),[
    ['sql.window.arity','ROW_NUMBER'],['sql.window.arity','NTILE'],['sql.window.required','ROW_NUMBER']
  ]);
  assert.deepEqual(issues('SELECT SUM(DISTINCT amount) OVER (ORDER BY id) FROM person'),[['sql.window.distinct','DISTINCT']]);
  const dynamic = run('SELECT SUM(amount) OVER (ORDER BY id ROWS ? PRECEDING) FROM person');
  assert.deepEqual(dynamic.diagnostics,[]);
  assert.ok(dynamic.coverage.unknown.some(item=>item.reason.includes('computed or compound frame offset')));
  const provider = run('SELECT foreign_window(id) OVER (ORDER BY id) FROM person');
  assert.equal(provider.state,'unknown');
  assert.deepEqual(provider.diagnostics,[]);
});
