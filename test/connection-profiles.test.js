'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createConnectionProfiles,normalizeProfile}=require('../src/db/connection-profiles');
const base=()=>({name:'Local dev',host:'127.0.0.1',port:3306,user:'dev',database:'app',group:'Development',color:'blue',tls:{mode:'disabled'}});
function setup(){const values=new Map(),secretValues=new Map();let connected,closed=0,secretReads=0,failVerify=false,failUpdate=false,trusted=true;const state={get:(k,d)=>values.get(k)??d,async update(k,v){if(failUpdate&&k.endsWith('profiles.v1'))throw Error('disk');values.set(k,structuredClone(v));}},secrets={get:async k=>{secretReads++;return secretValues.get(k);},store:async(k,v)=>secretValues.set(k,v),delete:async k=>secretValues.delete(k)};const api=createConnectionProfiles({state,secrets,isTrusted:()=>trusted,getActiveProfile:()=>connected?{id:connected.id}:null,connect:async config=>{connected={...config};},disconnect:async()=>{connected=undefined;},createService:config=>({async metadata(){if(failVerify)throw Error('password='+config.password);return{database:config.database,tables:[],views:[]};},async _metadataQuery(sql){return{rows:sql.startsWith('SELECT VERSION')?[['8.4','app','dev@localhost']]:sql.startsWith('SHOW')?[['Ssl_cipher','']]:[['app']]};},async dispose(){closed++;}})});return{api,values,secretValues,get closed(){return closed;},get secretReads(){return secretReads;},get connected(){return connected;},set failVerify(v){failVerify=v;},set failUpdate(v){failUpdate=v;},set trusted(v){trusted=v;}};}
test('verified profiles persist metadata separately from credentials and connect without another save',async()=>{const s=setup();try{const r=await s.api.save({profile:base(),password:'private-value',rememberPassword:true});assert.equal(r.hasSavedPassword,true);assert.equal(s.secretValues.size,1);assert.ok(!JSON.stringify([...s.values]).includes('private-value'));assert.equal(s.closed,1);await s.api.connect({id:r.id});assert.equal(s.connected.password,'private-value');const exported=s.api.exportProfiles();assert.equal(exported.credentialsIncluded,false);assert.ok(!JSON.stringify(exported).includes('private-value'));assert.equal(exported.profiles[0].id,undefined);}finally{await s.api.dispose();}});
test('failed verification never stores secrets and sanitized errors do not echo them',async()=>{const s=setup();s.failVerify=true;try{await assert.rejects(s.api.save({profile:base(),password:'secret-not-in-error',rememberPassword:true}),e=>!e.message.includes('secret-not-in-error'));assert.equal(s.secretValues.size,0);assert.equal(s.api.list().length,0);assert.equal(s.closed,1);}finally{await s.api.dispose();}});
test('metadata save failure restores the previous Secret Storage value',async()=>{const s=setup();try{const r=await s.api.save({profile:base(),password:'old',rememberPassword:true});s.failUpdate=true;await assert.rejects(s.api.save({profile:r.profile,expectedRevision:r.revision,password:'new',rememberPassword:true}),/could not be saved/);assert.deepEqual([...s.secretValues.values()],['old']);assert.equal(s.api.list()[0].revision,r.revision);}finally{await s.api.dispose();}});
test('stale editors cannot overwrite a saved profile',async()=>{const s=setup();try{const r=await s.api.save({profile:base(),verify:false});await s.api.save({profile:{...r.profile,name:'Changed'},expectedRevision:r.revision,verify:false});await assert.rejects(s.api.save({profile:r.profile,expectedRevision:r.revision,verify:false}),/stale/);assert.equal(s.api.list()[0].profile.name,'Changed');}finally{await s.api.dispose();}});
test('credential-free import validates the whole batch before changing state or opening a socket',async()=>{const s=setup();try{await assert.rejects(s.api.importProfiles({format:'RocketbrainConnectionProfiles',version:1,credentialsIncluded:false,profiles:[base(),{...base(),password:'leak'}]}),/unsupported/);assert.equal(s.api.list().length,0);assert.equal(s.closed,0);const imported=await s.api.importProfiles({format:'RocketbrainConnectionProfiles',version:1,credentialsIncluded:false,profiles:[base()]});assert.equal(imported.connectionsAttempted,0);assert.equal(s.api.list().length,1);assert.equal(s.secretValues.size,0);}finally{await s.api.dispose();}});
test('TLS numeric addresses require a certificate DNS name and client keys are paired',()=>{assert.throws(()=>normalizeProfile({...base(),tls:{mode:'verify'}}),/DNS/);assert.throws(()=>normalizeProfile({...base(),tls:{mode:'verify',serverName:'localhost',certPath:require('node:path').resolve('client.pem')}}),/both/);assert.throws(()=>normalizeProfile({...base(),password:'no'}),/unsupported/);});
test('trust loss and disposal stop profile operations',async()=>{const s=setup();s.trusted=false;await assert.rejects(s.api.save({profile:base(),verify:false}),/Trust/);s.trusted=true;await s.api.dispose();await assert.rejects(s.api.test({profile:base()}),/closed/);});
test('save and connect uses the verified private credential even when remembering is disabled',async()=>{const s=setup();try{const first=await s.api.save({profile:base(),password:'private-reused',rememberPassword:true});const result=await s.api.save({profile:first.profile,expectedRevision:first.revision,rememberPassword:false,connectAfterSave:true});assert.equal(result.connected,true);assert.equal(result.hasSavedPassword,false);assert.equal(s.connected.password,'private-reused');assert.equal(s.secretValues.size,0);assert.ok(!JSON.stringify(result).includes('private-reused'));}finally{await s.api.dispose();}});
test('import cannot overwrite an existing profile identity or attached secret',async()=>{const s=setup();try{const r=await s.api.save({profile:base(),password:'existing',rememberPassword:true});await s.api.importProfiles({format:'RocketbrainConnectionProfiles',version:1,credentialsIncluded:false,profiles:[{...r.profile,name:'Imported'}]});assert.equal(s.api.list().length,2);assert.equal(s.api.list().find(v=>v.id===r.id).profile.name,'Local dev');assert.deepEqual([...s.secretValues.values()],['existing']);}finally{await s.api.dispose();}});

