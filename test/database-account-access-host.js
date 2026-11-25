'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {EventEmitter}=require('node:events');
const mysql=require('mysql2/promise');
const {MysqlService}=require('../src/db/mysql');
const {registerDatabaseAdmin}=require('../src/db/database-admin-vscode');
const {jdbcReadback}=require('./java-source-analysis-host');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const raw=config=>mysql.createConnection(config);
const account=({user,host})=>({user,host});

async function verifyAccountAccess(api,adapter,readback=jdbcReadback) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config=await read(runtime.dbConfigPath), folder=await fs.realpath(path.dirname(runtime.dbConfigPath));
  const owner=await read(path.join(folder,'owner.json')), file=await fs.realpath(process.env.ROCKETBRAIN_ACCOUNT_ACCESS_CONFIG);
  const fixture=await read(file);
  const marker={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
  assert.equal(fixture.kind,'RocketbrainOwnedAccountAccess-v1');
  assert.equal(owner.kind,marker[runtime.dbEngine]);
  assert.equal(fixture.owner,owner.id);
  assert.equal(fixture.engine,runtime.dbEngine);
  assert.equal(path.dirname(file),folder);
  assert.equal(await fs.realpath(fixture.dbConfigPath),await fs.realpath(runtime.dbConfigPath));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const {target,actor,limited,empty,objects}=fixture, schema=config.database;
  for(const value of Object.values(objects))assert.match(value,/^rb_acl_[a-z_]+[0-9a-f]{10}$/u);
  for(const route of [actor,target,limited,empty]){
    assert.equal(route.host,config.host);
    assert.equal(route.port,config.port);
    assert.equal(route.database,schema);
  }
  const definer=account(target),select=(locked,selected=definer)=>api.prepareAccountAccess({account:selected,locked});
  const apply=async (review,approved=true)=>api.applyAccountAccess({reviewId:review.reviewId,approved});
  const q=name=>schema+'.'+name;
  let prior,app;
  async function verifyRole(session,expectedCount) {
    const [[row]]=await session.query('SELECT CURRENT_USER() AS account,COUNT(*) AS n FROM '+q(objects.audit));
    assert.equal(row.account,target.user+'@'+target.host);
    assert.equal(Number(row.n),expectedCount);
  }
  const refuseFresh=route=>assert.rejects(raw(route),error=>/account is locked|access denied/i.test(error.message));
  const enableFresh=async (route,roleCount)=>{
    const connection=await raw(route);
    try {
      if(roleCount!==undefined)await verifyRole(connection,roleCount);
      else {
        const [[row]]=await connection.query('SELECT CURRENT_USER() account');
        assert.equal(row.account,route.user+'@'+route.host);
      }
    } finally {await connection.end();}
  };
  try {
    await adapter.connect(limited);
    await assert.rejects(select(true),/direct global SELECT, SHOW VIEW, TRIGGER and EVENT visibility/);
    await adapter.connect(actor);
    await assert.rejects(select(true,account(actor)),/executing and built-in system accounts/);
    await assert.rejects(select(true,{user:'root',host:'localhost'}),/executing and built-in system accounts/);
    prior=await raw(target);
    await verifyRole(prior,0);
    const stale=await select(true);
    await prior.query('CREATE OR REPLACE SQL SECURITY DEFINER VIEW '+q(objects.view)+' AS SELECT id FROM '+q('rb_spring_person')+' WHERE id>0');
    await assert.rejects(apply(stale),/account policy or definer inventory changed/);
    await enableFresh(target,0);
    await assert.rejects(apply(stale),/expired|connection changed/);
    const stalePolicy=await select(true);
    const administration=await raw(actor);
    try {await administration.query('ALTER USER ?@? WITH MAX_QUERIES_PER_HOUR 1701',[target.user,target.host]);}
    finally {await administration.end();}
    await assert.rejects(apply(stalePolicy),/account policy or definer inventory changed/);
    await enableFresh(target,0);

    const review=await select(true);
    assert.equal(review.definerCoverage,'server-wide-observed');
    assert.deepEqual(review.target,definer);
    assert.equal(review.state.locked,false);
    assert.equal(review.state.hasPassword,true);
    assert.equal(review.state.roles,1);
    assert.equal(review.state.defaultRoles,1);
    assert.equal(Number(review.state.limits.queriesPerHour),1701);
    const expected=[
      [schema,objects.view,'view','DEFINER'],[objects.remote,objects.invoker,'view','INVOKER'],
      [schema,objects.routine,'routine','DEFINER'],[schema,objects.trigger,'trigger','DEFINER'],[schema,objects.event,'event','DEFINER']
    ].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(review.definers.map(item=>[item.schema,item.name,item.kind,item.security])
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),expected);
    assert.equal(review.definers.find(item=>item.kind==='event').status,'DISABLED');
    assert.ok(!JSON.stringify(review).includes(target.password));
    assert.ok(review.definers.every(item=>!Object.hasOwn(item,'revision')));
    const rendered=await adapter.open?.(review.reviewId);
    if(rendered){
      assert.match(rendered,/ACCOUNT LOCK/);
      assert.ok(rendered.includes(objects.invoker)&&rendered.includes(objects.routine)&&rendered.includes('DEFINER'));
    }
    await assert.rejects(async()=>apply(review,false),/Approve the exact/);
    const locked=await apply(review);
    assert.equal(locked.state,'verified');
    assert.equal(locked.locked,true);
    assert.equal(locked.existingSessionsTerminated,false);
    await refuseFresh(target);
    await verifyRole(prior,0);

    app=await raw(config);
    for(const view of [q(objects.view),objects.remote+'.'+objects.invoker]){
      const [rows]=await app.query('SELECT id FROM '+view+' ORDER BY id');
      assert.deepEqual(rows.map(item=>Number(item.id)),[1,2]);
    }
    const [procedure]=await app.query('CALL '+q(objects.routine)+'()');
    assert.equal(Number(procedure[0][0].n),2);
    await app.query('INSERT INTO '+q(objects.input)+' VALUES (42)');
    const [[written]]=await app.query('SELECT id FROM '+q(objects.audit)+' WHERE id=42');
    assert.equal(Number(written.id),42);
    await verifyRole(prior,1);
    const unlocked=await select(false);
    assert.equal(unlocked.state.locked,true);
    assert.deepEqual(unlocked.definers,review.definers);
    assert.equal((await apply(unlocked)).locked,false);
    await enableFresh(target,1);

    const noPassword=await select(true,account(empty));
    assert.equal(noPassword.state.hasPassword,false);
    assert.deepEqual(noPassword.definers,[]);
    assert.equal((await apply(noPassword)).locked,true);
    await refuseFresh(empty);
    assert.equal((await apply(await select(false,account(empty)))).locked,false);
    await enableFresh(empty);
    const spring=await readback();
    return {engine:runtime.dbEngine,version:review.server.version,exactDefinerObjects:expected.length,explicitApproval:true,
      globalVisibilityRequired:true,builtInAndCurrentProtected:true,bodyAndPolicyStalenessRefused:true,
      freshLoginBlockedThenRestored:true,originalSessionAndRolesPreserved:true,viewProcedureTriggerStillWork:true,
      disabledEventInventoried:true,blankPasswordAccountVerified:true,spring};
  } finally {
    try {await Promise.allSettled([prior?.end(),app?.end()]);}
    finally {await adapter.disconnect();}
  }
}

