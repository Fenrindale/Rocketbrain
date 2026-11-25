'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { randomBytes } = require('node:crypto');

const read = async file => JSON.parse(await fs.readFile(file,'utf8'));

async function verifyClientIdentities(runtime, manager, adapter) {
  const root = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const account = await read(runtime.clientIdentityFixturePath), original = await read(runtime.dbConfigPath);
  const owner = await read(path.join(root,'owner.json')), certOwner = await read(path.join(account.folder,'owner.json'));
  assert.equal(owner.kind,runtime.dbEngine === 'mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1');
  assert.equal(owner.id,path.basename(root));
  assert.equal(account.format,'RocketbrainOwnedClientIdentityFixture');
  assert.equal(account.id,owner.id);
  assert.equal(account.dbConfigPath,runtime.dbConfigPath);
  assert.equal(original.host,'127.0.0.1');
  assert.equal(original.database,'rocketbrain_fixture');
  assert.match(account.user,/^rb_client_[a-f0-9]{10}$/u);
  assert.equal(certOwner.kind,'RocketbrainConnectionSecurityFixture-v18');
  assert.equal(certOwner.id,path.basename(await fs.realpath(account.folder)));
  const tag = randomBytes(5).toString('hex');
  const local = name => path.join(account.folder,name);
  const common = {host:original.host,port:original.port,database:original.database,user:account.user,group:'Owned mutual TLS '+tag};
  const verified = {mode:'verify',serverName:'rb-db.local',caPath:local('ca.pem')};
  const encryptedPem = {...common,name:'Encrypted PEM '+tag,tls:{...verified,clientIdentity:'encrypted-pem',
    certPath:local('client.pem'),keyPath:local('client-key-encrypted.pem')}};
  const pkcs12 = {...common,name:'PKCS#12 '+tag,tls:{...verified,clientIdentity:'pkcs12',pfxPath:local('client.p12')}};
  const request = {password:account.password,clientIdentityPassphrase:account.passphrase};
  const absent = {profile:{...common,name:'No client '+tag,tls:verified},password:account.password};
  const before = await adapter.probe(), editors = [], ids = [];
  assert.ok(Number.isInteger(before.people) && before.people>=2);
  await assert.rejects(manager.test(absent));
  try {
    for (const profile of [encryptedPem,pkcs12]) {
      await assert.rejects(manager.test({profile,password:request.password}),/passphrase/i);
      await assert.rejects(manager.test({profile,...request,clientIdentityPassphrase:'definitely wrong'}),/passphrase/i);
      const tested = await manager.test({profile,...request});
      assert.equal(tested.tls,true);
      assert.ok(tested.cipher);
      assert.equal(tested.currentUser,account.user+'@127.0.0.1');
      const saved = await manager.save({profile,...request,rememberPassword:true});
      ids.push(saved.id);
      assert.equal(saved.hasSavedPassword,true);
      const editor = await manager.openEditor(saved.id);
      editors.push(editor.editorId);
      const form = {...saved.profile}; delete form.id;
      // The webview's actual handler must send the identity independently of Secret Storage.
      const connected = await manager.handle(editor.editorId,{editorId:editor.editorId,type:'connect',profile:form,
        clientIdentityPassphrase:account.passphrase,rememberPassword:true});
      assert.equal(connected.connected,true);
      assert.equal(adapter.active().id,saved.id);
      const sql = await adapter.sql('SELECT CURRENT_USER(), (SELECT id FROM people ORDER BY id LIMIT 1)');
      assert.deepEqual(sql.rows,[[account.user+'@127.0.0.1','1']]);
      assert.ok(JSON.stringify(managed()).includes(saved.id));
      const reports = JSON.stringify([tested,saved,connected,managed()]);
      assert.ok(!reports.includes(account.passphrase) && !reports.includes(account.password) && !reports.includes('BEGIN ENCRYPTED'));
      await manager.disconnect();
      await assert.rejects(manager.connect({id:saved.id}),/passphrase/i);
      await manager.connect({id:saved.id,clientIdentityPassphrase:account.passphrase});
      await manager.disconnect();
    }
    // Client chains never replace the separately chosen server CA and expected DNS name.
    for (const tls of [{caPath:local('wrong-ca.pem')},{serverName:'wrong-db.local'}]) {
      await assert.rejects(manager.test({profile:{...pkcs12,tls:{...pkcs12.tls,...tls}},...request}));
    }
    await assert.rejects(manager.test({profile:{...encryptedPem,tls:{...encryptedPem.tls,keyPath:local('server-key.pem')}},...request}),/encrypted PEM/i);
    const exported = manager.exportProfiles(), portable = exported.profiles.filter(profile=>profile.group===common.group);
    assert.equal(exported.version,6);
    assert.equal(exported.credentialsIncluded,false);
    assert.deepEqual(portable.map(p=>p.tls.clientIdentity).sort(),['encrypted-pem','pkcs12']);
    assert.ok(!JSON.stringify(portable).includes('Path'));
    const restorable = {...exported,profiles:portable.map(profile=>({...profile,group:'Owned import '+tag}))};
    await manager.importProfiles(restorable);
    const imported = manager.list().filter(row=>row.profile.group==='Owned import '+tag);
    ids.push(...imported.map(row=>row.id));
    assert.equal(imported.length,2);
    for (const row of imported) {
      await assert.rejects(manager.connect({id:row.id,...request}),/Select (a local PKCS#12|the client certificate)/);
      assert.equal(row.hasSavedPassword,false);
    }
    assert.deepEqual(await adapter.probe(),before);
    return { engine:runtime.dbEngine,serverRequiresX509:true,encryptedPem:true,pkcs12:true,activeFormConnection:true,
      freshPassphraseOnReconnect:true,absentClientRejected:true,wrongIdentityPassphraseRejected:true,
      wrongServerCaAndDnsRejected:true,plaintextKeyRefused:true,portableFileRebind:true,reportsWithoutSecrets:true,spring:before };
  } finally {
    await manager.disconnect();
    for (const id of editors) manager.closeEditor(id);
    for (const id of ids) {
      const current = manager.list().find(row=>row.id===id);
      if (current) await manager.remove({id,expectedRevision:current.revision});
    }
  }
  function managed() { return manager.list().filter(row=>row.profile.group===common.group); }
}

async function runClientIdentityChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.ok(vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome'));
  const result = await verifyClientIdentities(runtime,api.dbConnections,{
    active:api.activeConnectionProfile,
    sql:text=>api.withDatabaseAdmin(({db})=>db._metadataQuery(text)),
    async probe() {
      const response = await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000)});
      assert.equal(response.ok,true);
      return response.json();
    }
  });
  checks.push('The native connection form tested and activated encrypted PEM and PKCS#12 client identities against REQUIRE X509, including a fresh passphrase on reconnect, preserved CA/DNS checks and portable exports without paths or secrets.');
  return result;
}

module.exports = { verifyClientIdentities, runClientIdentityChecks };
