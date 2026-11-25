'use strict';

const assert=require('node:assert/strict'),test=require('node:test');
const {analyzeSql}=require('../src/db/sql-analysis');

const catalog={database:'fixture',tables:[{name:'masks',columns:[
  {name:'one_byte',type:'binary(1)',nullable:false},{name:'two_bytes',type:'binary(2)',nullable:false},
  {name:'nullable_bytes',type:'binary(2)',nullable:true},{name:'variable',type:'varbinary(16)',nullable:false},
  {name:'flags',type:'bit(8)',nullable:false},{name:'id',type:'int',nullable:false},{name:'label',type:'varchar(16)',nullable:false}
]}],coverage:{tables:'loaded',columns:'loaded'}};
const run=(sql,dialect='mysql',sqlMode=[])=>analyzeSql(sql,catalog,{dialect,sqlMode});
const diags=(sql,dialect='mysql',sqlMode=[])=>run(sql,dialect,sqlMode).diagnostics.map(issue=>[
  issue.code,sql.slice(issue.start,issue.end),issue.severity
]);

test('binary context is specific to MySQL, actual BINARY widths and observed operand nullability',()=>{
  const sql='SELECT one_byte | two_bytes, one_byte ^ nullable_bytes, one_byte & NULL, one_byte | variable FROM masks';
  const mysql=run(sql),maria=run(sql,'mariadb');
  assert.deepEqual(mysql.projections.map(col=>col.type.family),['binary','binary','binary','binary']);
  assert.deepEqual(diags(sql),[['sql.bitwise.binaryLength','|','error'],['sql.bitwise.binaryLength','^','warning']]);
  assert.ok(mysql.coverage.unknown.some(item=>item.reason.includes('byte lengths')));
  assert.deepEqual(maria.projections.map(col=>col.type.family),['integer','integer','integer','integer']);
  assert.deepEqual(maria.diagnostics,[]);
  const indirect=run("WITH x AS (SELECT COALESCE(nullable_bytes,one_byte) AS mask FROM masks) SELECT x.mask | X'01' FROM x");
  assert.deepEqual(indirect.diagnostics,[]);
  assert.ok(indirect.coverage.unknown.some(item=>item.reason.includes('byte lengths')));
  const join='SELECT a.one_byte | b.two_bytes FROM masks a LEFT JOIN masks b ON b.id=a.id+3';
  assert.deepEqual(diags(join),[['sql.bitwise.binaryLength','|','warning']]);
});

test('binary introducers and BINARY casts retain fixed widths without interpreting contextual hex as plain text',()=>{
  const sql="SELECT X'40'|0x01, _binary X'40'|X'01', _binary 0x40|B'00000001', CAST('5' AS BINARY(1))|CAST('12' AS BINARY(2)), CAST(NULL AS BINARY(1))|CAST('12' AS BINARY(2))";
  assert.deepEqual(run(sql).projections.map(col=>col.type.family),['integer','binary','binary','binary','binary']);
  assert.deepEqual(diags(sql),[['sql.bitwise.binaryLength','|','error']]);
  assert.deepEqual(diags("SELECT _binary X'40' | X'0001'"),[['sql.bitwise.binaryLength','|','error']]);
  assert.deepEqual(diags("SELECT X'40' | 0x01",'mariadb'),[['sql.bitwise.coercion',"X'40'",'warning']]);
  assert.deepEqual(diags("SELECT X'FFFFFFFFFFFFFFFFFFFFFF'|X'1A'"),[['sql.bitwise.coercion',"X'FFFFFFFFFFFFFFFFFFFFFF'",'warning']]);
  assert.deepEqual(diags("SELECT X'0000000000000000000001'|X'1A'"),[]);
});

test('shift and count handlers distinguish binary result types from integer-valued count operands',()=>{
  const sql="SELECT ~one_byte, one_byte << 1, one_byte >> '2x', BIT_COUNT(one_byte), flags|one_byte FROM masks";
  assert.deepEqual(run(sql).projections.map(col=>col.type.family),['binary','binary','binary','integer','integer']);
  assert.deepEqual(run(sql,'mariadb').projections.map(col=>col.type.family),['integer','integer','integer','integer','integer']);
  for(const dialect of ['mysql','mariadb']) {
    assert.deepEqual(diags(sql,dialect),[['sql.bitwise.coercion',"'2x'",'warning']]);
    assert.deepEqual(diags('SELECT BIT_COUNT(), BIT_COUNT(id,id), BIT_COUNT(,id) FROM masks',dialect),
      Array.from({length:3},()=>['sql.bitwise.arity','BIT_COUNT','error']));
  }
});

test('proved coercions retain exact literal spans and distinguish decimal, exponent and trailing whitespace',()=>{
  const sql="SELECT ('12x') & 7, 'point' & 1, '' & 1, '12.5' & 7, '1e2' & 7, ' 12 ' & 7, BIT_COUNT('label'), '&' & 7";
  const warnings=value=>value.map(text=>['sql.bitwise.coercion',text,'warning']);
  assert.deepEqual(diags(sql),warnings(["'12x'","'point'","''","'12.5'","'1e2'","'label'","'&'"]));
  assert.deepEqual(diags(sql,'mariadb'),warnings(["'12x'","'point'","''","' 12 '","'label'","'&'"]));
  const dynamic=run("SELECT label & 1, BIT_COUNT(?), one_byte | ? FROM masks");
  assert.deepEqual(dynamic.diagnostics,[]);
  assert.ok(dynamic.coverage.unknown.some(item=>item.reason.includes('numeric conversion depends')));
  assert.ok(dynamic.coverage.unknown.some(item=>item.reason.includes('numeric or binary-string')));
});

test('operator precedence preserves signed/unary operands, arithmetic and comparable scoped references',()=>{
  const sql='SELECT id | flags & 1 << 2 AS a, id ^ -1 AS b, id + 1 & flags AS c, id | 2 ^ 7 * 3 AS d, id & 1 = 1 AS e FROM masks WHERE id & 1 = 1 AND id > 0';
  const model=run(sql);
  assert.equal(model.state,'known',JSON.stringify(model.coverage));
  assert.deepEqual(model.projections.map(col=>col.type.family),['integer','integer','integer','integer','boolean']);
  assert.ok(model.references.some(ref=>ref.kind==='column'&&ref.start===sql.indexOf('id & 1',sql.indexOf('WHERE'))));
  assert.equal(model.executedSql,false);
  const width='SELECT one_byte | two_bytes & two_bytes FROM masks';
  assert.deepEqual(diags(width),[['sql.bitwise.binaryLength','|','error']]);
  const broad=run('SELECT CASE WHEN id=1 THEN one_byte | two_bytes ELSE variable END FROM masks');
  assert.equal(broad.state,'unknown');
  assert.deepEqual(broad.diagnostics,[]);
});

test('bounded SQL source analysis does not prove runtime-driven binary modes',()=>{
  const source='SELECT '+Array.from({length:300},()=> '1').join(' | ');
  const model=run(source);
  assert.equal(model.state,'unknown');
  assert.deepEqual(model.diagnostics,[]);
});
