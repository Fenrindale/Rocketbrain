'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');
const {HttpCookieJars}=require('../src/http/cookie-jar');

async function exerciseCookieJar(config,run) {
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const jar='fixtureSession';
  const request=(method,route,session)=>run([
    ...(session?['# @cookie-jar '+session]:[]),
    method+' '+config.baseUrl+'/probe/session/'+route
  ].join('\n'));
  const before=await request('GET','state');
  assert.equal(before.status,401);
  const started=await request('POST','start',jar);
  assert.equal(started.status,200);
  assert.deepEqual(started.cookies,{name:jar,sent:0,retained:2});
  assert.equal(new Map(started.headers).get('set-cookie'),'[redacted]');
  assert.equal((await request('GET','state','anotherSession')).status,401);
  assert.equal((await request('GET','state')).status,401);
  const reply=await request('GET','state',jar);
  assert.equal(reply.status,200);
  assert.deepEqual(reply.cookies,{name:jar,sent:2,retained:2});
  assert.deepEqual(JSON.parse(reply.body),{people:2,echo:'[redacted]'});
  const ended=await request('POST','end',jar);
  assert.deepEqual(ended.cookies,{name:jar,sent:2,retained:0});
  assert.equal((await request('GET','state',jar)).status,401);
  return {engine:config.dbEngine,serverIssuedCookies:2,sameJarAuthentication:true,separateJarRefused:true,
    unoptedRequestRefused:true,maxAgeLogout:true,echoRedacted:true,springJdbc:2};
}

async function runHttpCookieJarChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const proof=await exerciseCookieJar(config,async contents=>{
    const file=path.join(root,'rb-session-'+randomUUID()+'.http');
    await fs.writeFile(file,contents,{encoding:'utf8',flag:'wx'});
    try {
      const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      assert.equal(document.languageId,'rocketbrain-http');
      return await api.httpTools.run(document,contents.lastIndexOf(config.baseUrl));
    } finally { await fs.unlink(file); }
  });
  checks.push('The installed HTTP client kept both cookies in the chosen local jar, authenticated against Spring/JDBC, and expired them on logout.');
  return {...proof,nativeCookieJar:true};
}

module.exports={runHttpCookieJarChecks};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const jars=new HttpCookieJars();
  try {
    const proof=await exerciseCookieJar(config,async contents=>{
      const request=await resolveRequest(requestAt(contents,0),{},()=>{throw Error('Unexpected secret read.');});
      const cookieSession=request.cookieJar&&jars.session('fixture','default',request.cookieJar,request.url);
      return sendRequest(request,{cookieSession});
    });
    console.log(JSON.stringify(proof));
  } finally { jars.dispose(); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
