'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {HttpCookieJars}=require('../src/http/cookie-jar');
const {requestAt}=require('../src/http/client');

test('named jars partition by scope, environment, origin and path, and apply explicit expiry',()=>{
  let now=Date.parse('2026-01-01T00:00:00Z');
  const jars=new HttpCookieJars(()=>now);
  const session=(route,owner='workspace-one',environment='dev',name='login')=>
    jars.session(owner,environment,name,new URL(route));
  const first=session('http://localhost:8111/api/login');
  first.capture(['token=some-login-token; HttpOnly','extra=1; Path=/api/by-id','removed=1; Path=/api; Max-Age=1',
    'forged=1; Domain=localhost; Path=/','tls=1; Secure; Path=/']);
  assert.deepEqual(first.info(),{name:'login',sent:0,retained:3});
  assert.equal(session('http://localhost:8111/api/by-id').header,'extra=1; token=some-login-token; removed=1');
  assert.equal(session('http://localhost:8111/api2').header,'');
  assert.equal(session('http://localhost:8112/api/next').header,'');
  assert.equal(session('https://localhost:8111/api/next').header,'');
  assert.equal(session('http://localhost:8111/api/next','workspace-two').header,'');
  assert.equal(session('http://localhost:8111/api/next','workspace-one','prod').header,'');
  assert.equal(session('http://localhost:8111/api/next','workspace-one','dev','other').header,'');
  now+=1000;
  assert.equal(session('http://localhost:8111/api/next').header,'token=some-login-token');
  session('http://localhost:8111/api/logout').capture(['token=; Max-Age=0; Expires=Wed, 21 Oct 2099 07:28:00 GMT']);
  assert.equal(session('http://localhost:8111/api/next').header,'');
  jars.dispose();
  assert.throws(()=>session('http://localhost:8111/api/next'),/named cookie jar/);
});

test('HTTP cookie jars protect secure prefix semantics and mask echoed session values',()=>{
  const jars=new HttpCookieJars();
  const url=new URL('https://example.test/api');
  const capture=jars.session('folder','dev','secure',url);
  capture.capture(['__Host-session=secret-cookie-probe; Secure; HttpOnly; Path=/',
    '__Host-nopath=bad; Secure','__Secure-lie=bad; Path=/','__Host-domain=bad; Path=/; Secure; Domain=example.test']);
  assert.equal(capture.info().retained,1);
  assert.equal(capture.redact('token secret-cookie-probe fell back'),'token [redacted] fell back');
  const second=jars.session('folder','dev','secure',url);
  assert.equal(second.header,'__Host-session=secret-cookie-probe');
  assert.equal(second.redact(second.header),'[redacted]');
});

test('an explicit Cookie header cannot compete with a named jar',()=>{
  const source='# @cookie-jar appLogin\nGET https://example.test';
  assert.equal(requestAt(source,0).cookieJar,'appLogin');
  assert.throws(()=>requestAt(source+'\ncookie: literal=value',0),/no explicit Cookie header/);
  assert.throws(()=>requestAt(source.replace('GET','GRPC'),0),/HTTP request/);
  assert.throws(()=>requestAt('# @cookie-jar another\n'+source,0),/one named/);
});