test('local profiles export without endpoint paths and import unconfigured alongside legacy TCP profiles', async t => {
  const source = setup(), target = setup();
  t.after(() => Promise.all([source.api.dispose(), target.api.dispose()]));
  const { host, port, ...common } = base();
  await source.api.save({ profile: base(), verify: false });
  const local = await source.api.save({
    profile: { ...common, name: 'Private socket', transport: { kind: 'unix-socket', address: '/run/local/mysql.sock' } },
    password: 'private-password', rememberPassword: true
  });
  assert.deepEqual(local.observed.transport, { kind: 'unix-socket' });
  const shared = source.api.exportProfiles();
  assert.equal(shared.version, 2);
  assert.equal(shared.credentialsIncluded, false);
  assert.deepEqual(shared.profiles.find(item => item.transport).transport, { kind: 'unix-socket' });
  assert.ok(!JSON.stringify(shared).includes('/run/local/mysql.sock'));
  assert.ok(!JSON.stringify(shared).includes('private-password'));
  await assert.rejects(target.api.importProfiles({
    ...shared, profiles: shared.profiles.map(item => item.transport ? {
      ...item, transport: { ...item.transport, address: '/run/imported.sock' }
    } : item)
  }), /Re-enter local socket paths/);
  assert.equal(target.api.list().length, 0);
  assert.deepEqual(await target.api.importProfiles(shared), { imported: 2, connectionsAttempted: 0 });
  const reopened = target.api.list().find(item => item.profile.transport);
  assert.deepEqual(reopened.profile.transport, { kind: 'unix-socket' });
  assert.equal(target.api.list().find(item => !item.profile.transport).profile.host, host);
  assert.equal(target.api.list().find(item => !item.profile.transport).profile.port, port);
  await assert.rejects(target.api.connect({ id: reopened.id }), /Edit this profile/);
  assert.equal(target.connected, undefined);
  await target.api.save({ profile: {
    ...reopened.profile, transport: { kind: 'unix-socket', address: '/run/reviewed.sock' }
  }, expectedRevision: reopened.revision, connectAfterSave: true, password: 'new' });
  assert.deepEqual(target.connected.transport, { kind: 'unix-socket', address: '/run/reviewed.sock' });
  assert.equal(target.connected.host, undefined);
  assert.equal(target.connected.port, undefined);
});

test('changing a local endpoint never reuses the saved password for another route', async t => {
  const s = setup();
  t.after(() => s.api.dispose());
  const { host, port, ...common } = base();
  const local = { ...common, transport: { kind: 'named-pipe', address: 'MySQL' } };
  const saved = await s.api.save({ profile: local, password: 'private-credential', rememberPassword: true });
  await s.api.connect({ id: saved.id });
  assert.equal(s.connected.password, 'private-credential');
  const amended = { ...saved.profile, transport: { kind: 'named-pipe', address: 'different' } };
  await s.api.save({ profile: amended, expectedRevision: saved.revision, connectAfterSave: true });
  assert.equal(s.connected.password, '');
  assert.equal(s.secretValues.size, 0);
  for (const mixed of [{ host }, { port }, { tls: { mode: 'verify' } }, { ssh: { host: 'example.test' } }]) {
    assert.throws(() => normalizeProfile({ ...local, ...mixed }), /cannot be combined/);
  }
});

