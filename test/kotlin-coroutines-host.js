'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { importedSpring,jdbcReadback }=require('./java-source-analysis-host');
const { buildCoroutineFixture,launchCoroutineFixture }=require('./helpers/coroutine-fixture');
const { readCoroutineDescriptor,fetchCoroutineSnapshot }=require('../src/java/kotlin-coroutine-probe');

async function runKotlinCoroutineChecks(api,vscode,checks) {
  const service=api.java.coroutines;
  assert.ok(service?.prepare && service?.connect && service?.refresh && service?.disconnect);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands=await vscode.commands.getCommands(true);
  for (const name of ['prepare','connect','refresh','disconnect','openFrame']) assert.ok(commands.includes('rocketbrain.coroutines.'+name));
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-coro-'));
  let prepared, child;
  try {
    const config=vscode.workspace.getConfiguration('rocketbrain.java');
    const javaHome=config.get('javaHome')||api.java.getState().javaHome;
    const gradleHome=process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME || config.get('gradleHome');
    const fixture=await buildCoroutineFixture(root,{javaHome,gradleHome,gradleUserHome:process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME});
    await assert.rejects(service.prepare({debugJar:fixture.debugJar}),/Explicitly prepare/);
    prepared=await service.prepare({debugJar:fixture.debugJar,allowProbeWrites:true});
    child=launchCoroutineFixture(fixture,prepared);
    await child.ready();
    const model=await service.connect({descriptorFile:prepared.descriptor});
    assert.equal(model.pid,child.pid);
    assert.equal(model.creationEnabled,true);
    await vscode.commands.executeCommand('rocketbrain.kotlinCoroutines.focus');
    const refreshed=await vscode.commands.executeCommand('rocketbrain.coroutines.refresh');
    assert.equal(refreshed.pid,child.pid);
    const ordinal=refreshed.coroutines.findIndex(item=>item.name==='awaiting-invoice');
    assert.ok(ordinal>=0);
    const awaiting=refreshed.coroutines[ordinal], processing=refreshed.coroutines.find(item=>item.name==='processing-order');
    assert.equal(awaiting.state,'SUSPENDED');
    assert.equal(processing.state,'RUNNING');
    const rootOrdinal=refreshed.coroutines.findIndex(item=>item.name==='fixture-root');
    const branchOrdinal=refreshed.coroutines.findIndex(item=>item.name==='fixture-branch');
    assert.ok(rootOrdinal>=0&&branchOrdinal>=0);
    assert.equal(awaiting.parentOrdinal,rootOrdinal);
    assert.equal(processing.parentOrdinal,rootOrdinal);
    assert.equal(refreshed.coroutines[branchOrdinal].parentOrdinal,rootOrdinal);
    assert.deepEqual(new Set(refreshed.coroutines.filter(item=>item.name==='same-name').map(item=>item.parentOrdinal)),
      new Set([rootOrdinal,branchOrdinal]));
    const creation=awaiting.creation.findIndex(frame=>frame.file==='Main.kt' && frame.line===17);
    const observation=awaiting.observed.findIndex(frame=>frame.file==='Main.kt' && frame.line===18);
    assert.ok(creation>=0 && observation>=0);
    const kotlinFile=path.join(root,'src/main/kotlin/coroutinesfixture/Main.kt');
    const opened=await vscode.commands.executeCommand('rocketbrain.coroutines.openFrame',{
      ordinal,stack:'creation',index:creation,capturedAt:refreshed.capturedAt});
    assert.equal(path.relative(opened.document.uri.fsPath,kotlinFile),'');
    assert.equal(opened.selection.start.line,16);
    const observed=await service.openFrame({ordinal,stack:'observed',index:observation,capturedAt:refreshed.capturedAt});
    assert.equal(observed.selection.start.line,17);
    const descriptor=await readCoroutineDescriptor(prepared.descriptor);
    assert.equal((await vscode.commands.executeCommand('rocketbrain.coroutines.disconnect')).state,'disconnected');
    assert.equal(service.getSnapshot(),undefined);
    assert.equal((await fetchCoroutineSnapshot(descriptor)).pid,child.pid);
    assert.equal(await child.stop(),0);
    await assert.rejects(fs.stat(prepared.descriptor),{code:'ENOENT'});
    await assert.rejects(fetchCoroutineSnapshot(descriptor));
    const jdbc=await jdbcReadback();
    checks.push('Opened the Kotlin Coroutines view on an explicitly launched local JVM, refreshed independent RUNNING/SUSPENDED states, opened real creation and observed stack frames, and disconnected without stopping the JVM.');
    return {version:prepared.version,states:[{name:awaiting.name,state:awaiting.state},{name:processing.name,state:processing.state}],
      creationLine:17,observedLine:18,detachedAppStillReady:true,ownedShutdown:true,springWorkspace:true,
      builtInJobHierarchy:true,sameNameBranchesDistinct:true,jdbc};
  } finally {
    service.disconnect();
    if (child) await child.stop();
    for (const editor of vscode.window.visibleTextEditors.filter(item=>item.document.uri.fsPath.startsWith(root+path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    if (prepared) {
      const stage=await fs.realpath(path.dirname(prepared.jar));
      const storage=path.join(await fs.realpath(os.tmpdir()),'kotlin-coroutine-probes');
      if (path.relative(path.dirname(stage),storage) || !path.basename(stage).startsWith('probe-') ||
          path.relative(stage,path.dirname(prepared.descriptor))) throw Error('The coroutine probe setup identity changed before cleanup.');
      await fs.rm(stage,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
    const owned=await fs.realpath(root);
    if (path.relative(path.dirname(owned),workspace) || !path.basename(owned).startsWith('rb-kotlin-coro-')) {
      throw Error('Coroutine fixture ownership changed before cleanup.');
    }
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={runKotlinCoroutineChecks};
