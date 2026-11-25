'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {webDavFixture}=require('./helpers/webdav-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');

async function runWebDavChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const root=await fs.mkdtemp(path.join(workspace,'rb-webdav-'));
  const server=await webDavFixture();
  const names=['alpha.txt','도구.bin','skip.txt'];
  try {
    const commands=await vscode.commands.getCommands(true);
    for(const name of ['reviewWebDav','compareWebDav','applyWebDav','saveWebDavPassword'])assert.ok(commands.includes('rocketbrain.deploy.'+name));
    await fs.writeFile(path.join(root,names[0]),'new after review\n',{flag:'wx'});
    await fs.writeFile(path.join(root,names[1]),Buffer.from([0,29,255]),{flag:'wx'});
    await fs.writeFile(path.join(root,names[2]),'excluded',{flag:'wx'});
    server.set(names[0],'remote before\n');
    const input={root,workspaceRoot:workspace,url:server.url,remoteDirectory:'deploy',user:server.user,password:server.password,
      files:names,exclusions:['skip.*']};
    const review=await api.webdav.prepare(input);
    const shown=await api.webdav.publish(review);
    const document=await vscode.workspace.openTextDocument(shown);
    assert.match(document.getText(),/excluded · skip\.txt/);
    const pair=await api.webdav.diff(review,names[0]);
    assert.equal((await vscode.workspace.openTextDocument(pair.remote)).getText(),'remote before\n');
    assert.equal((await vscode.workspace.openTextDocument(pair.local)).getText(),'new after review\n');
    const applied=await api.webdav.apply(review.id,[names[0],names[1]]);
    assert.deepEqual(applied.files.map(item=>item.state),['uploaded','uploaded']);
    assert.deepEqual(server.files.get(names[1]).bytes,Buffer.from([0,29,255]));
    assert.ok(!server.observed.some(record=>record.name===names[2]));
    await fs.writeFile(path.join(root,names[0]),'another local version');
    const second=await api.webdav.prepare(input);
    server.set(names[0],'external version');
    const conflict=await api.webdav.apply(second.id,[names[0]]);
    assert.equal(conflict.files[0].state,'conflict');
    assert.equal(conflict.files[0].httpStatus,412);
    const jdbc=await jdbcReadback();
    checks.push('Native WebDAV showed a reviewed diff, applied changed and new bytes, excluded a selected file and rejected a concurrent remote replacement.');
    return { mappedDirectory:true, nativeDiff:true, uploaded:2, binaryExact:true, excluded:true, remoteConflict:412,jdbc };
  } finally {
    await server.close();
    for(const name of names)await fs.unlink(path.join(root,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.rmdir(root);
  }
}

module.exports={runWebDavChecks};