test('duplicate allocates independent identities and never reads or copies saved credentials', async t => {
  const state = setup();
  t.after(() => state.api.dispose());
  const source = await state.api.save({ profile: base(), password: 'kept-at-source', rememberPassword: true });
  const first = await state.api.duplicate({ id: source.id, revision: source.revision });
  const second = await state.api.duplicate({ id: source.id, revision: source.revision });
  assert.notEqual(first.id, source.id);
  assert.notEqual(first.id, second.id);
  assert.equal(first.profile.name, 'Local dev (copy)');
  assert.equal(second.profile.name, 'Local dev (copy 2)');
  assert.equal(first.verifiedAt, null);
  assert.equal(first.hasSavedPassword, false);
  assert.deepEqual([...state.secretValues.values()], ['kept-at-source']);
  assert.equal(state.closed, 1);
  await assert.rejects(state.api.duplicate({ id: source.id, revision: source.revision - 1 }), /profile changed/);
  await state.api.connect({ id: first.id });
  assert.equal(state.connected.password, '');
});

test('reviewed imports reserve original labels, support skip, and reject stale collision plans', async t => {
  const state = setup();
  t.after(() => state.api.dispose());
  const original = await state.api.save({ profile: base(), password: 'never-shared', rememberPassword: true });
  const output = state.api.exportProfiles();
  const value = { ...output, profiles: [{ ...output.profiles[0], name: 'LOCAL DEV' },
    { ...output.profiles[0], name: 'Local dev (copy)' }] };
  const review = state.api.reviewProfileImport(value);
  assert.equal(review.conflicts, 1);
  const edited = { ...value, profiles: [value.profiles[0]] };
  await assert.rejects(state.api.importProfiles(edited, { review, strategy: 'rename' }), /Review the import again/);
  assert.deepEqual(await state.api.importProfiles(value, { review, strategy: 'rename' }),
    { imported: 2, connectionsAttempted: 0, skipped: 0, renamed: 1 });
  assert.ok(state.api.list().some(row => row.profile.name === 'Local dev (copy)'));
  assert.ok(state.api.list().some(row => row.profile.name === 'LOCAL DEV (copy 2)'));
  await assert.rejects(state.api.importProfiles(value, { review, strategy: 'skip' }), /Review the import again/);
  const latest = state.api.reviewProfileImport(value);
  assert.equal(latest.conflicts, 2);
  assert.deepEqual(await state.api.importProfiles(value, { review: latest, strategy: 'skip' }),
    { imported: 0, connectionsAttempted: 0, skipped: 2, renamed: 0 });
  assert.equal(state.api.list().find(row => row.id === original.id).revision, original.revision);
  assert.deepEqual([...state.secretValues.values()], ['never-shared']);
  assert.equal(state.closed, 1);
});

test('explicit password-free authentication skips the prior credential and clears its saved storage',async t=>{
  const state=setup(),{api}=state;
  t.after(()=>api.dispose());
  const previous=await api.save({profile:base(),password:'old-owned-password',rememberPassword:true});
  const profile={...previous.profile,auth:{kind:'password-free'}};
  const before=state.secretReads;
  await assert.rejects(api.test({profile,password:'old-owned-password'}),/without a database password/);
  await assert.rejects(api.save({profile,expectedRevision:previous.revision,rememberPassword:true}),/cannot save/);
  await api.test({profile});
  assert.equal(state.secretReads,before);
  assert.deepEqual([...state.secretValues.values()],['old-owned-password']);
  const saved=await api.save({profile,expectedRevision:previous.revision});
  assert.equal(saved.hasSavedPassword,false);
  assert.equal(state.secretValues.size,0);
  const after=state.secretReads;
  await api.connect({id:saved.id});
  await api.schemas({id:saved.id});
  assert.deepEqual(state.connected.auth,{kind:'password-free'});
  assert.equal(state.connected.user,'dev');
  assert.equal(state.connected.password,'');
  assert.equal(state.secretReads,after);
  await assert.rejects(api.connect({id:saved.id,password:'not used'}),/without a database password/);
});

test('a vanished remembered password stops before opening the conventional connection',async t=>{
  const state=setup(),{api}=state;
  t.after(()=>api.dispose());
  const saved=await api.save({profile:base(),password:'temporarily-saved',rememberPassword:true});
  state.secretValues.clear();
  await assert.rejects(api.connect({id:saved.id}),/saved database password is unavailable/);
  assert.equal(state.connected,undefined);
  await api.connect({id:saved.id,password:'chosen-again'});
  assert.equal(state.connected.password,'chosen-again');
});

