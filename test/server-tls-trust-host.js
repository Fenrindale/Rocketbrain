'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net');
const {randomUUID,createHash,X509Certificate}=require('node:crypto');
const mysql=require('mysql2/promise');
const {createConnectionProfiles}=require('../src/db/connection-profiles');
const {connectionProfile}=require('../src/db/connection-security');
const {MysqlService}=require('../src/db/mysql');
const {validateTlsFixture}=require('./helpers/server-tls-rotation-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');
const {setTimeout:delay}=require('node:timers/promises');
const {expiringServer}=require('../scripts/connection-security-fixture');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex');
const hostname='rb-db.local';

async function verifyTlsTrust(manager,adapter,readback=jdbcReadback) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const descriptor=await fs.realpath(runtime.tlsRotationFixturePath);
  const fixture=await read(descriptor);
  assert.equal(fixture.kind,'RocketbrainTlsRotationFixture-v1');
  assert.equal(fixture.engine,runtime.dbEngine);
  assert.equal(await fs.realpath(fixture.dbConfigPath),await fs.realpath(runtime.dbConfigPath));
  const owned=await validateTlsFixture(runtime.dbConfigPath,fixture.certFolder,runtime.dbEngine);
  assert.equal(path.dirname(descriptor),owned.folder);
  assert.equal(fixture.owner,owned.owner);
  assert.equal(fixture.certificateOwner,owned.certificateOwner);
  const from=name=>fs.readFile(path.join(owned.certFolder,name+'.pem'),'utf8');
  const certificate=async name=>new X509Certificate(await from(name));
  const currentCaPath=path.join(owned.folder,'review-trust-ca.pem'),config=owned.config;
  const profile={id:randomUUID(),name:'Owned TLS review '+randomUUID().slice(0,8),
    host:config.host,port:config.port,database:config.database,user:config.user,
    tls:{mode:'verify',serverName:hostname,caPath:currentCaPath}};
  const actor=await mysql.createConnection({host:config.host,port:config.port,user:fixture.actor.user,
    password:fixture.actor.password,connectTimeout:5000});
  const rotate=async (leaf,authority)=>{
    await validateTlsFixture(runtime.dbConfigPath,fixture.certFolder,runtime.dbEngine);
    for (const [destination,source] of [['ca',authority],['cert',leaf],['key',leaf+'-key']]) {
      await fs.writeFile(path.join(owned.folder,'tls-'+destination+'.pem'),await from(source));
    }
    const reload=runtime.dbEngine==='mysql'?'ALTER INSTANCE RELOAD TLS':'FLUSH SSL';
    await actor.query({sql:reload,timeout:7000});
  };
  const rawFailure=async (expected,lookupName,ca)=>{
    await assert.rejects(mysql.createConnection({host:lookupName,port:config.port,user:config.user,password:config.password,
      database:config.database,connectTimeout:5000,stream:()=>net.createConnection({host:config.host,port:config.port}),
      ssl:{ca,rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2'}}),expected);
  };
  let saved;
  try {
    const firstCa=await from('ca'),nextCa=await from('rotation-ca');
    await fs.writeFile(currentCaPath,firstCa,{flag:'wx',mode:0o600});
    saved=await manager.save({profile,password:config.password,rememberPassword:true});
    await manager.connect({id:saved.id});
    const first=saved.observed.tlsPeer;
    assert.equal(first.hostname,hostname);
    assert.equal(first.leafSha256,hash((await certificate('server')).raw));
    assert.equal(first.caMaterialSha256,hash(firstCa));
    assert.equal(first.issuerSha256,hash((await certificate('ca')).raw));
    assert.ok(Date.parse(first.notAfter)>Date.now());
    assert.match(first.protocol,/^TLSv1[.][23]$/);
    const wrong={...profile,tls:{...profile.tls,serverName:'not-this-db.local'}};
    await rawFailure(/does not match|Hostname\/IP/i,wrong.tls.serverName,firstCa);
    await assert.rejects(manager.test({profile:wrong,password:config.password}),/could not be verified/);

    await rotate('rotation-server','rotation-ca');
    await assert.rejects(manager.test({profile:saved.profile}),/could not be verified/);
    await fs.writeFile(currentCaPath,nextCa);
    const review=() => manager.reviewTlsTrust({id:saved.id,revision:manager.list().find(row=>row.id===saved.id).revision});
    const apply=(item,approved=true)=>manager.reconnectReviewedTlsTrust({id:saved.id,reviewId:item.reviewId,approved});
    const pending=await review();
    assert.deepEqual(pending.previous,first);
    assert.equal(pending.current.leafSha256,hash((await certificate('rotation-server')).raw));
    assert.equal(pending.current.caMaterialSha256,hash(nextCa));
    assert.ok(pending.changes.includes('Server certificate')&&pending.changes.includes('Loaded CA material'));
    assert.ok(!JSON.stringify(pending).includes(config.password));
    await assert.rejects(apply(pending,false),/Approve the reviewed TLS/);
    await fs.writeFile(currentCaPath,firstCa);
    await assert.rejects(apply(pending),/CA material changed after review/);
    await assert.rejects(apply(pending),/new TLS trust review/);
    await fs.writeFile(currentCaPath,nextCa);

    const peerReview=await review();
    await rotate('rotation-alt','rotation-ca');
    await assert.rejects(apply(peerReview),/server TLS certificate or trust material changed after review/);
    const accepted=await review();
    assert.equal(accepted.current.leafSha256,hash((await certificate('rotation-alt')).raw));
    assert.deepEqual(await apply(accepted),{connected:true,observationSaved:true});
    assert.equal(adapter.active().id,saved.id);
    const latest=manager.list().find(row=>row.id===saved.id);
    assert.deepEqual(latest.observed.tlsPeer,accepted.current);
    assert.deepEqual((await review()).changes,[]);
    assert.equal((await adapter.query('SELECT DATABASE()')).rows[0][0],config.database);

    await expiringServer(owned.certFolder);
    await rotate('rotation-expiring','rotation-ca');
    const short=await certificate('rotation-expiring'),expires=Date.parse(short.validTo);
    assert.equal((await manager.test({profile:saved.profile})).tlsPeer.leafSha256,hash(short.raw));
    const remaining=expires-Date.now();
    assert.ok(remaining>0&&remaining<=20000);
    await delay(remaining+1000);
    assert.ok(expires<Date.now());
    await rawFailure(/certificate has expired/i,hostname,nextCa);
    await assert.rejects(review(),/could not be verified/);
    await rotate('rotation-alt','rotation-ca');
    assert.deepEqual((await review()).changes,[]);
    const spring=await readback();
    return {engine:runtime.dbEngine,version:latest.observed.serverVersion,verifiedExpiryDisplayed:true,
      mismatchRejected:true,expiredRejected:true,oldCaRejected:true,samePathRotationReviewed:true,staleCaRejected:true,
      differentValidPeerRejected:true,approvedReconnectVerified:true,replayRejected:true,observationSaved:true,spring};
  } finally {
    try {await manager.disconnect();}
    finally {
      try {if(saved){
        const record=manager.list().find(row=>row.id===saved.id);
        if(record)await manager.remove({id:saved.id,expectedRevision:record.revision});
      }} finally {
        try {await rotate('server','ca');}
        finally {await actor.end();await fs.unlink(currentCaPath).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      }
    }
  }
}

async function verifyTlsTrustBackend(readback) {
  const state=new Map(),secrets=new Map();
  let active,profile;
  const manager=createConnectionProfiles({
    state:{get:(key,fallback)=>state.get(key)??fallback,async update(key,value){state.set(key,value);}},
    secrets:{async get(key){return secrets.get(key);},async store(key,value){secrets.set(key,value);},async delete(key){secrets.delete(key);}},
    async connect(config){
      const next=new MysqlService(config);
      try {await next.metadata();} catch(error){await next.dispose();throw error;}
      await active?.dispose();active=next;profile=connectionProfile(config);
    },
    async disconnect(){await active?.dispose();active=undefined;profile=undefined;},
    getActiveProfile:()=>profile,isTrusted:()=>true,createService:config=>new MysqlService(config)
  });
  try {return await verifyTlsTrust(manager,{active:()=>profile,query:text=>active.query(text)},readback);}
  finally {await manager.dispose();}
}

async function runTlsTrustRotationChecks(api,vscode,checks) {
  assert.ok((await vscode.commands.getCommands()).includes('rocketbrain.connections.reviewTlsTrust'));
  const proof=await verifyTlsTrust(api.dbConnections,{active:api.activeConnectionProfile,
    query:text=>api.withDatabaseAdmin(({db})=>db._metadataQuery(text))});
  checks.push('The installed profile reviewed and reconnected with an exact replacement TLS identity. Wrong hostname, expired certificate and post-review trust changes were refused.');
  return {...proof,nativeProfileReview:true};
}

module.exports={verifyTlsTrustBackend,runTlsTrustRotationChecks};
if(require.main===module)verifyTlsTrustBackend().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
