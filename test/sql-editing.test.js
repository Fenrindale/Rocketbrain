'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {formatSql}=require('../src/db/sql-format');
const {templates,resolveTemplate}=require('../src/db/sql-templates');
const {sqlQuickFixes}=require('../src/db/sql-quick-fixes');

test('formats MySQL and MariaDB clause spacing without changing quoted text, comments or compound operators',()=>{
  const sample="SELECT p.id, 'literal FROM; where', p.payload->>'$.a' FROM person p /* keep WHERE */ LEFT OUTER JOIN dept d ON p.dept = d.id WHERE p.id >= 3 ORDER BY p.id;";
  for(const dialect of ['mysql','mariadb']) {
    const output=formatSql(sample,{dialect,indent:'    '});
    assert.equal(output,"SELECT p.id,\n    'literal FROM; where',\n    p.payload->>'$.a'\nFROM person p /* keep WHERE */ LEFT OUTER JOIN dept d\n    ON p.dept = d.id\nWHERE p.id >= 3\nORDER BY p.id;");
    assert.equal(formatSql(output,{dialect,indent:'    '}),output);
  }
});

test('keeps semicolons, CRLF, text quoting and statement boundaries exact',()=>{
  const sample="SELECT 1 FROM fixture WHERE value = 'it''s;''';\r\n-- second statement\r\nUPDATE fixture SET value = 'new' WHERE id = 1;\r\n";
  const after=formatSql(sample,{indent:'\t'});
  assert.equal(after,"SELECT 1\r\nFROM fixture\r\nWHERE value = 'it''s;''';\r\n-- second statement\r\nUPDATE fixture\r\nSET value = 'new'\r\nWHERE id = 1;\r\n");
  assert.equal(formatSql("DELIMITER $$\nCREATE PROCEDURE f() SELECT 'x'$$"),"DELIMITER $$\nCREATE PROCEDURE f() SELECT 'x'$$");
  assert.throws(()=>formatSql('SELECT (1 FROM fixture'),/parenthes(?:is|es)|lexical structure/);
});

test('SQL templates replace context with quoted snippet literals and preserve editable placeholders',()=>{
  const snapshot={database:'db',coverage:{tables:'loaded',columns:'loaded'},tables:[
    {name:'cost$test',columns:[{name:'key`field',primaryKey:true},{name:'amount$usd'}]}
  ]};
  const keyed=templates().find(item=>item.prefix==='rb-key');
  assert.equal(resolveTemplate(keyed,snapshot,'cost$test'),
    'SELECT `key``field`, `amount\\$usd`\nFROM `db`.`cost\\$test`\nWHERE `key``field` = ${1:0};');
  const [configured]=templates([{prefix:'rb-select',body:'SELECT ${columns} FROM ${relation}',description:'Overwrite format'}])
    .filter(item=>item.prefix==='rb-select');
  assert.equal(resolveTemplate(configured,snapshot,'cost$test'),
    'SELECT `key``field`, `amount\\$usd` FROM `db`.`cost\\$test`');
  assert.throws(()=>resolveTemplate(keyed,{...snapshot,coverage:{}},'cost$test'),/metadata/);
  assert.throws(()=>templates([{prefix:'bad',body:'one'},{prefix:'bad',body:'two'}]),/distinct/);
});

test('SQL quick fixes prove exact corrections and explicit choices against a bounded table catalog',()=>{
  const catalog={database:'demo',dialect:'mysql',coverage:{tables:'loaded',columns:'loaded'},tables:[
    {name:'person',columns:[{name:'id',type:'int'},{name:'department_id',type:'int'}]},
    {name:'dept',columns:[{name:'id',type:'int'}]}
  ]};
  const table='SELECT * FROM persom';
  assert.deepEqual(sqlQuickFixes(table,table.indexOf('persom'),catalog).map(item=>item.replacement),['`person`']);
  const column='SELECT p.department_ix FROM person p';
  assert.deepEqual(sqlQuickFixes(column,column.indexOf('department_ix'),catalog).map(item=>item.replacement),['`department_id`']);
  const ambiguous='SELECT id FROM person p JOIN dept d ON p.department_id=d.id';
  assert.deepEqual(sqlQuickFixes(ambiguous,ambiguous.indexOf('id'),catalog).map(item=>item.replacement),['`p`.`id`','`d`.`id`']);
  assert.deepEqual(sqlQuickFixes('USE unknown; '+column,50,catalog),[]);
  assert.deepEqual(sqlQuickFixes(column,column.indexOf('department_ix'),{...catalog,coverage:{}}),[]);
});

test('quick fixes bind the current statement, nested scope, and tables already introduced in an ON predicate',()=>{
  const catalog={database:'demo',dialect:'mysql',coverage:{tables:'loaded',columns:'loaded'},tables:['person','dept','later']
    .map(name=>({name,columns:[{name:'id',type:'int'},{name:'department_id',type:'int'}]}))};
  const script='SELECT 1;\r\nSELECT p.id FROM person p WHERE EXISTS ('+
    'SELECT |id FROM person p JOIN dept d ON p.department_id=d.id WHERE d.id>1);\r\nSELECT 2;';
  const options=text=>sqlQuickFixes(text.replace('|',''),text.indexOf('|'),catalog);
  const fixes=options(script);
  assert.deepEqual(fixes.map(item=>item.replacement),['`p`.`id`','`d`.`id`']);
  assert.ok(fixes.every(item=>item.start===script.indexOf('|')&&item.end===item.start+2));
  assert.deepEqual(options('SELECT p.id FROM person p JOIN dept d ON |id=1 JOIN later x ON x.id=d.id')
    .map(item=>item.replacement),['`p`.`id`','`d`.`id`']);
  assert.deepEqual(options('SELECT demo.|persom.id FROM demo.person').map(item=>item.replacement),['`person`']);
  assert.deepEqual(options('SELECT other.|persom.id FROM demo.person'),[]);
  assert.deepEqual(options('USE other; '+script),[]);
});
