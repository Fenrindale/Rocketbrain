'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto'),mysql=require('mysql2/promise');
const {JOURNAL}=require('../src/db/object-editor');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const flags={allowImplicitCommit:true,allowEventDeployment:true};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function verifyEventDeployment(runtime,adapter) {
  const config=await read(runtime.dbConfigPath),folder=path.dirname(await fs.realpath(runtime.dbConfigPath));
  const marker=await read(path.join(folder,'owner.json'));
  assert.equal(marker.kind,runtime.dbEngine==='mariadb'?'RocketbrainDisposableMariaDbFixture-v1':'RocketbrainDisposableOracleMysqlFixture-v1');
  assert.equal(marker.id,path.basename(folder));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const actor=await mysql.createConnection({...config,dateStrings:true}),tag=randomBytes(5).toString('hex');
  const name='rb_event_'+tag,table='rb_event_rows_'+tag,control='rb_event_control_'+tag,probe='rb_event_scheduler_'+tag,once='rb_event_once_'+tag;
  const operations=new Set();
  const review=async (model,body)=>{
    const result=await adapter.review(model,body);
    operations.add(result.operationId);
    return result;
  };
  async function journalState() {
    const [[{num}]]=await actor.execute('SELECT COUNT(*) AS num FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[JOURNAL]);
    if(Number(num)===0) return {present:false,entries:0};
    const [[count]]=await actor.query('SELECT COUNT(*) AS entries FROM '+JOURNAL);
    return {present:true,entries:Number(count.entries)};
  }
  const oldBody="INSERT INTO "+table+"(id,label) VALUES(101,'prior')";
  const newBody="BEGIN INSERT INTO "+table+"(id,label) VALUES(701,'approved'); END";
  const observed=async event=>{
    const [[row]]=await actor.execute('SELECT EVENT_DEFINITION,DEFINER,TIME_ZONE,EVENT_TYPE,EXECUTE_AT,INTERVAL_VALUE,INTERVAL_FIELD,'+
      'STARTS,ENDS,STATUS,ON_COMPLETION,SQL_MODE,EVENT_COMMENT,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,CREATED,LAST_EXECUTED '+
      'FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() AND EVENT_NAME=?',[event]);return row;
  };
  const values=async()=> (await actor.query('SELECT id,label FROM '+table+' ORDER BY id'))[0].map(row=>[Number(row.id),row.label]);
  try {
    const [[{datadir}]]=await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(),folder.toLowerCase());
    const spring=await adapter.probe();
    assert.equal(spring.people,2);
    await actor.query('CREATE TABLE '+table+' (id INT PRIMARY KEY,label VARCHAR(30) NOT NULL) ENGINE=InnoDB');
    await actor.query("SET SESSION time_zone='-03:00'");
    await actor.query("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'");
    await actor.query('CREATE DEFINER=CURRENT_USER EVENT '+name+" ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 30 DAY"+
      " ENDS CURRENT_TIMESTAMP + INTERVAL 60 DAY ON COMPLETION PRESERVE DISABLE COMMENT 'original DO marker' DO "+oldBody);
    await actor.query('CREATE DEFINER=CURRENT_USER EVENT '+control+" ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY ON COMPLETION PRESERVE ENABLE DO "+oldBody);
    await actor.query('CREATE DEFINER=CURRENT_USER EVENT '+once+' ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 10 DAY ON COMPLETION PRESERVE DISABLE DO '+oldBody);
    const original=await observed(name),originalOnce=await observed(once);
    assert.equal(original.TIME_ZONE,'-03:00');
    assert.equal(original.SQL_MODE,'NO_BACKSLASH_ESCAPES');
    assert.equal(original.STATUS,'DISABLED');

    await adapter.connect(config);
    assert.ok((await adapter.list()).some(item=>item.kind==='event'&&item.name===name));
    await assert.rejects(adapter.open(control),/disabled SQL event/);
    const model=await adapter.open(name);
    assert.equal(model.source,original.EVENT_DEFINITION);
    assert.equal(model.schedule.zone,'-03:00');
    assert.equal(model.validationCreatesOwnedObject,false);
    await adapter.assertRunRefused?.(model);
    await assert.rejects(review(model,'DELETE FROM other_schema.'+table+' WHERE id=1'),/same-schema/);
    await assert.rejects(review(model,'UPDATE '+table+' SET missing=1 WHERE id=1'),/missing or unsupported target column/);
    await assert.rejects(review(model,'CALL unreviewed()'),/Only bounded|Use an INSERT/);
    const beforeJournal=await journalState();
    const checked=await review(model,newBody);
    assert.deepEqual(checked.validation,{parsed:true,targetsVerified:true,compiled:false,executed:false,createdObject:false});
    assert.equal(checked.schedule.intervalField,'DAY');
    assert.match(checked.sql,/ALTER DEFINER = CURRENT_USER EVENT .* DISABLE DO BEGIN/);
    assert.doesNotMatch(checked.sql,/\b(?:DROP EVENT|CREATE EVENT|ON SCHEDULE|ENABLE)\b/);
    await adapter.assertReviewDocument?.(model,checked);
    assert.deepEqual(await journalState(),beforeJournal);
    assert.deepEqual(await observed(name),original);
    assert.deepEqual(await values(),[]);
    await assert.rejects(adapter.apply(model,checked,{allowImplicitCommit:true}),/Acknowledge the reviewed ALTER EVENT/);

    const stale=await review(model,newBody);
    await actor.query('ALTER DEFINER=CURRENT_USER EVENT '+name+" COMMENT 'changed elsewhere'");
    await assert.rejects(adapter.apply(model,stale,flags),/changed after review/);
    assert.equal((await observed(name)).EVENT_DEFINITION,original.EVENT_DEFINITION);
    await actor.query('ALTER DEFINER=CURRENT_USER EVENT '+name+" COMMENT 'original DO marker'");
    const staleTable=await adapter.open(name), changedTable=await review(staleTable,newBody);
    await actor.query('ALTER TABLE '+table+' ADD COLUMN stale_flags INT');
    await assert.rejects(adapter.apply(staleTable,changedTable,flags),/changed after review/);
    await actor.query('ALTER TABLE '+table+' DROP COLUMN stale_flags');

    const reopened=await adapter.open(name),reviewed=await review(reopened,newBody);
    const applied=await adapter.apply(reopened,reviewed,flags);
    assert.equal(applied.state,'applied',JSON.stringify(applied));
    assert.equal(applied.scheduleAndContextPreserved,true);
    assert.equal(applied.bodyExecuted,false);
    assert.equal(applied.autoRetried,false);
    const copied=await observed(name);
    assert.match(copied.EVENT_DEFINITION,/approved/);
    assert.deepEqual({...copied,EVENT_DEFINITION:original.EVENT_DEFINITION},original);
    assert.deepEqual(await values(),[]);

    // This separate, owned event proves that the exact stored replacement body runs.
    const [[system]]=await actor.query('SELECT @@GLOBAL.event_scheduler AS scheduler');
    assert.equal(system.scheduler,'ON','Start the owned Spring fixtures with event scheduling explicitly enabled for this test.');
    await actor.query('CREATE DEFINER=CURRENT_USER EVENT '+probe+
      ' ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 2 SECOND ON COMPLETION PRESERVE ENABLE DO '+copied.EVENT_DEFINITION);
    for (let count=0;count<32&&(await values()).length===0;count++) await sleep(250);
    assert.deepEqual(await values(),[[701,'approved']]);
    assert.equal((await observed(name)).STATUS,'DISABLED');
    assert.equal((await observed(name)).LAST_EXECUTED,original.LAST_EXECUTED);
    await actor.query('DROP EVENT '+probe);

    await adapter.connect(config);
    assert.ok((await adapter.recoveries()).some(item=>item.operationId===reviewed.operationId && item.kind==='event'));
    const recovered=await adapter.recover(reviewed.operationId,flags);
    assert.equal(recovered.state,'recovered',JSON.stringify(recovered));
    assert.deepEqual(await observed(name),original);
    assert.deepEqual(await values(),[[701,'approved']]);

    let unknownOutcomeRecovered=false;
    if(adapter.interruptAfterAlter) {
      const retry=await adapter.open(name),pending=await review(retry,newBody);
      const unknown=await adapter.interruptAfterAlter(retry,pending,flags);
      assert.equal(unknown.state,'needs-inspection',JSON.stringify(unknown));
      assert.equal(unknown.autoRetried,false);
      assert.match((await observed(name)).EVENT_DEFINITION,/approved/);
      await adapter.connect(config);
      assert.equal((await adapter.recover(pending.operationId,flags)).state,'recovered');
      assert.deepEqual(await observed(name),original);
      unknownOutcomeRecovered=true;
    }
    const onceModel=await adapter.open(once),onceReview=await review(onceModel,newBody);
    assert.equal(onceReview.schedule.eventType,'ONE TIME');
    assert.equal(onceReview.schedule.executeAt,originalOnce.EXECUTE_AT);
    assert.equal((await adapter.apply(onceModel,onceReview,flags)).state,'applied');
    const changedOnce=await observed(once);
    assert.deepEqual({...changedOnce,EVENT_DEFINITION:originalOnce.EVENT_DEFINITION},originalOnce);
    assert.equal((await adapter.recover(onceReview.operationId,flags)).state,'recovered');
    assert.deepEqual(await observed(once),originalOnce);
    const later=await adapter.open(name),laterReview=await review(later,newBody);
    assert.equal((await adapter.apply(later,laterReview,flags)).state,'applied');
    await actor.query('ALTER DEFINER=CURRENT_USER EVENT '+name+" COMMENT 'external after deployment'");
    await assert.rejects(adapter.recover(laterReview.operationId,flags),/creation context changed/);
    assert.deepEqual(await adapter.probe(),spring);
    return {engine:runtime.dbEngine,readOnlyPreview:true,disabledTargetNeverInvoked:true,actualScheduledReplacement:true,
      scheduleDefinerSqlModeAndTimeZonePreserved:true,oneTimeScheduleRetained:true,reconnectRestoredExactSource:true,staleSourceAndTargetRefused:true,
      enabledObjectExcluded:true,crossSchemaAndOpaqueBodyRefused:true,unknownOutcomeRecovered,externalRestoreRefused:true,
      nativeDraftExecutionGuard:Boolean(adapter.assertRunRefused),nativeReviewDocument:Boolean(adapter.assertReviewDocument),spring};
  } finally {
    try {
      for(const event of [probe,control,once,name]) await actor.query('DROP EVENT IF EXISTS '+event);
      await actor.query('DROP TABLE IF EXISTS '+table);
      if((await journalState()).present) for(const id of operations) await actor.execute('DELETE FROM '+JOURNAL+' WHERE operation_id=?',[id]);
      await adapter.disconnect();
    } finally {await actor.end();}
  }
}

