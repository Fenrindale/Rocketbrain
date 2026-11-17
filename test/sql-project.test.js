'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {analyzeProjectDocument,referencesInDocument,planCatalogDocumentRename,targetAtDocument}=require('../src/db/sql-project');
const catalog={database:'app',coverage:{tables:'loaded',columns:'loaded'},tables:[{name:'people',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(100)',nullable:false},{name:'department_id',type:'bigint',nullable:false}]},{name:'departments',columns:[{name:'id',type:'bigint',nullable:false},{name:'name',type:'varchar(80)',nullable:false}]}]};
const options={database:'app',sqlMode:[],tableNameCaseSensitive:false,catalogComplete:true};
const table={kind:'table',database:'app',table:'people'},column={...table,kind:'column',column:'name'};
const plan=(sql,target=column,name='label')=>planCatalogDocumentRename(sql,catalog,options,target,name);
test('physical table rename follows unaliased qualifiers, schema-qualified tables and correlations without alias capture',()=>{
 const sql="SELECT people.name FROM app.people WHERE EXISTS (SELECT 1 FROM departments d WHERE d.id=people.department_id); SELECT p.name FROM people p WHERE p.name<>'people' /* people */";
 const value=plan(sql,table,'persons');assert.equal(value.edits.length,4);assert.equal(value.resultText,"SELECT `persons`.name FROM app.`persons` WHERE EXISTS (SELECT 1 FROM departments d WHERE d.id=`persons`.department_id); SELECT p.name FROM `persons` p WHERE p.name<>'people' /* people */");assert.equal(value.verification.allOriginalBindingsPreserved,true);
});
test('physical column references preserve scope shadowing, comments and identically named unrelated table columns',()=>{
 const sql="SELECT p.name FROM people p WHERE EXISTS (SELECT 1 FROM departments p WHERE p.name='name') AND p.name<>'p.name' /* p.name */";
 const value=plan(sql);assert.equal(value.edits.length,2);assert.equal(value.resultText,"SELECT p.`label` FROM people p WHERE EXISTS (SELECT 1 FROM departments p WHERE p.name='name') AND p.`label`<>'p.name' /* p.name */");
});
test('physical column names propagate only through implicit CTE/derived output contracts',()=>{
 const sql='WITH first AS (SELECT name FROM people), second AS (SELECT f.name FROM first f) SELECT d.name FROM (SELECT s.name FROM second s) d ORDER BY d.name';const value=plan(sql);assert.equal(value.edits.length,5);assert.equal(value.resultText,'WITH first AS (SELECT `label` FROM people), second AS (SELECT f.`label` FROM first f) SELECT d.`label` FROM (SELECT s.`label` FROM second s) d ORDER BY d.`label`');
 const fixed='WITH first(title) AS (SELECT name FROM people) SELECT d.title FROM (SELECT f.title FROM first f) d';assert.equal(plan(fixed).resultText,'WITH first(title) AS (SELECT `label` FROM people) SELECT d.title FROM (SELECT f.title FROM first f) d');
 const alias='SELECT d.name FROM (SELECT name AS name FROM people) d';assert.equal(plan(alias).resultText,'SELECT d.name FROM (SELECT `label` AS name FROM people) d');
});
test('UNION outputs follow first-arm identity and do not rename unrelated arm expressions',()=>{
 const sql='WITH x AS (SELECT name FROM people UNION ALL SELECT name FROM departments) SELECT x.name FROM x ORDER BY x.name';assert.equal(plan(sql).resultText,'WITH x AS (SELECT `label` FROM people UNION ALL SELECT name FROM departments) SELECT x.`label` FROM x ORDER BY x.`label`');
 const otherFirst='WITH x AS (SELECT name FROM departments UNION ALL SELECT name FROM people) SELECT x.name FROM x';assert.equal(plan(otherFirst).resultText,'WITH x AS (SELECT name FROM departments UNION ALL SELECT `label` FROM people) SELECT x.name FROM x');
});
test('wildcard uses are reported as implicit impact without replacing the star',()=>{
 const sql='SELECT p.* FROM people p; SELECT d.name FROM (SELECT * FROM people) d',report=analyzeProjectDocument(sql,catalog,options),refs=referencesInDocument(report,column,options);assert.equal(refs.filter(r=>r.kind==='wildcard').length,2);assert.ok(refs.filter(r=>r.kind==='wildcard').every(r=>r.editEligible===false));const value=plan(sql);assert.equal(value.edits.length,1);assert.equal(value.resultText,'SELECT p.* FROM people p; SELECT d.`label` FROM (SELECT * FROM people) d');
});
test('physical source rename rejects table/column collisions and CTE or relation alias capture',()=>{
 assert.throws(()=>plan('SELECT p.name FROM people p',table,'departments'),/already exists/);
 assert.throws(()=>plan('SELECT p.name FROM people p',column,'id'),/already exists/);
 assert.throws(()=>plan('WITH persons AS (SELECT name FROM departments) SELECT name FROM people',table,'persons'),/binding|reference/i);
 assert.throws(()=>plan('SELECT people.name FROM people JOIN departments persons ON people.department_id=persons.id',table,'persons'),/invalid|captur/i);
});
test('ambiguous unqualified names and GROUP/HAVING precedence do not produce speculative edits',()=>{
 assert.throws(()=>plan('SELECT id FROM people p JOIN departments d ON p.department_id=d.id'),/Unsupported/);
 assert.throws(()=>plan('SELECT p.name AS id FROM people p GROUP BY id'),/Unsupported/);
});
test('DDL, variables, unsupported functions, recursive and foreign-database SQL make coverage incomplete',()=>{
 for(const sql of ['ALTER TABLE people ADD x int; SELECT name FROM people','SELECT name FROM people WHERE id=?','SELECT provider(name) FROM people','WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<2) SELECT n FROM x','SELECT people.name FROM other.people','SELECT other.people.name FROM people','SELECT app.p.name FROM people p']){const report=analyzeProjectDocument(sql,catalog,options);assert.equal(report.state,'partial',sql);assert.throws(()=>plan(sql),/Unsupported/);}
});
test('reserved, escaped and Unicode physical names are quoted while values remain untouched',()=>{
 const sql="SELECT name FROM people WHERE name <> 'name'";for(const name of ['from','제목','a`b']){const value=plan(sql,column,name);assert.ok(value.resultText.includes('`'+name.replaceAll('`','``')+'`'));assert.ok(value.resultText.includes("'name'"));}
 assert.equal(plan('SELECT name FROM people',column,'name').edits.length,0);
 for(const name of ['', ' app','a.b','a\u0000b','𐐀'])assert.throws(()=>plan('SELECT name FROM people',column,name));
});
test('catalog target selection distinguishes physical identifiers and explicitly local aliases',()=>{
 const text='WITH x AS (SELECT p.name AS title FROM people p) SELECT x.title FROM x',report=analyzeProjectDocument(text,catalog,options);
 assert.equal(targetAtDocument(report,text.indexOf('p.name')+2).kind,'column');assert.equal(targetAtDocument(report,text.indexOf('people')).kind,'table');assert.equal(targetAtDocument(report,text.indexOf('x.title')+2).kind,'local');assert.equal(targetAtDocument(report,text.indexOf('people p')+7).kind,'local');
});
test('a fully qualified column renames only its observed database/table component',()=>{
 const sql='SELECT app.people.name FROM app.people';assert.equal(plan(sql).resultText,'SELECT app.people.`label` FROM app.people');assert.equal(plan(sql,table,'persons').resultText,'SELECT app.`persons`.name FROM app.`persons`');
});
