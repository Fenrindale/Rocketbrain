'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {MysqlService}=require('../src/db/mysql'),{planCatalogDocumentRename,analyzeProjectDocument,referencesInDocument}=require('../src/db/sql-project');
const runtimeFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,runtime=runtimeFile?JSON.parse(fs.readFileSync(runtimeFile,'utf8')):null;
const configFile=runtime?.dbConfigPath||process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG||process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG;
const quote=value=>'`'+value.replaceAll('`','``')+'`';
test('physical SQL source plans preserve actual table/column query meaning across real MySQL/MariaDB DDL',{skip:!configFile&&'Use an owned MySQL/MariaDB or Spring fixture.',timeout:90000},async()=>{
 const config=JSON.parse(fs.readFileSync(configFile,'utf8')),connection=await require('mysql2/promise').createConnection({host:config.host,port:config.port,user:config.user,password:config.password,database:config.database,rowsAsArray:true}),service=new MysqlService(config),suffix=crypto.randomBytes(6).toString('hex'),table='rb_v10_source_'+suffix,renamed=table+'_new',other='rb_v10_other_'+suffix;
 const q=quote,stages=[];
 try{
  await connection.query('CREATE TABLE '+q(table)+' (id int PRIMARY KEY,label varchar(80) NOT NULL,amount int NOT NULL) ENGINE=InnoDB');await connection.query('CREATE TABLE '+q(other)+' (id int PRIMARY KEY,label varchar(80) NOT NULL) ENGINE=InnoDB');
  await connection.execute('INSERT INTO '+q(table)+' VALUES (?,?,?),(?,?,?)',[1,'Alex',10,2,'Mina',120]);await connection.execute('INSERT INTO '+q(other)+' VALUES (?,?)',[7,'Engineering']);
  let catalog=await service.metadata();const options={database:catalog.database,dialect:catalog.dialect,sqlMode:catalog.sqlMode,tableNameCaseSensitive:catalog.tableNameCaseSensitive,catalogComplete:true};
  const cases=[
   'SELECT '+q(table)+'.label AS stable FROM '+q(table)+' ORDER BY '+q(table)+'.id',
   'SELECT p.label AS stable FROM '+q(table)+' p WHERE EXISTS (SELECT 1 FROM '+q(other)+' p WHERE p.id>0) ORDER BY p.id',
   'WITH first AS (SELECT id,label FROM '+q(table)+'), second AS (SELECT f.id,f.label FROM first f) SELECT s.label FROM second s ORDER BY s.id',
   'SELECT d.label FROM (SELECT id,label FROM '+q(table)+') d ORDER BY d.id',
   'SELECT d.stable FROM (SELECT id,label AS stable FROM '+q(table)+') d ORDER BY d.id',
   'WITH x(identifier,title) AS (SELECT id,label FROM '+q(table)+') SELECT x.title FROM x ORDER BY x.identifier',
   'SELECT p.label AS stable FROM '+q(table)+' p UNION ALL SELECT d.label AS other_name FROM '+q(other)+' d ORDER BY stable',
   "SELECT p.label AS stable FROM "+q(table)+" p WHERE p.label<>'label' /* label stays */ ORDER BY p.id",
   'SELECT p.* FROM '+q(table)+' p ORDER BY p.id'
  ];
  let active=cases;
  for(const [kind,oldName,newName]of [['table',table,renamed],['column','label','새 이름`값']]){
   const target={kind,database:catalog.database,table:kind==='table'?table:renamed,...(kind==='column'?{column:oldName}:{})},plans=active.map(sql=>planCatalogDocumentRename(sql,catalog,options,target,newName)),before=[];
   for(const sql of active){const [rows,fields]=await connection.query(sql);before.push({rows,columns:fields.map(f=>f.name)});}
   const references=active.flatMap(sql=>referencesInDocument(analyzeProjectDocument(sql,catalog,options),target,options));assert.ok(references.length>=9);if(kind==='column')assert.ok(references.some(r=>r.kind==='wildcard'&&!r.editEligible));
   await connection.query(kind==='table'?'RENAME TABLE '+q(table)+' TO '+q(renamed):'ALTER TABLE '+q(renamed)+' RENAME COLUMN '+q(oldName)+' TO '+q(newName));
   const results=[];
   for(let i=0;i<plans.length;i++){const [rows,fields]=await connection.query(plans[i].resultText);assert.deepEqual(rows,before[i].rows,'case'+i+' '+kind);assert.equal(plans[i].verification.allOriginalBindingsPreserved,true);results.push({beforeSql:active[i],afterSql:plans[i].resultText,beforeColumns:before[i].columns,afterColumns:fields.map(f=>f.name),rows,edits:plans[i].edits,verification:plans[i].verification});}
   stages.push({kind,target,newName,implicitWildcardImpact:references.filter(r=>r.kind==='wildcard').length,cases:results});active=plans.map(p=>p.resultText);catalog=await service.metadata();
  }
  assert.equal((await connection.query('SELECT COUNT(*) FROM '+q(renamed)))[0][0][0],2);
  let isolation;if(runtime){isolation=await(await fetch(runtime.baseUrl+'/probe/testing-state')).json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});}
  const engine=runtime?.dbEngine||process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE||'mysql',report={asOf:new Date().toISOString(),version:'0.10.0',engine,naming:runtime?.naming||'standalone',stages,allRowsPreserved:true,implicitLabelsFollowPhysicalRename:true,unrelatedAliasContractsPreserved:true,isolation,scope:'Pure source planning executes no SQL. This test explicitly applies one table DDL and one column DDL to newly created owned tables and checks before/after query semantics.'};const serialized=JSON.stringify(report,null,2);assert.ok(!serialized.includes(config.password));fs.writeFileSync(path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-sql-project-'+engine+'-'+(runtime?.naming||'standalone')+'.json'),serialized+'\n');
 }finally{for(const name of [renamed,table,other])await connection.query('DROP TABLE IF EXISTS '+q(name)).catch(()=>{});await service.dispose();await connection.end();}
});
