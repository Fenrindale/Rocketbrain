'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const { setTimeout:pause }=require('node:timers/promises');
const { startSshWorkspace }=require('./helpers/ssh-workspace-fixture');
const { jdbcReadback }=require('./java-source-analysis-host');
const { connectWorkspace }=require('../src/remote/ssh-workspace');
const { createSshFileWatch }=require('../src/remote/ssh-file-watch');
const { until }=require('./helpers/stdio-lsp');

function fixturePython() {
  return process.env.ROCKETBRAIN_SSH_TEST_PYTHON || process.env.ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON;
}

async function verifyHeadless() {
  const fixture=await startSshWorkspace(fixturePython(),path.resolve(__dirname,'../test-output'));
  let client;
  const changes=[], batches=[];
  const proxy={async observe(paths) {
    const observations=await client.observe(paths);
    batches.push(paths);
    return observations;
  }};
  const watcher=createSshFileWatch({connection:()=>client && proxy,notify:items=>changes.push(...items),interval:160});
  const uri=value=>({path:value,toString:()=>value});
  try {
    client=await connectWorkspace(fixture.profile);
    const first='/RemoteController.java', second='/Added.txt';
    const secondFile=path.join(fixture.profile.root,'Added.txt');
    const original=await client.observe([first,second]);
    assert.equal(original[0].kind,'file');
    assert.equal(original[1],null);
    await assert.rejects(client.observe(['/../outside.txt']),/unsupported segment/u);
    await assert.rejects(client.observe(Array(65).fill(first)),/up to 64/u);
    const one=watcher.watch(uri(first));
    const duplicate=watcher.watch(uri(first));
    const two=watcher.watch(uri(second));
    await until(()=>batches.length && fixture.observations()>=2,10000);
    assert.deepEqual(batches[0],[first,second]);
    assert.equal(changes.length,0);
    duplicate.dispose();
    const text=fixture.original.replace('42','43');
    await fs.writeFile(fixture.file,text);
    await fs.writeFile(secondFile,'first\n',{flag:'wx'});
    const event=(value,type)=>changes.some(item=>item.uri.path===value && item.type===type);
    await until(()=>event(first,'changed') && event(second,'created'),10000);
    assert.equal((await client.read(first)).data.toString(),text);
    assert.equal(changes.filter(item=>item.uri.path===first && item.type==='changed').length,1);
    await fs.unlink(secondFile);
    await until(()=>event(second,'deleted'),10000);
    await fs.writeFile(secondFile,'second\n',{flag:'wx'});
    await until(()=>changes.filter(item=>item.uri.path===second && item.type==='created').length===2,10000);
    one.dispose();two.dispose();
    await pause(800);
    const ended=fixture.observations();
    await fs.writeFile(fixture.file,fixture.original);
    await pause(800);
    assert.equal(fixture.observations(),ended);
    assert.deepEqual(changes.map(({type})=>type).sort(),['changed','created','created','deleted']);
    return {pinnedOpenSsh:true,sameSizeContentChanged:true,creationDeletionAndReturn:true,
      batchedTwoPaths:true,duplicateRegistrationCoalesced:true,stopsAfterRelease:true,jdbc:await jdbcReadback()};
  } finally { watcher.reset();client?.close();await fixture.close(); }
}

async function runSshWatchChecks(api,vscode,checks) {
  const fixture=await startSshWorkspace(fixturePython(),vscode.workspace.workspaceFolders[0].uri.fsPath);
  let root;
  try {
    const second=path.join(fixture.profile.root,'Note.txt');
    await fs.writeFile(second,'before\n',{flag:'wx'});
    root=await api.sshWorkspace.attach(fixture.profile);
    const firstUri=vscode.Uri.joinPath(root,'RemoteController.java');
    const secondUri=vscode.Uri.joinPath(root,'Note.txt');
    const document=await vscode.workspace.openTextDocument(firstUri);
    await vscode.window.showTextDocument(document,{preview:false});
    const note=await vscode.workspace.openTextDocument(secondUri);
    await vscode.window.showTextDocument(note,{preview:false});
    assert.equal(document.getText(),fixture.original);
    assert.equal(note.getText(),'before\n');
    const observations=fixture.observations();
    await until(()=>fixture.observations()>observations,18000);
    const updated=fixture.original.replace('42','43');
    await fs.writeFile(fixture.file,updated);
    await fs.writeFile(second,'after\n');
    await until(()=>document.getText()===updated && note.getText()==='after\n',18000);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(firstUri)).toString(),updated);
    await assert.rejects(vscode.workspace.fs.writeFile(secondUri,Buffer.from('rejected')));
    assert.equal(await fs.readFile(second,'utf8'),'after\n');
    checks.push('Two SSH editors refreshed after independent remote writes and the read-only provider preserved the current server bytes.');
    return {nativeEditorRefresh:true,remoteDocuments:2,readOnlyPreserved:true,jdbc:await jdbcReadback()};
  } finally {
    if (root) {
      const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input?.uri?.authority===root.authority);
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      api.sshWorkspace.close();
    }
    await fixture.close();
  }
}

module.exports={runSshWatchChecks};
if (require.main===module) verifyHeadless().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
