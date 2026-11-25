'use strict';

const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), path = require('node:path');
const { normalizeProfile, profileRequiresClientPassphrase, createConnectionProfiles } = require('../src/db/connection-profiles');
const { connectionHtml, promptProfileCredentials } = require('../src/db/connection-profiles-vscode');

const base = {name:'Local fixture',host:'127.0.0.1',user:'reader',database:'data'};
const verified = {mode:'verify',serverName:'database.example.test'};
const local = leaf => path.resolve(leaf);

test('encrypted identities are explicit, mutually exclusive and require TLS verification', () => {
  const pkcs12 = {...verified,clientIdentity:'pkcs12',pfxPath:local('test.p12')};
  const pem = {...verified,clientIdentity:'encrypted-pem',keyPath:local('encrypted.pem'),certPath:local('cert.pem')};
  const normalize = tls=>normalizeProfile({...base,tls});
  assert.equal(profileRequiresClientPassphrase(normalize(pkcs12)),true);
  assert.equal(profileRequiresClientPassphrase(normalize(pem)),true);
  assert.equal(profileRequiresClientPassphrase(normalize({...verified,certPath:pem.certPath,keyPath:pem.keyPath})),false);
  assert.throws(()=>normalize({...pem,mode:'disabled'}),/verified TLS/);
  assert.throws(()=>normalize({...pkcs12,keyPath:pem.keyPath}),/either a PKCS#12/);
  assert.throws(()=>normalize({...pkcs12,passphrase:'a passphrase'}),/unsupported fields/);
  assert.throws(()=>normalize({...pkcs12,pfxPath:'relative.pfx'}),/absolute/);
  assert.throws(()=>normalize({...pem,keyPath:undefined}),/encrypted private key/);
});

test('identity path rebinding survives a version 6 portable import without touching the network', async () => {
  const state=new Map(), manager=createConnectionProfiles({
    state:{get:(key,fallback)=>state.get(key)??fallback,update:async(key,value)=>state.set(key,value)},
    secrets:{get:async()=>undefined,delete:async()=>{},store:async()=>assert.fail('store was not authorized')},isTrusted:()=>true,
    connect:()=>assert.fail('network must be refused'),createService:()=>assert.fail('network must be refused')
  });
  try {
    const profile={...base,tls:{...verified,clientIdentity:'pkcs12'}};
    const port={format:'RocketbrainConnectionProfiles',version:6,credentialsIncluded:false,profiles:[profile]};
    await assert.rejects(manager.importProfiles({...port,version:5}),/format 6/);
    await assert.rejects(manager.importProfiles({...port,profiles:[{...profile,tls:{...profile.tls,pfxPath:local('test.p12')}}]}),/local paths/);
    assert.equal((await manager.importProfiles(port)).imported,1);
    const row=manager.list()[0];
    assert.equal(row.profile.tls.pfxPath,'');
    assert.deepEqual(manager.datasetProfileSource.list(),[]);
    await assert.rejects(manager.datasetProfileSource.withProfile({id:row.id,revision:row.revision},
      ()=>assert.fail('the background source must remain closed')),/interactive client identity passphrase/);
    assert.deepEqual(manager.exportProfiles(),{...port,profiles:[{...profile,group:'',color:'none',port:3306,ssh:null}]});
    await assert.rejects(manager.connect({id:row.id,clientIdentityPassphrase:'example'}),/Select a local PKCS#12/);
  } finally {await manager.dispose();}
});

test('native commands prompt separately when the database password is already saved and respect cancellation', async () => {
  const profile={...base,tls:{...verified,clientIdentity:'pkcs12',pfxPath:local('test.p12')}};
  const prompts=[],vscode={window:{async showInputBox(input){prompts.push(input);return 'attempt-only';}}};
  assert.deepEqual(await promptProfileCredentials(vscode,{profile,hasSavedPassword:true}),{clientIdentityPassphrase:'attempt-only'});
  assert.equal(prompts.length,1);
  assert.match(prompts[0].prompt,/Client identity/);
  assert.equal(prompts[0].password,true);
  assert.deepEqual(await promptProfileCredentials(vscode,{profile,hasSavedPassword:false}),{password:'attempt-only',clientIdentityPassphrase:'attempt-only'});
  assert.equal(prompts.length,3);
  assert.equal(await promptProfileCredentials({window:{showInputBox:async()=>undefined}},{profile,hasSavedPassword:true}),null);
  const html=connectionHtml('owned-test-nonce');
  assert.match(html,/<option value="pkcs12">PKCS#12/);
  assert.match(html,/<input id="clientPassphrase" type="password" autocomplete="off">/);
});

test('the bundled PKCS#12 reader exactly matches the owned independent Java source', () => {
  assert.equal(require('../src/db/pkcs12-worker-source.json'),fs.readFileSync(path.resolve(__dirname,'../runtime/db-tls/ClientIdentity.java'),'utf8'));
});
