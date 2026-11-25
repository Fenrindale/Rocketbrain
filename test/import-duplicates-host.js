'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {MysqlService}=require('../src/db/mysql');
const {StreamImporter}=require('../src/db/import-stream');
const {owned}=require('./schema-stored-diff-host');
const {jdbcReadback}=require('./java-source-analysis-host');

const mapping=['id','label','parent_id'].map((target,source)=>({source,target}));
const makeRows=(offset,count)=>Array.from({length:count},(_,i)=>[offset+i,'source-'+(offset+i),1]);

async function verifyImportDuplicates(adapter) {
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const {actor,config,version}=await owned(runtime.dbConfigPath);
  const suffix=randomBytes(5).toString('hex');
  const table='rb_dup_'+suffix,parent='rb_dup_parent_'+suffix;
  let folder,file,connected=false;
  try {
    folder=await fs.mkdtemp(path.join(os.tmpdir(),'rb-duplicate-import-'));
    file=path.join(folder,'owned.csv');
    await actor.query('CREATE TABLE '+parent+' (id INT PRIMARY KEY) ENGINE=InnoDB');
    await actor.query('INSERT INTO '+parent+' VALUES (1)');
    await actor.query('CREATE TABLE '+table+' (id INT PRIMARY KEY, label VARCHAR(40) UNIQUE, parent_id INT NOT NULL,'+
      ' FOREIGN KEY (parent_id) REFERENCES '+parent+' (id)) ENGINE=InnoDB');
    await actor.query('INSERT INTO '+table+" VALUES (1,'protected',1)");
    const read=async()=> (await actor.query('SELECT id,label FROM '+table+' ORDER BY id'))[0].map(row=>[row.id,row.label]);
    const before=await read();
    await adapter.connect(config);
    connected=true;
    const prepare=options=>adapter.prepare({file,format:'csv',hasHeader:true,table,mapping,...options});
    const save=rows=>fs.writeFile(file,'id,label,parent_id\n'+rows.map(row=>row.join(',')).join('\n')+'\n','utf8');
    const rows=makeRows(2,205);
    rows[101]=[1,'primary-conflict',1];
    rows[102][1]='protected';
    rows[103][1]='source-2';
    await save(rows);
    await assert.rejects(prepare({duplicatePolicy:'replace'}),/Abort on duplicate key/);
    let plan=await prepare();
    assert.equal(plan.duplicatePolicy,'abort');
    const failed=await adapter.run(plan.reviewId);
    assert.equal(failed.state,'failed');
    assert.equal(failed.error.code,'ER_DUP_ENTRY');
    assert.equal(failed.rows,100);
    assert.equal(failed.rolledBack,true);
    assert.deepEqual(await read(),before);
    plan=await prepare({duplicatePolicy:'skip'});
    assert.equal(plan.duplicatePolicy,'skip');
    await adapter.preview?.(plan);
    const pending=await adapter.run(plan.reviewId);
    assert.equal(pending.state,'awaiting-commit',JSON.stringify(pending));
    assert.equal(pending.rows,205);
    assert.equal(pending.insertedRows,202);
    assert.equal(pending.duplicateRows,3);
    assert.equal(pending.batches,3);
    assert.deepEqual(await read(),before);
    const committed=await adapter.commit(pending.transactionId);
    assert.equal(committed.state,'committed');
    assert.equal(committed.insertedRows,202);
    assert.equal(committed.duplicateRows,3);
    await adapter.outcome?.(committed);
    const persisted=await read();
    assert.deepEqual(persisted,[...before,...rows.filter((_,i)=>i<101||i>103).map(([id,label])=>[id,label])]);

    const invalid=makeRows(1000,107);
    invalid[102]=[1,'primary-conflict',1];
    invalid[104][2]=999;
    await save(invalid);
    plan=await prepare({duplicatePolicy:'skip'});
    const rejected=await adapter.run(plan.reviewId);
    assert.equal(rejected.state,'failed');
    assert.equal(rejected.error.code,'ER_NO_REFERENCED_ROW_2');
    assert.equal(rejected.rows,100);
    assert.equal(rejected.rolledBack,true);
    assert.deepEqual(await read(),persisted);

    const cancelledRows=makeRows(2000,220);
    cancelledRows[2]=[1,'primary-conflict',1];
    await save(cancelledRows);
    plan=await prepare({duplicatePolicy:'skip'});
    const cancellation=new AbortController();
    const cancelled=await adapter.run(plan.reviewId,{cancellation:cancellation.signal,
      onProgress:progress=>{if(progress.rows>=100)cancellation.abort();}});
    assert.equal(cancelled.state,'cancelled');
    assert.equal(cancelled.insertedRows,99);
    assert.equal(cancelled.duplicateRows,1);
    assert.equal(cancelled.rolledBack,true);
    assert.deepEqual(await read(),persisted);
    const jdbc=await jdbcReadback();
    return {engine:runtime.dbEngine,version,jdbc,abortedWholeOnDuplicate:true,firstWins:true,
      insertedRows:202,duplicateRows:3,batches:3,invisibleBeforeCommit:true,nonDuplicateErrorRolledBack:true,cancelRolledBack:true};
  } finally {
    try { if(connected)await adapter.disconnect(); }
    finally {
      try { await actor.query('DROP TABLE IF EXISTS '+table);await actor.query('DROP TABLE IF EXISTS '+parent); }
      finally {
        await actor.end();
        if(file)await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
        if(folder)await fs.rmdir(folder);
      }
    }
  }
}

async function verifyImportDuplicatesBackend() {
  let db,importer;
  return verifyImportDuplicates({
    connect(config){db=new MysqlService(config);importer=new StreamImporter(db);},
    async disconnect(){try{await importer.dispose();}finally{await db.dispose();}},
    prepare:input=>importer.prepare(input),run:(reviewId,options)=>importer.run({reviewId,...options}),
    commit:transactionId=>importer.commit({transactionId})
  });
}

async function runImportDuplicateChecks(api,vscode,checks) {
  const tools=api.streamImports;
  const proof=await verifyImportDuplicates({
    connect:config=>api.connectMysql(config),
    async disconnect(){for(const item of await tools.pending())await tools.rollback(item.transactionId);await api.disconnectMysql();},
    prepare:tools.prepare,run:tools.run,commit:tools.commit,
    async preview(plan){
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-stream-import:/'+plan.reviewId+'/review.sql'));
      assert.match(document.getText(),/Duplicate-key policy: Skip duplicate rows/);
      assert.equal(document.isDirty,false);
    },
    async outcome(report){
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-stream-import:/'+report.transactionId+'/outcome.md'));
      assert.match(document.getText(),/Insertions before transaction finish: 202; duplicates skipped: 3/);
    }
  });
  checks.push('The installed streaming review bound the selected duplicate policy, preserved the first rows and rolled back all batches on other errors and cancellation.');
  return {...proof,nativeDuplicateReview:true};
}

module.exports={verifyImportDuplicatesBackend,runImportDuplicateChecks};
if(require.main===module)verifyImportDuplicatesBackend().then(proof=>console.log(JSON.stringify(proof)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
