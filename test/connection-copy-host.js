'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runConnectionCopyChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath),'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  assert.ok(typeof config.password === 'string' && config.password.length >= 8);
  const manager = api.dbConnections;
  const existing = new Set(manager.list().map(item=>item.id));
  const group = 'Owned share ' + randomUUID();
  const profile = { id:randomUUID(),name:'Development',group,color:'blue',host:config.host,port:config.port,user:config.user,
    database:config.database,tls:{mode:'disabled'},sessionLifecycle:{initialSql:"SET SESSION time_zone = '+05:00'"} };
  const expectedJdbc = { people:2,departments:1,rolledBackNames:0 };
  let editor;
  try {
    const original = await manager.save({ profile,password:config.password,rememberPassword:true });
    await manager.connect({id:original.id});
    editor = await vscode.commands.executeCommand('rocketbrain.connections.duplicate',{profileId:original.id});
    assert.ok(editor?.editorId);
    const copy = manager.list().find(item=>item.id===editor.profile.id);
    assert.notEqual(copy.id,original.id);
    assert.deepEqual(copy.profile,{...original.profile,id:copy.id,name:'Development (copy)'});
    assert.equal(copy.hasSavedPassword,false);
    assert.equal(copy.verifiedAt,null);
    assert.equal(api.activeConnectionProfile().id,original.id);
    await assert.rejects(manager.test({profile:copy.profile}),/could not be verified/i);
    await manager.connect({id:copy.id,password:config.password});
    assert.equal(api.activeConnectionProfile().id,copy.id);
    assert.equal((await api.databaseCatalog()).database,config.database);

    const fullExport = manager.exportProfiles();
    assert.equal(fullExport.version,5);
    assert.equal(fullExport.credentialsIncluded,false);
    const bundle = { ...fullExport, profiles:fullExport.profiles.filter(item=>item.group===group) };
    assert.equal(bundle.profiles.length,2);
    assert.ok(!JSON.stringify(bundle).includes(config.password));
    const review = manager.reviewProfileImport(bundle);
    assert.equal(review.conflicts,2);
    assert.deepEqual(await manager.importProfiles(bundle,{review,strategy:'rename'}),
      {imported:2,connectionsAttempted:0,skipped:0,renamed:2});
    await assert.rejects(manager.importProfiles(bundle,{review,strategy:'skip'}),/Review the import again/);
    const fresh = manager.reviewProfileImport(bundle);
    assert.deepEqual(await manager.importProfiles(bundle,{review:fresh,strategy:'skip'}),
      {imported:0,connectionsAttempted:0,skipped:2,renamed:0});
    const rows = manager.list().filter(item=>item.profile.group===group);
    assert.equal(rows.length,4);
    assert.equal(new Set(rows.map(item=>item.profile.name)).size,4);
    assert.deepEqual(rows.filter(item=>item.hasSavedPassword).map(item=>item.id),[original.id]);
    assert.equal(api.activeConnectionProfile().id,copy.id);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc,expectedJdbc);
    checks.push('Duplicated a real saved profile with independent credentials, connected the copy, and reviewed colliding imports without altering the source account or active connection.');
    return { engine:runtime.dbEngine,nativeDuplicateEditor:true,independentCredential:true,sameEndpointVerified:true,
      credentialFreeVersionFive:true,renameAndSkip:true,staleImportRefused:true,activeProfilePreserved:true,jdbc };
  } finally {
    if(editor)manager.closeEditor(editor.editorId);
    await manager.disconnect();
    for(const row of manager.list().filter(item=>!existing.has(item.id))) {
      await manager.remove({id:row.id,expectedRevision:row.revision});
    }
  }
}

module.exports = { runConnectionCopyChecks };
