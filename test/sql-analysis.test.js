'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {analyzeSql,completionsAt,definitionsAt,hoverAt,statementRanges}=require('../src/db/sql-analysis');
const {missingObjectIntent}=require('../src/db/sql-quick-fixes');
const catalog={database:'app',coverage:{tables:'loaded',columns:'loaded'},visibility:'current-account',tables:[
  {name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false},{name:'department_id',type:'bigint',nullable:false}]},
  {name:'departments',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(80)',nullable:false}]}
]};
test('missing object design intents use the selected statement and only unambiguous live schema targets',()=>{
  const intent=(source,word,metadata=catalog)=>missingObjectIntent(source,source.lastIndexOf(word),metadata);
  const absent=intent('SELECT 1; SELECT x.id FROM absent AS x','absent');
  assert.equal(absent?.missingTable,'absent');
  const column=intent('SELECT p.extra FROM people p JOIN departments d ON d.id=p.department_id','extra');
  assert.equal(column?.table,'people');
  assert.equal(column?.missingColumn,'extra');
  assert.equal(intent('SELECT extra FROM people p JOIN departments d ON d.id=p.department_id','extra'),null);
  assert.equal(intent('SELECT * FROM other.absent','absent'),null);
  assert.equal(intent('WITH local AS (SELECT 1 AS id) SELECT custom FROM local','custom'),null);
  assert.equal(intent('SELECT extra FROM people','extra',{...catalog,coverage:{columns:'partial',tables:'loaded'}}),null);
});
test('CTE chains, explicit output names and derived tables retain local definitions and projection types',()=>{
  const sql='WITH labels(person_id, label) AS (SELECT p.id, p.name FROM people p), chosen AS (SELECT l.person_id, l.label FROM labels l) SELECT d.label FROM (SELECT c.label FROM chosen c WHERE c.person_id > 0) d';
  const m=analyzeSql(sql,catalog);assert.equal(m.state,'known',JSON.stringify(m.coverage));assert.deepEqual(m.projections.map(p=>p.name),['label']);assert.equal(m.projections[0].type.family,'string');
  const local=definitionsAt(m,sql.indexOf('d.label')+3);assert.ok(local.length);assert.equal(sql.slice(local[0].start,local[0].end),'label');assert.match(hoverAt(m,sql.indexOf('d.label')+3),/string|varchar/);assert.equal(m.executedSql,false);assert.equal(m.validityVerified,false);assert.doesNotThrow(()=>JSON.stringify(m));
});
test('qualified completion traverses CTE and derived relation scopes without leaking unrelated tables',()=>{
  for(const sql of ['WITH x AS (SELECT id,name AS label FROM people) SELECT x.la FROM x','SELECT d.la FROM (SELECT name AS label FROM people) d']){
    const at=sql.indexOf('.la')+3,m=analyzeSql(sql,catalog),items=completionsAt(m,at);assert.deepEqual(items.map(i=>i.label),['label']);assert.equal(items[0].insertText,'`label`');
  }
});
test('nested aliases shadow correctly and correlated references resolve to the nearest visible outer scope',()=>{
  const sql='SELECT p.name FROM people p WHERE EXISTS (SELECT 1 FROM departments p WHERE p.name = \'Engineering\' AND EXISTS (SELECT 1 FROM people z WHERE z.department_id = p.id))';
  const m=analyzeSql(sql,catalog);assert.equal(m.state,'known',JSON.stringify(m));const inner=m.references.find(r=>r.start===sql.lastIndexOf('p.id')+2&&r.kind==='column');assert.equal(inner.catalog.table,'departments');assert.equal(inner.correlated,true);
  const unqualified=analyzeSql('SELECT p.name FROM people p WHERE EXISTS (SELECT 1 WHERE department_id = p.id)',catalog);assert.equal(unqualified.state,'known');assert.ok(unqualified.references.some(r=>r.name==='department_id'&&r.correlated===true));
});
test('unknown columns and ambiguous joins map exact diagnostic source ranges',()=>{
  const sql='SELECT\n  missing_column\nFROM people p';const m=analyzeSql(sql,catalog);assert.equal(m.state,'invalid');const d=m.diagnostics.find(d=>d.code==='sql.name.column');assert.equal(sql.slice(d.start,d.end),'missing_column');assert.deepEqual(d.range.start,{line:1,character:2});
  const ambiguous=analyzeSql('SELECT id FROM people p JOIN departments d ON p.department_id=d.id',catalog);assert.equal(ambiguous.state,'invalid');assert.ok(ambiguous.diagnostics.some(d=>d.code==='sql.name.ambiguous'));
});
test('partial catalogs and cross-database objects cannot establish missing-name errors',()=>{
  for(const [sql,cat]of [['SELECT p.missing FROM people p',{tables:catalog.tables}],['SELECT x.missing FROM other.people x',catalog],['SELECT name FROM not_visible',catalog]]){
    const m=analyzeSql(sql,cat);assert.equal(m.state,'unknown',JSON.stringify(m));assert.equal(m.diagnostics.some(d=>d.severity==='error'),false);
  }
});
test('UNION names follow the first arm, numeric types merge and arity mismatches are proven',()=>{
  const m=analyzeSql('SELECT id AS value FROM people UNION ALL SELECT id FROM departments',catalog);assert.equal(m.state,'known');assert.equal(m.projections[0].name,'value');assert.equal(m.projections[0].type.family,'integer');
  const invalid=analyzeSql('SELECT id,name FROM people UNION SELECT id FROM departments',catalog);assert.equal(invalid.state,'invalid');assert.ok(invalid.diagnostics.some(d=>d.code==='sql.shape.union'));
  const mixed=analyzeSql('SELECT id FROM people UNION ALL SELECT name FROM departments',catalog);assert.equal(mixed.state,'unknown');assert.equal(mixed.diagnostics.some(d=>d.severity==='error'),false);
  const globalOrder=analyzeSql('SELECT id AS first_id FROM people UNION ALL SELECT id AS second_id FROM departments ORDER BY first_id',catalog);assert.equal(globalOrder.state,'known',JSON.stringify(globalOrder));assert.ok(globalOrder.references.some(r=>r.name==='first_id'&&r.kind==='projection'));
});
test('recursive CTEs expose anchor columns but retain recursion/growth uncertainty',()=>{
  const sql='WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<3) SELECT n FROM nums';const m=analyzeSql(sql,catalog);assert.equal(m.state,'unknown');assert.equal(m.projections[0].name,'n');assert.equal(m.projections[0].type.family,'integer');assert.ok(m.coverage.supported.includes('recursive-cte-anchor'));assert.equal(m.diagnostics.length,0);
});
test('MySQL string/numeric implicit conversions are not rejected using Java type rules',()=>{
  for(const sql of ["SELECT name + 1 FROM people","SELECT id FROM people WHERE name > 1","SELECT SUM(name) FROM people","SELECT 1 UNION SELECT 'abc'"]){const m=analyzeSql(sql,catalog);assert.notEqual(m.state,'invalid',JSON.stringify(m));assert.equal(m.diagnostics.some(d=>d.severity==='error'),false);}
  const numeric=analyzeSql('SELECT id+1 AS value,COUNT(*) AS total,LOWER(name) AS lower_name FROM people GROUP BY id,name',catalog);assert.equal(numeric.state,'known',JSON.stringify(numeric));assert.deepEqual(numeric.projections.map(p=>p.type.family),['integer','integer','string']);
  const wrongArity=analyzeSql('SELECT LOWER(id,name) FROM people',catalog);assert.equal(wrongArity.state,'invalid');assert.ok(wrongArity.diagnostics.some(d=>d.code==='sql.function.arity'));
  const emptyAggregate=analyzeSql('SELECT MAX(id) AS maximum,COUNT(*) AS total FROM people WHERE id<0',catalog);assert.equal(emptyAggregate.projections[0].type.nullable,true);assert.equal(emptyAggregate.projections[1].type.nullable,false);
});
test('SQL mode is explicit and quotes/comments do not invent references or completions',()=>{
  const sql='SELECT "name" FROM people';assert.equal(analyzeSql(sql,catalog).state,'unknown');assert.equal(analyzeSql(sql,catalog,{sqlMode:['ANSI_QUOTES']}).state,'known');assert.equal(analyzeSql(sql,catalog,{sqlMode:[]}).projections[0].type.family,'string');
  for(const sql of ["SELECT 'p.name' FROM people p",'SELECT 1 /* p.name */ FROM people p']){const m=analyzeSql(sql,catalog);assert.deepEqual(completionsAt(m,sql.indexOf('p.name')+6),[]);assert.ok(!m.references.some(r=>r.name==='name'));}
  assert.equal(analyzeSql("SELECT 'a\\b'",catalog).state,'unknown');
  const uncertain=analyzeSql('SELECT missing_column,"ambiguous" FROM people',catalog);assert.equal(uncertain.state,'unknown');assert.equal(uncertain.diagnostics.some(d=>d.severity==='error'),false);
  const literal=analyzeSql("SELECT 'FROM' AS keyword,',' AS comma,'(' AS paren,';' AS delimiter",catalog);assert.equal(literal.state,'known',JSON.stringify(literal));assert.equal(literal.projections.length,4);
  const quoted=analyzeSql('SELECT p.`name` AS `from` FROM `people` p ORDER BY `from`',catalog);assert.equal(quoted.state,'known',JSON.stringify(quoted));assert.equal(quoted.projections[0].name,'from');
});
test('unknown function/table syntax and executable comments remain explicitly uncertain',()=>{
  for(const sql of ['SELECT custom_provider(id) FROM people','SELECT * FROM JSON_TABLE(\'{}\',\'$\' COLUMNS(x int PATH \'$.x\')) jt','SELECT 1 /*! UNION SELECT 2 */','UPDATE people SET name=\'x\'']){const m=analyzeSql(sql,catalog);assert.equal(m.state,'unknown',JSON.stringify(m));assert.equal(m.validityVerified,false);assert.equal(m.executedSql,false);}
  for(const sql of ["SELECT name COLLATE utf8mb4_bin FROM people","SELECT BINARY name FROM people","SELECT JSON_VALUE(name,'$.x' RETURNING CHAR) FROM people","SELECT 'a'||'b'","SELECT CASE WHEN id=1 THEN name & id END FROM people"]){const m=analyzeSql(sql,catalog);assert.equal(m.state,'unknown',JSON.stringify(m));assert.equal(m.diagnostics.length,0);}
  const unprovedWindow=analyzeSql('SELECT SUM(id) OVER (ORDER BY id GROUPS 1 PRECEDING) FROM people',catalog);assert.equal(unprovedWindow.state,'unknown');assert.equal(unprovedWindow.diagnostics.length,0);
  assert.equal(analyzeSql('SELECT DISTINCTROW name FROM people',catalog).state,'known');
});
test('statement ranges preserve original offsets and honor SQL-mode quote interpretation',()=>{
  const text="SELECT ';' AS value;\n-- ; comment\nSELECT 2;";const x=statementRanges(text,{sqlMode:[]});assert.equal(x.statements.length,2);assert.equal(text.slice(x.statements[1].start,x.statements[1].end),'\n-- ; comment\nSELECT 2;');assert.equal(x.unknown.length,0);
  const ambiguous=statementRanges('SELECT "x;y";SELECT 2');assert.equal(ambiguous.unknown.length,1);assert.equal(ambiguous.statements.length,2);
});
test('bounded partial editing produces useful completion without false qualified-name errors',()=>{
  const sql='WITH x AS (SELECT id,name AS label FROM people) SELECT x. FROM x';const m=analyzeSql(sql,catalog);assert.equal(m.state,'unknown');assert.equal(m.diagnostics.length,0);assert.deepEqual(completionsAt(m,sql.indexOf('x.')+2).map(i=>i.label).sort(),['id','label']);
  assert.equal(analyzeSql('x'.repeat(140000),catalog).state,'unknown');assert.equal(analyzeSql('SELECT (',catalog).state,'unknown');
});
