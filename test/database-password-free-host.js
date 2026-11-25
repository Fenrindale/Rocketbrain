'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2');
const raw = require('mysql2/promise');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { connectionProfile } = require('../src/db/connection-security');
const { MysqlService } = require('../src/db/mysql');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async file => JSON.parse(await fs.readFile(file,'utf8'));

async function verifyPasswordFreeProfiles(manager,adapter,readback=jdbcReadback) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(await fs.realpath(runtime.dbConfigPath));
  const folder = await fs.realpath(path.dirname(runtime.dbConfigPath));
  const owner = await read(path.join(folder,'owner.json'));
  const descriptorPath = await fs.realpath(process.env.ROCKETBRAIN_PASSWORD_FREE_CONFIG);
  assert.equal(path.dirname(descriptorPath),folder);
  const fixture = await read(descriptorPath);
  assert.equal(fixture.kind,'RocketbrainPasswordFreeFixture-v1');
  assert.equal(fixture.owner,owner.id);
  assert.equal(await fs.realpath(fixture.dbConfigPath),await fs.realpath(runtime.dbConfigPath));
  assert.equal(fixture.engine,runtime.dbEngine);
  const marker = {mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
  assert.equal(owner.kind,marker[fixture.engine]);
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  assert.equal(fixture.plugin,fixture.engine==='mysql'?'caching_sha2_password':'mysql_native_password');

  const tag = randomBytes(4).toString('hex'), ids=[];
  const original = {id:randomUUID(),name:'Owned password '+tag,group:'Password mode '+tag,
    host:config.host,port:config.port,database:config.database,user:fixture.protectedUser,tls:{mode:'disabled'}};
  const anonymous = await raw.createConnection({host:config.host,port:config.port,database:config.database,
    user:fixture.unknownUser,password:'',rowsAsArray:true});
  try {
    const [rows] = await anonymous.query('SELECT CURRENT_USER()');
    assert.equal(rows[0][0].slice(0,rows[0][0].lastIndexOf('@')),'');
  } finally { await anonymous.end(); }

  let editor;
  try {
    const saved = await manager.save({profile:original,password:fixture.protectedPassword,rememberPassword:true});
    ids.push(saved.id);
    assert.equal(saved.hasSavedPassword,true);
    assert.ok(saved.observed.currentUser.startsWith(fixture.protectedUser+'@'));
    await assert.rejects(manager.test({profile:original,password:'owned wrong password'}),/could not be verified|rejected/i);
    adapter.assertFailedAttempt?.(fixture.protectedUser);
    const blank = {...saved.profile,auth:{kind:'password-free'}};
    await assert.rejects(manager.test({profile:blank}),/could not be verified|rejected/i);
    const target = {...blank,user:fixture.openUser};
    await assert.rejects(manager.test({profile:target,password:fixture.protectedPassword}),/without a database password/);
    await assert.rejects(manager.save({profile:target,expectedRevision:saved.revision,rememberPassword:true}),/cannot save/);
    assert.equal(manager.list().find(row=>row.id===saved.id).hasSavedPassword,true);
    await assert.rejects(manager.test({profile:{...blank,user:fixture.unknownUser}}),/authenticated a different account/);

    const observed = await manager.test({profile:target});
    assert.ok(observed.currentUser.startsWith(fixture.openUser+'@'));
    assert.ok(observed.schemas.includes(config.database));
    let changed;
    if (adapter.open) {
      editor = await adapter.open(saved.id);
      const profile = {...target};
      delete profile.id;
      changed = await adapter.handle(editor.editorId,{type:'save',editorId:editor.editorId,profile,rememberPassword:false});
    } else changed = await manager.save({profile:target,expectedRevision:saved.revision});
    assert.equal(changed.hasSavedPassword,false);
    assert.equal(changed.profile.auth.kind,'password-free');
    adapter.assertSecretDeleted?.();
    const result = adapter.connect ? await adapter.connect(changed.id) : await manager.connect({id:changed.id});
    assert.equal(result.connected,true);
    assert.equal(adapter.active().authentication,'password-free');
    assert.equal(adapter.active().id,changed.id);
    adapter.assertTree?.(changed.id);
    const query = await adapter.query('SELECT CURRENT_USER(), id FROM rb_spring_person ORDER BY id');
    assert.deepEqual(query.rows.map(row=>Number(row[1])),[1,2]);
    assert.ok(query.rows.every(row=>row[0].startsWith(fixture.openUser+'@')));

    const portable = manager.exportProfiles(), selected = portable.profiles.find(item=>item.group===target.group);
    assert.equal(portable.version,8);
    assert.deepEqual(selected.auth,{kind:'password-free'});
    assert.equal(portable.credentialsIncluded,false);
    assert.ok(!JSON.stringify([portable,changed]).includes(fixture.protectedPassword));
    await assert.rejects(manager.importProfiles({...portable,version:7,profiles:[selected]}),/format 8/);
    await manager.importProfiles({...portable,profiles:[{...selected,name:'Imported password-free '+tag}]});
    const imported = manager.list().find(row=>row.profile.name==='Imported password-free '+tag);
    ids.push(imported.id);
    assert.equal(imported.hasSavedPassword,false);
    assert.ok((await manager.schemas({id:imported.id})).includes(config.database));
    assert.equal((await manager.connect({id:imported.id})).connected,true);
    assert.equal(adapter.active().authentication,'password-free');
    const jdbc = await readback();
    return {engine:runtime.dbEngine,version:observed.serverVersion,plugin:fixture.plugin,
      protectedAccountVerified:true,differentAccountRejected:true,wrongPasswordRejected:true,
      protectedAccountRefusedEmpty:true,explicitPasswordFreeVerified:true,rememberRejected:true,
      passwordNotExported:true,replacedSavedCredential:true,portableRoundtrip:true,spring:jdbc};
  } finally {
    await manager.disconnect();
    if (editor) adapter.close(editor.editorId);
    for (const id of ids) {
      const row = manager.list().find(item=>item.id===id);
      if (row) await manager.remove({id,expectedRevision:row.revision});
    }
  }
}

