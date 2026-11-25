'use strict';

const assert=require('node:assert/strict'), test=require('node:test');
const {accountTarget,statement,plan,apply}=require('../src/db/database-password-rotation');

const identity={dialect:'mysql',database:'app',sqlMode:'NO_BACKSLASH_ESCAPES',currentUser:'operator@127.0.0.1',endpoint:{host:'127.0.0.1',port:3306}};
const target={user:'app_user',host:'127.0.0.1'};
test('account rotation pins an explicit exact ordinary login and uses vendor-specific password syntax',()=>{
  assert.deepEqual(accountTarget(target,identity),target);
  assert.deepEqual(accountTarget({user:'app_user',host:'LOCALHOST'},identity),{user:'app_user',host:'LOCALHOST'});
  assert.throws(()=>accountTarget({user:'operator',host:'127.0.0.1'},identity),/protected/);
  assert.throws(()=>accountTarget({user:'mysql.sys',host:'localhost'},identity),/protected/);
  assert.throws(()=>accountTarget({user:'app_user',host:'%'},identity),/explicit account host/);
  assert.throws(()=>accountTarget({...target,password:'extra'},identity),/exact observed account/);
  assert.match(statement(target,'mysql'),/IDENTIFIED WITH caching_sha2_password BY <password supplied on apply>$/u);
  assert.match(statement(target,'mariadb'),/IDENTIFIED VIA mysql_native_password USING PASSWORD\(<password supplied on apply>\)$/u);
});

test('rotation stores no raw verifier and does not proceed after an exact credential change',async()=>{
  const wires=[], stamps=['f'.repeat(64),'a'.repeat(64)];
  let current=0, writes=0;
  const session={connected:true};
  const db={_schemaRenamer:{
    _withSession:action=>action(session),
    _identity:async()=>identity,
    async _read(_session,sql,values) {
      wires.push([sql,values]);
      if(sql.includes('FROM mysql.user u')) return [[target.user,target.host,'caching_sha2_password','N','N',0,stamps[current],
        '',null,null,null,0,0,0,0,'N','N','N',null,null,null,null]];
      if(sql.includes('GET_LOCK'))return [[1]];
      return [];
    }
  },_control:async()=>{writes++;return {};}};
  const lease={db,guard:()=>true};
  const reviewed=await plan(lease,target);
  assert.match(wires[0][0],/SHA2\(CONCAT\(\?,CAST\(u.authentication_string AS BINARY\)\),256\)/u);
  assert.match(wires[0][1][0],/^[a-f0-9]{64}$/u);
  current=1;
  await assert.rejects(apply(lease,reviewed,'example'),/credential, roles or connection changed/);
  assert.equal(writes,0);
});

test('password rotation requires an observed encrypted session before submitting a password over a remote route',async()=>{
  const remote={...identity,endpoint:{host:'example.invalid',port:3306}};
  const session={connected:true},wires=[];
  let options={},cipher='';
  const db={get _options(){return options;},_schemaRenamer:{
    _withSession:action=>action(session),
    _identity:async()=>remote,
    async _read(_session,sql){
      wires.push(sql);
      if(sql.includes('Ssl_cipher'))return [['Ssl_cipher',cipher]];
      return [];
    }
  },_control:async()=>assert.fail('No credential statement was expected')};
  const lease={db,guard:()=>true},reviewed={identity:remote,target};
  await assert.rejects(plan(lease,target),/verified TLS/);
  assert.deepEqual(wires,[]);
  options={ssl:{rejectUnauthorized:true,verifyIdentity:true}};
  await assert.rejects(apply(lease,reviewed,'example'),/verified TLS/);
  assert.deepEqual(wires,["SHOW SESSION STATUS LIKE 'Ssl_cipher'"]);
  cipher='TLS_AES_256_GCM_SHA384';
  await assert.rejects(plan(lease,target),/exact login account is unavailable/);
  assert.match(wires.at(-1),/FROM mysql.user/);
});