test('v8 exports only password-free intent and retains independent v7 and v2 route handling',async t=>{
  const state=setup(),{api}=state;
  t.after(()=>api.dispose());
  const auth={kind:'password-free'};
  assert.throws(()=>normalizeProfile({...base(),user:'',auth}),/database user/);
  assert.throws(()=>normalizeProfile({...base(),auth:{...auth,password:'invalid'}}),/unsupported fields/);
  const {host,port,...common}=base();
  const local={...common,auth,transport:{kind:'unix-socket',address:'/run/local/mysql.sock'}};
  await api.save({profile:local});
  const jks={...base(),name:'Trust too',auth,tls:{mode:'verify',serverName:'db.local',serverTrust:'jks'}};
  const shared=api.exportProfiles();
  assert.equal(shared.version,8);
  assert.equal(shared.credentialsIncluded,false);
  assert.deepEqual(shared.profiles[0].transport,{kind:'unix-socket'});
  assert.deepEqual(shared.profiles[0].auth,auth);
  await assert.rejects(api.importProfiles({...shared,version:7,profiles:[jks]}),/format 8/);
  await api.importProfiles({...shared,profiles:[jks]});
  assert.equal(api.exportProfiles().profiles.find(row=>row.name===jks.name).tls.serverTrust,'jks');
  const imported=api.list().find(row=>row.profile.name===jks.name);
  assert.equal(imported.profile.tls.trustStorePath,'');
  await assert.rejects(api.connect({id:imported.id}),/Select a local JKS server truststore/);
});

test('password-free profile prompts remain separate from local TLS trust inputs',async()=>{
  const {connectionHtml,promptProfileCredentials}=require('../src/db/connection-profiles-vscode');
  const profile=normalizeProfile({...base(),auth:{kind:'password-free'}});
  assert.match(connectionHtml('owned-fixture'),/value="password-free">No password/);
  let prompts=0;
  const ui={window:{async showInputBox(options){prompts++;assert.match(options.prompt,/^JKS truststore passphrase/);return 'fixture-passphrase';}}};
  assert.deepEqual(await promptProfileCredentials(ui,{profile,hasSavedPassword:false}),{});
  const tls={mode:'verify',serverName:'db.local',serverTrust:'jks',trustStorePath:require('node:path').resolve('fixture-trust.jks')};
  const withTrust=normalizeProfile({...profile,tls});
  assert.deepEqual(await promptProfileCredentials(ui,{profile:withTrust,hasSavedPassword:false}),
    {trustStorePassphrase:'fixture-passphrase'});
  assert.equal(prompts,1);
});

const browser=require('./helpers/browser-runtime').browserRuntime();
test('the editor clears and disables password inputs in the explicit mode for TCP and local transports',{
  skip:browser.skip,timeout:30000
},async t=>{
  const {connectionHtml}=require('../src/db/connection-profiles-vscode');
  const chromium=await browser.chromium.launch({executablePath:browser.executablePath,headless:true});
  t.after(()=>chromium.close());
  const page=await chromium.newPage(),requests=[];
  await page.exposeFunction('submitProfile',request=>requests.push(request));
  await page.evaluate(()=>{window.acquireVsCodeApi=()=>({postMessage:message=>window.submitProfile(message)});});
  await page.setContent(connectionHtml('owned-test-nonce'));
  const send=data=>page.evaluate(value=>window.dispatchEvent(new MessageEvent('message',{data:value})),data);
  await send({type:'model',editorId:'owned',profile:base(),hasSavedPassword:true});
  await page.locator('#password').fill('remove-this-before-posting');
  await page.locator('#authKind').selectOption('password-free');
  assert.equal(await page.locator('#password').isDisabled(),true);
  assert.equal(await page.locator('#password').isVisible(),false);
  assert.equal(await page.locator('#password').inputValue(),'');
  assert.equal(await page.locator('#remember').isChecked(),false);
  await page.locator('[data-action=test]').click();
  const tcp=requests.at(-1);
  assert.deepEqual(tcp.profile.auth,{kind:'password-free'});
  assert.equal(tcp.profile.host,'127.0.0.1');
  assert.equal(tcp.password,undefined);
  assert.equal(tcp.rememberPassword,false);
  await send({type:'result',result:{database:'app',serverVersion:'8.4'}});
  await page.locator('#transport').selectOption('named-pipe');
  await page.locator('#transportPath').fill('MySQL');
  assert.equal(await page.locator('#authKind').isVisible(),true);
  assert.equal(await page.locator('#rds-auth-option').evaluate(option=>option.disabled),true);
  await page.locator('[data-action=save]').click();
  const local=requests.at(-1);
  assert.deepEqual(local.profile.auth,{kind:'password-free'});
  assert.deepEqual(local.profile.transport,{kind:'named-pipe',address:'MySQL'});
  assert.equal(local.password,undefined);
  assert.equal(local.rememberPassword,false);
});
