'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto'),mysql=require('mysql2/promise');
const {statement}=require('../src/db/database-password-rotation');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

async function verifyPasswordRotation(runtime,descriptor,adapter) {
  const folder=path.dirname(await fs.realpath(runtime.dbConfigPath)),authority=await read(runtime.dbConfigPath);
  const marker=await read(path.join(folder,'owner.json'));
  assert.equal(path.dirname(await fs.realpath(descriptor)),folder);
  const fixture=await read(descriptor);
  assert.equal(fixture.format,'RocketbrainOwnedRotation');
  assert.equal(fixture.owner,marker.id);
  assert.equal(marker.id,path.basename(folder));
  assert.equal(marker.kind,runtime.dbEngine==='mysql'?'RocketbrainDisposableOracleMysqlFixture-v1':'RocketbrainDisposableMariaDbFixture-v1');
  assert.equal(fixture.engine,runtime.dbEngine);
  assert.equal(fixture.dbConfigPath,runtime.dbConfigPath);
  assert.equal(authority.host,'127.0.0.1');
  assert.equal(authority.database,'rocketbrain_fixture');
  const {writer,reader,target,locked,expired,alternate,role}=fixture;
  for (const account of [writer,reader,target,locked,expired,alternate]) {
    assert.equal(account.host,authority.host);
    assert.equal(account.port,authority.port);
    assert.equal(account.database,authority.database);
    assert.match(account.user,/^rb_rotate_[a-z]+_[0-9a-f]{10}$/u);
  }
  assert.match(role,/^rb_rotate_role_[0-9a-f]{10}$/u);
  const chosen={user:target.user,host:target.host};
  const credentials=[target.password,writer.password,reader.password];
  const next=randomBytes(30).toString('base64url')+"'\\;끝";
  credentials.push(next);
  const assertRedacted=value=>{
    const data=JSON.stringify(value);
    for(const credential of credentials)assert.ok(!data.includes(credential.slice(0,16)));
    assert.doesNotMatch(data,/\b(?:comparisonTag|nonce|authentication_string)\b/u);
  };
  const connect=password=>mysql.createConnection({...target,password,connectTimeout:3000});
  const errno=error=>error?.errno===1045||error?.code==='ER_ACCESS_DENIED_ERROR';
  const targetAccess=async login=>{
    const [[who]]=await login.query('SELECT CURRENT_USER() account, CURRENT_ROLE() active_role');
    assert.equal(who.account,target.user+'@'+target.host);
    assert.match(who.active_role,new RegExp(role));
    assert.deepEqual((await login.query('SELECT id FROM rb_spring_person ORDER BY id'))[0].map(row=>Number(row.id)),[1,2]);
  };
  const control=await mysql.createConnection(writer),open=new Set();
  let held;
  try {
    const [[{datadir}]]=await control.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(),folder.toLowerCase());
    const spring=await adapter.probe();
    assert.equal(spring.people,2);
    held=await connect(target.password);
    open.add(held);
    await targetAccess(held);
    const policies=async()=>{
      const [[row]]=await control.execute('SELECT max_questions,max_updates,max_connections,max_user_connections,ssl_type,plugin FROM mysql.user '+
        'WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?',[target.user,target.host]);return row;
    };
    const beforePolicy=await policies();
    assert.equal(beforePolicy.max_questions,1500);

    await adapter.connect(reader);
    const refused=await adapter.prepare(chosen);
    assertRedacted(refused);
    const denied=await adapter.apply({reviewId:refused.reviewId,approved:true,password:next});
    assert.deepEqual(denied,{state:'rejected',acknowledged:false,automaticRetry:false,credentialsIncluded:false});
    const unchanged=await connect(target.password);
    open.add(unchanged);
    await targetAccess(unchanged);

    await adapter.connect(writer);
    for(const account of [locked,expired,alternate]) {
      await assert.rejects(adapter.prepare({user:account.user,host:account.host}),/one supported password method/);
    }
    await assert.rejects(adapter.prepare({user:writer.user,host:writer.host}),/executing.*protected/);
    await assert.rejects(adapter.prepare({user:'root',host:'localhost'}),/protected/);
    const review=await adapter.prepare(chosen);
    assertRedacted(review);
    assert.equal(review.plugin,runtime.dbEngine==='mysql'?'caching_sha2_password':'mysql_native_password');
    assert.equal(review.roleCount,1);
    assert.equal(review.server.account,writer.user+'@'+writer.host);
    assert.equal(review.sql,statement(chosen,runtime.dbEngine));
    await adapter.assertNativeReview?.(review,assertRedacted);
    await assert.rejects(adapter.apply({reviewId:review.reviewId,approved:false,password:next}),/Approve/);
    await assert.rejects(adapter.apply({reviewId:review.reviewId,approved:true,password:'illegal\npassword'}),/control characters/);
    const result=await adapter.apply({reviewId:review.reviewId,approved:true,password:next});
    assertRedacted(result);
    assert.deepEqual(result,{state:'verified',acknowledged:true,automaticRetry:false,credentialsIncluded:false,
      pluginAndObservedRolePolicyPreserved:true});
    await assert.rejects(adapter.apply({reviewId:review.reviewId,approved:true,password:next}),/expired|connection changed/);
    assert.deepEqual(await policies(),beforePolicy);
    await assert.rejects(connect(target.password),errno);
    const current=await connect(next);
    open.add(current);
    await targetAccess(current);
    await targetAccess(held);

    const stale=await adapter.prepare(chosen), external=randomBytes(29).toString('base64url');
    credentials.push(external);
    await control.query(statement(chosen,runtime.dbEngine,'?'),[external]);
    await assert.rejects(adapter.apply({reviewId:stale.reviewId,approved:true,password:next}),/credential, roles or connection changed/);
    await assert.rejects(connect(next),errno);
    const externalLogin=await connect(external);
    open.add(externalLogin);
    await targetAccess(externalLogin);

    let lostOutcomeRecognized=false;
    if(adapter.interruptAfterChange) {
      const pending=await adapter.prepare(chosen),afterLoss=randomBytes(30).toString('base64url');
      credentials.push(afterLoss);
      const uncertain=await adapter.interruptAfterChange({reviewId:pending.reviewId,approved:true,password:afterLoss});
      assertRedacted(uncertain);
      assert.equal(uncertain.state,'uncertain');
      assert.equal(uncertain.automaticRetry,false);
      const finalLogin=await connect(afterLoss);
      open.add(finalLogin);
      await targetAccess(finalLogin);
      await assert.rejects(connect(external),errno);
      lostOutcomeRecognized=true;
    }
    const activity=await adapter.activity();
    assert.ok(activity.entries.some(item=>item.category==='authorization'&&item.operation==='ALTER'));
    assertRedacted(activity);
    assert.deepEqual(await adapter.probe(),spring);
    return {engine:runtime.dbEngine,exactAccount:true,oldFreshLoginRejected:true,newFreshLoginVerified:true,
      alreadyConnectedSessionPreserved:true,ordinaryPrivilegeRequired:true,protectedAccountAndAlternateMethodsRefused:true,
      directAndDefaultRoleBehaviorPreserved:true,resourceAndTlsPolicyPreserved:true,staleExternalCredentialRefused:true,
      lostOutcomeRecognized,credentialsOrTagsInReviewOrLog:false,nativeReview:Boolean(adapter.assertNativeReview),spring};
  } finally {
    await Promise.allSettled([...open].map(login=>login.end()));
    try {await adapter.disconnect();} finally {await control.end();}
  }
}

async function runPasswordRotationChecks(api,vscode,checks) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.reviewPasswordRotation'));
  const activityWasEnabled=api.activityLog.snapshot().enabled;
  await api.activityLog.setEnabled(true);
  try {
    const result=await verifyPasswordRotation(runtime,process.env.ROCKETBRAIN_PASSWORD_ROTATION_CONFIG,{
      connect:api.connectMysql,disconnect:api.disconnectMysql,
      prepare:api.dbAdmin.preparePasswordRotation,apply:api.dbAdmin.applyPasswordRotation,
      activity:()=>api.activityLog.snapshot(),
      async assertNativeReview(review,assertRedacted) {
        const shown=await api.dbAdmin.openPasswordRotationReview(review.reviewId);
        const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(shown.documentUri));
        assert.match(document.getText(),/<password supplied on apply>/u);
        assertRedacted(document.getText());
      },
      async probe() {
        const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000)});
        assert.ok(response.ok);
        return response.json();
      }
    });
    checks.push('The native password rotation review showed the exact account and supported plugin. Both credential redaction and actual post-rotation role access were verified.');
    return result;
  } finally {await api.activityLog.setEnabled(activityWasEnabled);}
}

module.exports={verifyPasswordRotation,runPasswordRotationChecks};