async function runEventDeploymentChecks(api,vscode,checks) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG),author=api.dbAuthoring;
  const result=await verifyEventDeployment(runtime,{
    connect:api.connectMysql,disconnect:api.disconnectMysql,
    async list(){return (await api.listSchemaObjects()).objects;},
    open:name=>author.openObject({kind:'event',name}),
    async review(model,source) {
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri));
      const edit=new vscode.WorkspaceEdit();
      edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),source);
      assert.equal(await vscode.workspace.applyEdit(edit),true);
      return author.reviewObject(model.modelId);
    },
    apply:(model,_review,approved)=>author.deployObject(model.modelId,approved),
    recoveries:async()=> (await api.listSchemaObjectRecoveries()).operations,
    recover:(id,approved)=>author.recoverObject(id,approved),
    async assertRunRefused(model) {
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri));
      await assert.rejects(api.previewSqlScript(document.getText(),{document}),/Review Database Object Source/);
    },
    async assertReviewDocument(model,expected) {
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-object-review:/'+model.modelId+'/review.sql'));
      assert.equal(document.getText().replaceAll('\r\n','\n'),expected.sql);
    },
    async probe() {
      const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok);
      return response.json();
    }
  });
  checks.push('The installed editor reviewed an existing disabled scheduled event, compared exact server context, applied and restored its original source, and prevented console execution from the draft.');
  return result;
}

module.exports={verifyEventDeployment,runEventDeploymentChecks};
