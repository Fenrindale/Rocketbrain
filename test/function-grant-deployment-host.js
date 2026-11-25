'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const mysql=require('mysql2/promise');
const {MysqlService}=require('../src/db/mysql');
const {JOURNAL}=require('../src/db/object-editor');
const {jdbcReadback}=require('./java-source-analysis-host');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const markers={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
const flags={allowImplicitCommit:true,allowRoutineReplacement:true};

async function verifyFunctionGrants(adapter,readback=jdbcReadback) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const folder=await fs.realpath(path.dirname(runtime.dbConfigPath)),owner=await read(path.join(folder,'owner.json'));
  const descriptor=await fs.realpath(process.env.ROCKETBRAIN_FUNCTION_GRANT_CONFIG),fixture=await read(descriptor);
  const config=await read(runtime.dbConfigPath);
  assert.equal(owner.kind,markers[runtime.dbEngine]);
  assert.equal(fixture.kind,'RocketbrainOwnedFunctionGrants-v1');
  assert.equal(fixture.owner,owner.id);assert.equal(fixture.engine,runtime.dbEngine);
  assert.equal(path.dirname(descriptor),folder);
  assert.equal(await fs.realpath(fixture.dbConfigPath),await fs.realpath(runtime.dbConfigPath));
  assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'rocketbrain_fixture');
  const {publisher,guests}=fixture;
  assert.equal(guests.length,2);
  for(const route of [publisher,...guests]){
    assert.equal(route.host,config.host);assert.equal(route.database,config.database);assert.equal(route.port,config.port);
    assert.match(route.user,/^rb_grant_[a-z]+_[0-9a-f]{10}$/u);
  }
  const connection=await mysql.createConnection(publisher);
  const name='rb_grant_function_'+randomBytes(5).toString('hex'),target={kind:'function',name};
  const qualified=config.database+'.'+name,operations=[];
  const makeGrant=guest=>connection.query('GRANT EXECUTE ON FUNCTION '+qualified+' TO ?@?',[guest.user,guest.host]);
  const revoke=guest=>connection.query('REVOKE EXECUTE ON FUNCTION '+qualified+' FROM ?@?',[guest.user,guest.host]);
  const caller=async route=>{
    const client=await mysql.createConnection(route);
    try{
      const [[row]]=await client.query('SELECT '+qualified+'(40) result');
      return String(row.result);
    }finally{await client.end();}
  };
  const operation=async source=>{
    const model=await adapter.open(target),review=await adapter.preview(model,source);
    operations.push(review.operationId);
    return {model,review};
  };
  const deployed=item=>adapter.apply(item,flags);
  const restored=item=>adapter.recover(item.review.operationId,flags);
  const context=async()=>{
    const [[row]]=await connection.query('SELECT DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,SECURITY_TYPE,DTD_IDENTIFIER,ROUTINE_COMMENT '+
      'FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=? AND ROUTINE_TYPE=\'FUNCTION\'',[config.database,name]);
    return row;
  };
  try{
    const [[{originalMode}]]=await connection.query('SELECT @@SESSION.sql_mode originalMode');
    await connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'");
    await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_bin');
    await connection.query('CREATE FUNCTION '+qualified+
      "(i BIGINT) RETURNS BIGINT DETERMINISTIC NO SQL SQL SECURITY INVOKER COMMENT 'Owned grant review' RETURN i + 1");
    await connection.query('SET SESSION sql_mode=?',[originalMode]);
    const originalContext=await context();
    await makeGrant(guests[0]);await makeGrant(guests[1]);
    assert.deepEqual(await Promise.all(guests.map(caller)),['41','41']);
    await adapter.connect(publisher);
    const stale=await operation('RETURN i + 2');
    assert.deepEqual(stale.review.validation,{compiled:true,executed:false,cleaned:true});
    assert.equal(stale.review.requiresRoutineReplacementApproval,true);
    assert.ok(guests.every(guest=>stale.review.sql.includes("TO '"+guest.user+"'@'"+guest.host+"';")));
    const rendered=await adapter.document?.(stale.model);
    if(rendered)assert.match(rendered,/GRANT EXECUTE ON FUNCTION/);
    await revoke(guests[1]);
    await assert.rejects(deployed(stale),/source, security, context or grants changed after review/);
    assert.equal(await caller(guests[0]),'41');
    await assert.rejects(caller(guests[1]),/command denied|not allowed|denied/i);
    await makeGrant(guests[1]);

    const denied=await operation('RETURN i + 2');
    await assert.rejects(adapter.apply(denied,{allowImplicitCommit:true}),/temporary-unavailability approval/);
    const second=await operation('RETURN i + 2');
    const applied=await deployed(second);
    assert.equal(applied.state,'applied',JSON.stringify(applied));
    assert.equal(applied.grantsPreserved,true);
    assert.deepEqual(await context(),originalContext);
    assert.deepEqual(await Promise.all(guests.map(caller)),['42','42']);
    await adapter.connect(publisher);
    const list=await adapter.list();
    assert.deepEqual(list.find(row=>row.operationId===second.review.operationId).restoreExecuteAccounts,
      guests.map(({host,user})=>({host,user})));
    await revoke(guests[1]);
    await assert.rejects(restored(second),/changed outside the reviewed replacement/);
    assert.equal(await caller(guests[0]),'42');
    await makeGrant(guests[1]);
    assert.equal((await restored(second)).state,'recovered');
    assert.deepEqual(await Promise.all(guests.map(caller)),['41','41']);
    assert.deepEqual(await context(),originalContext);

    let interruptedReplay=false,interruptedRestoration=false;
    if(adapter.interrupt){
      const third=await operation('RETURN i + 3');
      const incomplete=await adapter.interrupt(()=>deployed(third));
      assert.equal(incomplete.state,'needs-inspection');
      assert.equal(await caller(guests[0]),'43');
      await assert.rejects(caller(guests[1]),/command denied|not allowed|denied/i);
      await adapter.connect(publisher);
      const interrupted=await adapter.interrupt(()=>restored(third));
      assert.equal(interrupted.state,'needs-inspection');
      assert.equal(await caller(guests[0]),'41');
      await assert.rejects(caller(guests[1]),/command denied|not allowed|denied/i);
      await adapter.connect(publisher);
      assert.equal((await restored(third)).state,'recovered');
      assert.deepEqual(await Promise.all(guests.map(caller)),['41','41']);
      assert.deepEqual(await context(),originalContext);
      interruptedReplay=true;interruptedRestoration=true;
    }
    const [[{version}]]=await connection.query('SELECT VERSION() version');
    return {engine:runtime.dbEngine,version,compiledWithoutBodyExecution:true,exclusiveRoutineApproval:true,exactGuests:guests.length,
      preApplyGrantChangeRefused:true,externalPostDeployGrantChangeRefused:true,callerAccessKept:true,ownerAndCreationContextPreserved:true,
      durableOriginalAndAccessRestored:true,interruptedReplay,interruptedRestoration,spring:await readback()};
  }finally{
    try{
      await adapter.disconnect();
      await connection.query('DROP FUNCTION IF EXISTS '+qualified);
      for(const id of operations)await connection.query("DELETE FROM "+String.fromCharCode(96)+JOURNAL+String.fromCharCode(96)+" WHERE operation_id=?",[id]);
    }finally{await connection.end();}
  }
}

