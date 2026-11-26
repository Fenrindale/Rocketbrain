'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {requestAt,resolveRequest,sendRequest}=require('../src/http/client');
const {readWorkspaceBodyFile}=require('../src/http/body-file');

const payload=Buffer.from([0,255,13,10,0,128,192,16,254,65,1,99]);
const digest=createHash('sha256').update(payload).digest('hex');

async function exerciseHttpBodyFile(root,config,run,{native=false}={}) {
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const directory=await fs.mkdtemp(path.join(root,'rb-binary-request-'));
  const file=path.join(directory,'payload.bin'), request=path.join(directory,'upload.http');
  const relative=path.relative(root,file).split(path.sep).join('/');
  const contents=[
    '# @body-file '+JSON.stringify(relative),
    '# @check digest '+JSON.stringify(['eq','json:$.sha256',digest]),
    '# @check jdbc '+JSON.stringify(['eq','json:$.people',2]),
    '# @expect status 200',
    'POST '+config.baseUrl+'/probe/upload-digest',''
  ].join('\n');
  try {
    await fs.writeFile(file,payload,{flag:'wx'});
    await fs.writeFile(request,contents,{encoding:'utf8',flag:'wx'});
    const response=await run(request,contents);
    assert.equal(response.status,200);
    assert.equal(response.assertions.length,3);
    assert.ok(response.assertions.every(item=>item.passed));
    assert.deepEqual(JSON.parse(response.body),{length:payload.length,sha256:digest,people:2});
    return {engine:config.dbEngine,bytes:payload.length,exactDigest:true,defaultContentType:true,springJdbc:true};
  } finally {
    await fs.unlink(request).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if (native) assert.deepEqual(await fs.readdir(directory),[]);
    else await fs.rmdir(directory);
  }
}

async function runHttpBodyFileChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const proof=await exerciseHttpBodyFile(root,config,async(file,contents)=>{
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.languageId,'rocketbrain-http');
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    const where=document.positionAt(contents.lastIndexOf('POST'));
    editor.selection=new vscode.Selection(where,where);
    try { return await vscode.commands.executeCommand('rocketbrain.http.run'); }
    finally {
      if (vscode.window.activeTextEditor?.document===document) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  },{native:true});
  checks.push('The installed request command uploaded exact binary workspace bytes and verified a real Spring digest and JDBC count.');
  return {...proof,nativeCommand:true};
}

module.exports={runHttpBodyFileChecks};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const folder=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-http-binary-'));
  try {
    const proof=await exerciseHttpBodyFile(folder,config,async(_,contents)=>{
      const request=requestAt(contents,contents.lastIndexOf('POST'));
      return sendRequest(await resolveRequest(request,{},()=>{throw Error('Unexpected secret read.');},{
        readBodyFile:(name,max)=>readWorkspaceBodyFile(folder,name,max)
      }));
    });
    console.log(JSON.stringify(proof));
  } finally { await fs.rmdir(folder); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
