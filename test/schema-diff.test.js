'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeSnapshot,captureSchema,compareSnapshots,planMigration,validateMigrationPlan}=require('../src/db/schema-diff');
const {fixture,addColumn}=require('./helpers/schema-diff-fixture');
test('snapshots fingerprint canonical definitions and reject tampering or malformed fields',()=>{
 const a=fixture(),b=structuredClone(a);b.capturedAt='later';assert.equal(normalizeSnapshot(b).fingerprint,a.fingerprint);b.tables[0].columns[0].type='bigint';assert.throws(()=>normalizeSnapshot(b),/fingerprint/);
 const bad=structuredClone(a);bad.tables[0].indexes[0].columns[0].prefixLength='not-a-number';assert.throws(()=>normalizeSnapshot(bad,{verifyFingerprint:false}),/prefix/);
 bad.tables[0].indexes[0].columns[0].prefixLength=null;bad.server.port='bad';assert.throws(()=>normalizeSnapshot(bad,{verifyFingerprint:false}),/identity/);
});
test('additive nullable-column and nonunique index candidates require prerequisite selection',()=>{
 const current=fixture(),desired=addColumn(structuredClone(current));desired.tables[0].indexes.push({name:'note_index',unique:false,primaryKey:false,type:'BTREE',comment:'',columns:[{name:'note',ordinal:1,prefixLength:10,collation:'A'}]});const target=normalizeSnapshot(desired,{verifyFingerprint:false}),report=compareSnapshots(current,target);
 assert.equal(report.summary.selectable,2);const col=report.changes.find(c=>c.kind==='add-column'),index=report.changes.find(c=>c.kind==='add-index');assert.throws(()=>planMigration(current,target,{changeIds:[index.id]}),/prerequisite/);
 const plan=planMigration(current,target,{changeIds:[index.id,col.id]});assert.equal(plan.steps[0].kind,'add-column');assert.equal(plan.steps[1].kind,'add-index');assert.match(plan.sql,/`one`\.`people`/);assert.equal(plan.executesSql,false);assert.equal(plan.automaticApplyImplemented,false);assert.equal(plan.atomicAcrossSteps,false);assert.equal(validateMigrationPlan(plan,current).state,'fresh');
});
test('destructive, required-column, expression/default and unique-index changes are blocked',()=>{
 const source=fixture(),desired=addColumn(structuredClone(source),'required',{nullable:false});assert.equal(compareSnapshots(source,desired).changes.find(c=>c.kind==='add-column').selectable,false);
 const generated=addColumn(structuredClone(source),'generated',{generationExpression:'id+1',extra:'VIRTUAL GENERATED'});assert.equal(compareSnapshots(source,generated).summary.selectable,0);
 const defaulted=addColumn(structuredClone(source),'defaulted',{defaultValue:"x'); DROP TABLE people; --"});assert.equal(compareSnapshots(source,defaulted).summary.selectable,0);
 const dropped=fixture({tables:[]});const drop=compareSnapshots(source,dropped).changes[0];assert.equal(drop.kind,'drop-table');assert.equal(drop.selectable,false);assert.throws(()=>planMigration(source,dropped,{changeIds:[drop.id]}),/not supported/);
});
test('untrusted type text cannot become migration SQL and literal comments obey observed SQL mode',()=>{
 const source=fixture(),malicious=addColumn(structuredClone(source),'note',{type:'int); DROP TABLE people; --'});assert.equal(compareSnapshots(source,malicious).summary.selectable,0);
 const good=addColumn(structuredClone(source),'새`열',{comment:"quote' and \\ slash"}),change=compareSnapshots(source,good).changes.find(c=>c.kind==='add-column');assert.ok(change.sql.includes('`새``열`'));assert.ok(change.sql.includes("'quote'' and \\\\ slash'"));
 const nbs=structuredClone(source);nbs.server.sqlMode='NO_BACKSLASH_ESCAPES';const current=normalizeSnapshot(nbs,{verifyFingerprint:false}),target=addColumn(structuredClone(current),'note',{comment:"quote' and \\ slash"});assert.ok(compareSnapshots(current,target).changes[0].sql.includes("'quote'' and \\ slash'"));
});
test('cross-dialect or incomplete snapshots show differences but emit no migration candidates',()=>{
 const a=fixture(),b=addColumn(fixture({dialect:'mariadb'}));assert.equal(compareSnapshots(a,b).summary.selectable,0);
 const missing=addColumn(structuredClone(a));missing.coverage.foreignKeys='unavailable';const partial=normalizeSnapshot(missing,{verifyFingerprint:false});assert.equal(compareSnapshots(a,partial).coverage.complete,false);assert.equal(compareSnapshots(a,partial).summary.selectable,0);
});
test('migration reviews reject source drift, plan mutation and missing selected dependencies',()=>{
 const a=fixture(),b=addColumn(structuredClone(a)),report=compareSnapshots(a,b),plan=planMigration(a,b,{changeIds:[report.changes[0].id]});
 assert.throws(()=>validateMigrationPlan(plan,b),/changed/);const changed=structuredClone(plan);changed.steps[0].sql='DROP TABLE people';assert.throws(()=>validateMigrationPlan(changed,a),/plan changed/);
 const other=structuredClone(a);other.server.serverUniqueId='other-server';assert.throws(()=>validateMigrationPlan(plan,normalizeSnapshot(other,{verifyFingerprint:false})),/changed/);
});
test('simple missing InnoDB tables render quoted typed CREATE rather than replaying SHOW CREATE',()=>{
 const a=fixture({tables:[]}),b=fixture(),report=compareSnapshots(a,b);assert.equal(report.summary.selectable,1);const plan=planMigration(a,b,{changeIds:[report.changes[0].id]});assert.match(plan.steps[0].sql,/^CREATE TABLE `one`\.`people`/);assert.ok(plan.steps[0].sql.includes('PRIMARY KEY (`id`)'));assert.ok(!plan.steps[0].sql.includes('ROW_FORMAT='));
 const hostile=structuredClone(b);hostile.tables[0].engine='FEDERATED';const target=normalizeSnapshot(hostile,{verifyFingerprint:false});assert.equal(compareSnapshots(a,target).summary.selectable,0);
});
test('FK self-schema bindings normalize between databases and opaque definitions stay explicit',()=>{
 const a=fixture(),b=fixture({database:'two'});for(const s of [a,b])s.tables[0].foreignKeys=[{name:'same_fk',referencedSchema:s.database,referencedTable:'parent',onUpdate:'RESTRICT',onDelete:'RESTRICT',columns:[{name:'id',referencedColumn:'id',ordinal:1}]}];const left=normalizeSnapshot(a,{verifyFingerprint:false}),right=normalizeSnapshot(b,{verifyFingerprint:false});assert.equal(compareSnapshots(left,right).summary.changes,0);
 const opaque=structuredClone(left);opaque.tables[0].createSql+=' /*!80000 INVISIBLE */';const target=normalizeSnapshot(opaque,{verifyFingerprint:false});assert.equal(compareSnapshots(left,target).changes[0].kind,'change-object-definition');assert.equal(compareSnapshots(left,target).summary.selectable,0);
});