async function verifyFunctionGrantsBackend(readback) {
  let service;
  return verifyFunctionGrants({
    async connect(config){await service?.dispose();service=new MysqlService(config);},
    async disconnect(){await service?.dispose();service=undefined;},
    open:target=>service.inspectSchemaObject(target),
    preview:(model,source)=>service.previewSchemaObject({modelId:model.modelId,source}),
    apply:(item,flags)=>service.applySchemaObject({reviewId:item.review.reviewId,...flags}),
    list:()=>service.listSchemaObjectRecoveries(),
    recover:(operationId,flags)=>service.recoverSchemaObject({operationId,...flags}),
    async interrupt(action){
      const original=service._stream;
      let intercepted=false;
      service._stream=async function(session,sql,...args){
        const result=await original.call(this,session,sql,...args);
        if(!intercepted&&/^GRANT EXECUTE ON FUNCTION /u.test(sql)){
          intercepted=true;
          const error=Object.assign(Error('Owned fixture dropped a successful grant acknowledgement.'),{code:'ROCKETBRAIN_FIXTURE_LOST_GRANT'});
          this._lose(session,error,true);
          throw error;
        }
        return result;
      };
      try{
        const result=await action();assert.equal(intercepted,true);return result;
      }finally{service._stream=original;}
    }
  },readback);
}

async function runFunctionGrantDeploymentChecks(api,vscode,checks) {
  const author=api.dbAuthoring;
  const result=await verifyFunctionGrants({
    connect:api.connectMysql,disconnect:api.disconnectMysql,
    open:target=>author.openObject(target),
    async preview(model,source){
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri));
      const edit=new vscode.WorkspaceEdit();
      edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),source);
      assert.ok(await vscode.workspace.applyEdit(edit));
      const deadline=Date.now()+2000;
      while(document.getText()!==source&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(document.getText(),source);
      return author.reviewObject(model.modelId);
    },
    async document(model){
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-object-review:/'+model.modelId+'/review.sql'));
      return document.getText();
    },
    apply:(item,flags)=>author.deployObject(item.model.modelId,flags),
    async list(){return (await api.listSchemaObjectRecoveries()).operations;},
    recover:(operationId,flags)=>author.recoverObject(operationId,flags)
  });
  checks.push('The installed scalar function source review compiled an owned shadow and preserved both exact EXECUTE grants during deployment and restoration.');
  return {...result,nativeFunctionGrantReview:true};
}

module.exports={verifyFunctionGrantsBackend,runFunctionGrantDeploymentChecks};
if(require.main===module)verifyFunctionGrantsBackend().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
