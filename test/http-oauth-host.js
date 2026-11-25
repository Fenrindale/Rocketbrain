'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');

const secret='owned:fixture+marker';

function requestContents(config,name) {
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  return [
    '@base = '+config.baseUrl,'@fixtureClient = fixture app+client',
    '# @oauth-client '+JSON.stringify({tokenUrl:'{{base}}/probe/oauth/token',clientId:'{{fixtureClient}}',
      clientSecret:'{{secret.'+name+'}}',scope:'read:people'}),
    '# @expect status 200','# @check count ["eq","json:$.people",2]',
    'GET {{base}}/probe/oauth/people',''
  ].join('\n');
}

async function exercise(config,send) {
  const before=await fetch(new URL('/probe/oauth/people',config.baseUrl),{signal:AbortSignal.timeout(5000)});
  assert.equal(before.status,401);
  await before.body.cancel();
  await assert.rejects(send('wrong-owned-sample'),/OAuth token endpoint.*HTTP 401/);
  const authenticated=await send(secret);
  assert.equal(authenticated.status,200);
  assert.equal(authenticated.authenticated,'oauth-client-credentials');
  assert.equal(authenticated.assertions.length,2);
  assert.ok(authenticated.assertions.every(item=>item.passed));
  assert.deepEqual(JSON.parse(authenticated.body),{people:2,echo:'Bearer [redacted]'});
  assert.ok(!JSON.stringify(authenticated).includes(secret));
  return {engine:config.dbEngine,clientCredentials:true,tokenAuthRefusedWrongSecret:true,resourceAuthRequired:true,
    exactFormAuthentication:true,redactedBearer:true,springJdbc:2};
}

async function runHttpOAuthChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const id=randomUUID().replaceAll('-',''),name='owned_oauth_'+id;
  const file=path.join(root,'rb-oauth-'+id+'.http'),contents=requestContents(config,name);
  await fs.writeFile(file,contents,{encoding:'utf8',flag:'wx'});
  let document;
  try {
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.languageId,'rocketbrain-http');
    await assert.rejects(api.httpTools.storeSecret(document,{name,value:secret}),/Explicitly select/);
    const proof=await exercise(config,async value=>{
      await api.httpTools.storeSecret(document,{name,value,approved:true});
      return api.httpTools.run(document,contents.lastIndexOf('GET'));
    });
    checks.push('The installed HTTP client used workspace Secret Storage for the owned OAuth exchange and reached the exact Spring/JDBC resource.');
    return {...proof,nativeSecretStorage:true};
  } finally {
    if(document)await api.httpTools.storeSecret(document,{name,value:'',approved:true});
    await fs.unlink(file);
  }
}

module.exports={runHttpOAuthChecks};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const contents=requestContents(config,'owned_oauth');
  const proof=await exercise(config,async value=>{
    const request=await resolveRequest(requestAt(contents,contents.lastIndexOf('GET')),{},name=>{
      assert.equal(name,'owned_oauth');
      return value;
    });
    return sendRequest(request);
  });
  console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