async function verifyPasswordFreeBackend(readback) {
  const records = new Map(),passwords = new Map(),attempts=[];
  let active, profile;
  const service = config => new MysqlService(config,{createConnection(options){
    attempts.push({user:options.user,hasPassword:Boolean(options.password)});
    return mysql.createConnection(options);
  }});
  const manager = createConnectionProfiles({
    state:{get:(key,fallback)=>records.get(key)??fallback,async update(key,value){records.set(key,value);}},
    secrets:{async get(key){return passwords.get(key);},async store(key,value){passwords.set(key,value);},async delete(key){passwords.delete(key);}},
    async connect(config){
      const next=service(config);
      try { await next.metadata(); }
      catch(error) { await next.dispose(); throw error; }
      await active?.dispose();
      active=next;
      profile=connectionProfile(config);
    },
    async disconnect(){await active?.dispose();active=undefined;profile=undefined;},
    getActiveProfile:()=>profile,isTrusted:()=>true,createService:service
  });
  try {
    const proof = await verifyPasswordFreeProfiles(manager,{
      active:()=>profile,query:text=>active.query(text),
      assertFailedAttempt(user){assert.deepEqual(attempts.filter(item=>item.user===user),[
        {user,hasPassword:true},{user,hasPassword:true}
      ]);},
      assertSecretDeleted(){assert.equal(passwords.size,0);}
    },readback);
    return {...proof,oneWrongPasswordAttempt:true,oldSecretStoreEntryDeleted:true};
  } finally { await manager.dispose(); }
}

async function runPasswordFreeChecks(api,vscode,checks) {
  const manager=api.dbConnections;
  const proof=await verifyPasswordFreeProfiles(manager,{
    active:api.activeConnectionProfile,query:text=>api.withDatabaseAdmin(({db})=>db._metadataQuery(text)),
    open:manager.openEditor,handle:manager.handle,close:manager.closeEditor,
    connect:profileId=>vscode.commands.executeCommand('rocketbrain.connections.connect',{profileId}),
    assertTree(profileId){
      const node=manager.tree.getChildren().flatMap(group=>manager.tree.getChildren(group)).find(node=>node.profileId===profileId);
      assert.ok(node?.description.includes('No password'));
    }
  });
  checks.push('The installed connection editor switched to explicit no-password mode and the Connect command authenticated the selected database account without a password prompt.');
  return {...proof,nativeProfileEditor:true};
}

module.exports={verifyPasswordFreeBackend,runPasswordFreeChecks};
if(require.main===module)verifyPasswordFreeBackend().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