test('SHOW CREATE comparison ignores inherited encodings while preserving literal text and opaque attributes',()=>{
 let a=addColumn(fixture(),'note',{comment:'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'});a.tables[0].createSql="CREATE TABLE `people` (\n  `id` int NOT NULL,\n  `note` varchar(30) DEFAULT NULL COMMENT 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";a=normalizeSnapshot(a,{verifyFingerprint:false});
 const b=structuredClone(a);b.tables[0].createSql=b.tables[0].createSql.replace('varchar(30) DEFAULT','varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT');const desired=normalizeSnapshot(b,{verifyFingerprint:false});assert.notEqual(a.fingerprint,desired.fingerprint);assert.equal(compareSnapshots(a,desired).summary.changes,0);
 b.tables[0].createSql=b.tables[0].createSql.replace("COMMENT 'CHARACTER SET", "COMMENT 'literal CHARACTER SET");assert.equal(compareSnapshots(a,normalizeSnapshot(b,{verifyFingerprint:false})).changes[0].kind,'change-object-definition');
});

test('snapshot scope and Unicode validation reject ambiguous imported metadata',()=>{
 const snapshot=fixture();snapshot.scope.kind='guess';assert.throws(()=>normalizeSnapshot(snapshot,{verifyFingerprint:false}),/scope/);snapshot.scope={kind:'selected-tables',tables:['people','people']};assert.throws(()=>normalizeSnapshot(snapshot,{verifyFingerprint:false}),/Duplicate/);
 snapshot.scope={kind:'database',tables:['people']};assert.throws(()=>normalizeSnapshot(snapshot,{verifyFingerprint:false}),/partial/);snapshot.scope={kind:'database',tables:[]};snapshot.tables[0].comment='lone\ud800';assert.throws(()=>normalizeSnapshot(snapshot,{verifyFingerprint:false}),/comment/);
});

test('live metadata capture refuses concurrent definition changes and omits unsupported storage connection strings',async()=>{
 function service({engine='InnoDB',change=false}={}){let definitions=0;const statements=[];return {statements,async _metadataQuery(sql){statements.push(sql);let rows=[];if(sql.startsWith('SELECT VERSION()'))rows=[['8.4.13','localhost',3306,1,0,'STRICT_TRANS_TABLES','fixture@localhost','one']];else if(sql==='SELECT @@server_uuid')rows=[['owned-server']];else if(sql.startsWith('SELECT TABLE_NAME,TABLE_TYPE'))rows=[['people','BASE TABLE']];else if(sql.startsWith('SELECT t.TABLE_NAME'))rows=[['people','BASE TABLE',engine,'utf8mb4_bin',engine==='InnoDB'?'':'mysql://secret:password@other/db','Dynamic',engine==='InnoDB'?'':'CONNECTION=mysql://secret:password@other/db','utf8mb4']];else if(sql.startsWith('SHOW CREATE'))rows=[['people','CREATE TABLE `people` (`id` int NOT NULL) ENGINE=InnoDB'+(change&&++definitions>1?' COMMENT=\'changed\'':'')]];else if(sql.startsWith('SELECT COLUMN_NAME'))rows=[['id','int','NO',null,'','',1,'',null,null,'']];return {rows,truncated:false};}};}
 await assert.rejects(captureSchema(service({change:true})),/definition changed/);const unsupported=service({engine:'FEDERATED'}),snapshot=await captureSchema(unsupported);assert.equal(snapshot.coverage.definitions,'unavailable');assert.equal(snapshot.tables[0].createSql,'');assert.equal(snapshot.tables[0].comment,'');assert.equal(snapshot.tables[0].createOptions,'');assert.ok(!unsupported.statements.some(sql=>sql.startsWith('SHOW CREATE')));assert.ok(!JSON.stringify(snapshot).includes('secret:password'));
});

