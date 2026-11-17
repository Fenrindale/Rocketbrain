'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareSqlRename,planSqlRename,applySqlRename}=require('../src/db/sql-rename');
const catalog={database:'app',coverage:{tables:'loaded',columns:'loaded'},tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false},{name:'department_id',type:'bigint',nullable:false}]},{name:'departments',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false}]}]};
const options={dialect:'mysql',sqlMode:[],tableNameCaseSensitive:false};
const rename=(sql,needle,newName,within=0)=>planSqlRename(sql,catalog,options,sql.indexOf(needle)+within,newName);

test('relation alias rename follows correlated identity and leaves a nested shadow untouched',()=>{
  const sql="SELECT p.name FROM people p WHERE EXISTS (SELECT 1 FROM departments p WHERE p.name='p.name' AND EXISTS (SELECT 1 FROM people z WHERE z.department_id=p.id)) AND p.id>0 /* p */";
  const plan=rename(sql,'p.name','person');
  assert.equal(plan.resultText,"SELECT `person`.name FROM people `person` WHERE EXISTS (SELECT 1 FROM departments p WHERE p.name='p.name' AND EXISTS (SELECT 1 FROM people z WHERE z.department_id=p.id)) AND `person`.id>0 /* p */");
  assert.equal(plan.renamedBindings,3);assert.equal(plan.executedSql,false);assert.equal(plan.schemaMutation,false);assert.equal(plan.verification.allOriginalBindingsPreserved,true);assert.equal(applySqlRename(sql,plan.edits),plan.resultText);
});
test('renaming an outer alias updates actual correlated uses but rejects capture by an inner alias',()=>{
  const sql='SELECT p.name FROM people p WHERE EXISTS (SELECT 1 FROM departments d WHERE d.id=p.department_id)';
  assert.ok(rename(sql,'p.name','person').resultText.includes('d.id=`person`.department_id'));
  assert.throws(()=>rename(sql,'p.name','d'),error=>['SQL_RENAME_CAPTURE','SQL_RENAME_REBIND'].includes(error.code));
  const duplicate='SELECT p.name FROM people p JOIN departments d ON d.id=p.department_id';
  assert.throws(()=>rename(duplicate,'p.name','d'),error=>['SQL_RENAME_COLLISION','SQL_RENAME_REBIND'].includes(error.code));
});
test('CTE names rename their table and implicit qualifier uses while preserving explicit aliases',()=>{
  const sql='WITH chosen AS (SELECT id,name FROM people), next AS (SELECT c.id,c.name FROM chosen c) SELECT chosen.name FROM chosen JOIN next n ON n.id=chosen.id';
  const plan=rename(sql,'chosen AS','selected');
  assert.equal(plan.resultText,'WITH `selected` AS (SELECT id,name FROM people), next AS (SELECT c.id,c.name FROM `selected` c) SELECT `selected`.name FROM `selected` JOIN next n ON n.id=`selected`.id');
  assert.throws(()=>rename(sql,'chosen AS','next'),error=>error.code==='SQL_RENAME_COLLISION');
});
test('CTE name changes cannot capture an existing physical relation or a nested CTE',()=>{
  const physical='WITH chosen AS (SELECT id FROM departments) SELECT p.id,c.id FROM people p JOIN chosen c ON p.id=c.id';
  assert.throws(()=>rename(physical,'chosen AS','people'),error=>['SQL_RENAME_CAPTURE','SQL_RENAME_REBIND'].includes(error.code));
  const nested='WITH chosen AS (SELECT id FROM people) SELECT chosen.id FROM chosen WHERE EXISTS (WITH other AS (SELECT id FROM departments) SELECT 1 FROM other WHERE other.id=chosen.id)';
  assert.throws(()=>rename(nested,'chosen AS','other'),error=>['SQL_RENAME_CAPTURE','SQL_RENAME_REBIND'].includes(error.code));
});
test('explicit CTE output labels rename only their output contract and downstream references',()=>{
  const sql='WITH people_labels(person_id,label) AS (SELECT p.id,p.name FROM people p), chosen AS (SELECT x.person_id,x.label FROM people_labels x) SELECT c.label FROM chosen c ORDER BY c.person_id';
  const plan=rename(sql,'person_id,label','display_text','person_id,'.length);
  assert.equal(plan.resultText,'WITH people_labels(person_id,`display_text`) AS (SELECT p.id,p.name FROM people p), chosen AS (SELECT x.person_id,x.`display_text` FROM people_labels x) SELECT c.`display_text` FROM chosen c ORDER BY c.person_id');
  assert.throws(()=>rename(sql,'person_id,label','person_id','person_id,'.length),error=>error.code==='SQL_RENAME_COLLISION');
});
test('projection aliases propagate through pass-through CTEs and derived tables',()=>{
  const sql='WITH chosen AS (SELECT p.id,p.name AS label FROM people p) SELECT d.label FROM (SELECT c.id,c.label FROM chosen c) d ORDER BY d.label';
  const plan=rename(sql,'AS label','person_label',3);
  assert.equal(plan.resultText,'WITH chosen AS (SELECT p.id,p.name AS `person_label` FROM people p) SELECT d.`person_label` FROM (SELECT c.id,c.`person_label` FROM chosen c) d ORDER BY d.`person_label`');
});
test('implicit output rename introduces an explicit alias without changing physical column references',()=>{
  const sql='SELECT d.name FROM (SELECT p.id,p.name FROM people p) d ORDER BY d.name';
  const plan=rename(sql,'d.name','person_name',2);
  assert.equal(plan.implicit,true);assert.equal(plan.resultText,'SELECT d.`person_name` FROM (SELECT p.id,p.name AS `person_name` FROM people p) d ORDER BY d.`person_name`');
  const expression='SELECT d.`COUNT(*)` FROM (SELECT COUNT(*) FROM people p) d';
  assert.equal(rename(expression,'d.`COUNT','total',3).resultText,'SELECT d.`total` FROM (SELECT COUNT(*) AS `total` FROM people p) d');
});
test('UNION output rename follows first-arm ownership and preserves the second-arm alias',()=>{
  const sql='WITH combined AS (SELECT p.name AS label FROM people p UNION ALL SELECT d.name AS other_label FROM departments d) SELECT c.label FROM combined c ORDER BY c.label';
  const plan=rename(sql,'AS label','display_label',3);
  assert.ok(plan.resultText.includes('AS `display_label` FROM people'));assert.ok(plan.resultText.includes('AS other_label FROM departments'));assert.ok(plan.resultText.includes('SELECT c.`display_label`'));assert.ok(plan.resultText.endsWith('ORDER BY c.`display_label`'));
  const direct='SELECT id FROM people UNION ALL SELECT id FROM departments ORDER BY id';
  assert.equal(rename(direct,'ORDER BY id','identifier',9).resultText,'SELECT id AS `identifier` FROM people UNION ALL SELECT id FROM departments ORDER BY `identifier`');
});
test('quoted identifiers, reserved new names, case changes and UTF8 identifiers remain safely quoted',()=>{
  const sql='WITH `원본` AS (SELECT p.name AS `from` FROM people p) SELECT x.`from` FROM `원본` x ORDER BY x.`from`';
  const plan=rename(sql,'`from`','select',2);assert.ok(plan.resultText.includes('AS `select`'));assert.ok(plan.resultText.includes('x.`select`'));assert.equal(prepareSqlRename(sql,catalog,options,sql.indexOf('`from`')+1).name,'from');
  const doubled='SELECT `a``b`.id FROM people `a``b`';assert.equal(rename(doubled,'`a``b`.id','new alias',1).resultText,'SELECT `new alias`.id FROM people `new alias`');
  assert.equal(rename('SELECT P.id FROM people P','P.id','p').resultText,'SELECT `p`.id FROM people `p`');
  const ansi='SELECT "p".id FROM people "p"';assert.ok(planSqlRename(ansi,catalog,{...options,sqlMode:['ANSI_QUOTES']},ansi.indexOf('"p"')+1,'대상').resultText.includes('`대상`.id'));
});
test('rename refuses catalog mutation, comments, literals, partial input and ambiguous/recursive contracts',()=>{
  for(const [sql,needle]of [['SELECT p.name FROM people p','name'],['SELECT * FROM people','people'],["SELECT 'p.name' FROM people p",'p.name'],['SELECT p.name FROM people p /* p.name */','/* p.name'],['SELECT p. FROM people p','p.'],['WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<3) SELECT n FROM nums','nums(n)']])assert.throws(()=>rename(sql,needle,'changed'));
  const partial={tables:catalog.tables};assert.throws(()=>planSqlRename('SELECT p.name FROM people p',partial,options,7,'changed'),error=>error.code==='SQL_RENAME_UNCERTAIN');
});
test('colliding output aliases and MySQL GROUP/HAVING precedence are not rewritten speculatively',()=>{
  const sql='SELECT p.id AS person_id,p.name AS label FROM people p ORDER BY label';assert.throws(()=>rename(sql,'AS label','person_id',3),error=>error.code==='SQL_RENAME_COLLISION');
  const group='SELECT p.id AS label FROM people p GROUP BY label';assert.throws(()=>rename(group,'AS label','name',3),error=>error.code==='SQL_RENAME_PRECEDENCE');
  const originalAmbiguous='SELECT p.id AS name FROM people p GROUP BY name';assert.throws(()=>rename(originalAmbiguous,'AS name','label',3),error=>error.code==='SQL_RENAME_PRECEDENCE');
  assert.throws(()=>rename('SELECT id AS label,name AS label FROM people','AS label','renamed',3),error=>error.code==='SQL_RENAME_UNCERTAIN');
  assert.throws(()=>rename('WITH chosen(label,label) AS (SELECT id,name FROM people) SELECT 1 FROM chosen','label,label','renamed'),error=>error.code==='SQL_RENAME_UNCERTAIN');
});
test('invalid new names are rejected and a no-op creates no source edits',()=>{
  const sql='SELECT p.id FROM people p';for(const value of ['', 'x'.repeat(65),'a.b','bad\nname',' ending ','`quoted`','a\\b','😀'])assert.throws(()=>rename(sql,'p.id',value),error=>error.code==='SQL_RENAME_NAME');
  const plan=rename(sql,'p.id','p');assert.deepEqual(plan.edits,[]);assert.equal(plan.resultText,sql);
});
