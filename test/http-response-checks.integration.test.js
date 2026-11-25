'use strict';

const test=require('node:test');
const fs=require('node:fs/promises');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');
const {exerciseHttpResponseChecks}=require('./http-client-host');

const fixture=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('owned Spring JDBC reports passing and failing response check branches', {skip:!fixture}, async()=>{
  const config=JSON.parse(await fs.readFile(fixture,'utf8'));
  const proof=await exerciseHttpResponseChecks(config,async contents=>sendRequest(
    await resolveRequest(requestAt(contents,contents.lastIndexOf('GET')),{},()=>{})));
  console.log(JSON.stringify(proof));
});