async function verifyAccountAccessBackend(readback) {
  let service,epoch=0;
  const events=new EventEmitter(),disposable={dispose(){}};
  const controller=registerDatabaseAdmin({subscriptions:[]},{
    commands:{registerCommand:()=>disposable},workspace:{isTrusted:true,registerTextDocumentContentProvider:()=>disposable}
  },{database:{
    withDatabaseAdmin(action){const selected=service,expected=epoch;return action({db:selected,epoch,guard:()=>epoch===expected&&service===selected});},
    onDidChangeDatabase(listener){events.on('change',listener);return {dispose:()=>events.off('change',listener)};}
  }});
  try {
    return await verifyAccountAccess(controller,{
      async connect(config){await service?.dispose();service=new MysqlService(config);epoch++;events.emit('change');},
      async disconnect(){await service?.dispose();service=null;epoch++;events.emit('change');}
    },readback);
  }finally{controller.dispose();await service?.dispose();}
}

async function runAccountAccessChecks(api,vscode,checks) {
  assert.ok((await vscode.commands.getCommands()).includes('rocketbrain.db.reviewAccountAccess'));
  const proof=await verifyAccountAccess(api.dbAdmin,{connect:api.connectMysql,disconnect:api.disconnectMysql,
    async open(reviewId){
      await api.dbAdmin.openAccountAccessReview(reviewId);
      return vscode.window.activeTextEditor.document.getText();
    }
  });
  checks.push('The installed account review showed exact DEFINER dependencies and verified lock/unlock on the owned database. Fresh sessions were blocked, while existing sessions, view, procedure and trigger behavior stayed intact.');
  return {...proof,nativeAccountReview:true};
}

module.exports={verifyAccountAccessBackend,runAccountAccessChecks};
if(require.main===module)verifyAccountAccessBackend().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
