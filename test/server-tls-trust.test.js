'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {createConnectionProfiles}=require('../src/db/connection-profiles');
const {reviewedTls,sameReviewedPeer,observeServerTls,guardBeforeAuthentication}=require('../src/db/server-tls-trust');

const base={name:'Owned review',host:'127.0.0.1',port:3306,user:'fixture',database:'app',tls:{mode:'verify',serverName:'db.local'}};
const baseline={hostname:'db.local',leafSha256:'a'.repeat(64),issuerSha256:'b'.repeat(64),caMaterialSha256:null,
  notBefore:'2025-01-01T00:00:00.000Z',notAfter:'2030-01-01T00:00:00.000Z',protocol:'TLSv1.3'};
function setup() {
 const values=new Map(),stored=new Map(),connections=[];
 let current=baseline, failSave=false;
 const api=createConnectionProfiles({
  state:{get:(key,fallback)=>values.get(key)??fallback,async update(key,value){
   if(failSave&&key.endsWith('profiles.v1'))throw Error('owned fixture save fault');
   values.set(key,value);
  }},
  secrets:{get:async key=>stored.get(key),store:async (key,value)=>stored.set(key,value),delete:async key=>stored.delete(key)},
  getActiveProfile:()=>undefined,isTrusted:()=>true,connect:async cfg=>connections.push(reviewedTls(cfg)),disconnect:async()=>{},
  createService:config=>({metadata:async()=>({database:config.database,tables:[],views:[]}),
   _metadataQuery:async sql=>({rows:sql.startsWith('SHOW')?[['Ssl_cipher','TLS_AES_256_GCM_SHA384']]:[['8.4','app','fixture@local']]}),
   serverTlsEvidence:()=>current,dispose:async()=>{}})
 });
 return {api,connections,set current(value){current=value;},set failSave(value){failSave=value;}};
}
const replacement={...baseline,leafSha256:'c'.repeat(64)};
const choose=saved=>({id:saved.id,revision:saved.revision});
const approval=(saved,review)=>({id:saved.id,reviewId:review.reviewId,approved:true});

test('TLS review is bound to current profile revisions, approval and expiry',async t=>{
 const state=setup(),{api}=state;
 t.after(()=>api.dispose());
 const saved=await api.save({profile:base,password:'owned',rememberPassword:true});
 state.current=replacement;
 const review=await api.reviewTlsTrust(choose(saved));
 assert.deepEqual(review.changes,['Server certificate']);
 const newer=await api.save({profile:{...saved.profile,name:'Revised'},expectedRevision:saved.revision,rememberPassword:true});
 await assert.rejects(api.reconnectReviewedTlsTrust(approval(saved,review)),/changed or expired/);
 const now=Date.now();
 const current=await api.reviewTlsTrust(choose(newer));
 t.mock.method(Date,'now',()=>now+180000);
 await assert.rejects(api.reconnectReviewedTlsTrust(approval(newer,current)),/changed or expired/);
 assert.deepEqual(state.connections,[]);
});

test('approved TLS reconnect binds exact identity and reports an unsaved observation accurately',async t=>{
 const state=setup(),{api}=state;
 t.after(()=>api.dispose());
 const saved=await api.save({profile:base,password:'owned',rememberPassword:true});
 state.current=replacement;
 const review=await api.reviewTlsTrust(choose(saved));
 await assert.rejects(api.reconnectReviewedTlsTrust({...approval(saved,review),approved:false}),/Approve/);
 state.failSave=true;
 assert.deepEqual(await api.reconnectReviewedTlsTrust(approval(saved,review)),{connected:true,observationSaved:false});
 assert.deepEqual(state.connections,[replacement]);
 assert.deepEqual(api.list()[0].observed.tlsPeer,baseline);
 await assert.rejects(api.reconnectReviewedTlsTrust(approval(saved,review)),/new TLS trust review/);
 assert.equal(sameReviewedPeer(baseline,replacement),false);
 assert.equal(sameReviewedPeer(replacement,replacement),true);
 assert.equal(observeServerTls({},{}),null);
});

test('TLS gate rejects missing peer evidence before the driver can send authentication',()=>{
 const connection={stream:{},startTLS(onSecure){onSecure();}};
 const gate=guardBeforeAuthentication(connection,{},baseline);
 let credentialResponses=0;
 connection.startTLS(error=>{
  if(!error)credentialResponses++;
  assert.match(error.message,/certificate or trust material changed/);
 });
 assert.equal(credentialResponses,0);
 assert.equal(gate.error.code,'ROCKETBRAIN_TLS_REVIEW_CHANGED');
 assert.equal(gate.evidence,null);
});
