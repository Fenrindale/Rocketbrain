'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const {createHash}=require('node:crypto');
const {get,assertClosed}=require('./helpers/micronaut-debug-fixture');
const {withOwnedDatabase,withImportedGradle,copyUnder}=require('./micronaut-gradle-host');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

const approved={allowProjectExecution:true};
const configFile='src/main/resources/application-dev.properties';
const appFile='src/main/java/micronautgradlefixture/Application.java';
const oldMessage='gradle-dev', newMessage='gradle-reviewed-restart';
const sha=value=>createHash('sha256').update(value).digest('hex');

async function exercise(service,root,projectUri,{observe}={}){
  const old=await service.run({projectUri,environment:'dev',...approved});
  assert.equal(old.kind,'gradle-distribution');
  const readApp=session=>get(session,'/rocketbrain/hello');
  const readJdbc=session=>get(session,'/rocketbrain/jdbc');
  assert.equal(await readApp(old),oldMessage);
  assert.equal(await readJdbc(old),'2');
  const untouched=path.join(root,old.artifact,'lib','micronaut-gradle-1.0.0.jar');
  const originalJar=sha(await fs.readFile(untouched));
  const config=path.join(root,configFile), app=path.join(root,appFile);
  const original=await fs.readFile(config,'utf8'), main=await fs.readFile(app,'utf8');
  const updated=original.replace(oldMessage,newMessage);
  assert.notEqual(updated,original);
  const retained=async()=>{
    assert.equal(service.getState().runId,old.runId);
    assert.equal(await readApp(old),oldMessage);
  };
  const apply=(review,extra={})=>service.restart({reviewId:review.reviewId,...approved,...extra});
  try{
    const stale=await service.prepareRestart();
    assert.deepEqual([stale.task,stale.baselineObserved,stale.changes],['Gradle offline :installDist',true,[]]);
    await assert.rejects(service.restart({reviewId:stale.reviewId}),/Explicitly approve/u);
    await fs.writeFile(config,updated);
    await assert.rejects(apply(stale),/changed after review/u);
    await retained();

    await fs.writeFile(app,main+'\nInvalidReviewedJavaSource\n');
    const failed=await service.prepareRestart();
    assert.ok(failed.changes.some(change=>change.file===appFile));
    await assert.rejects(apply(failed),/Gradle did not produce a fresh/u);
    await retained();

    const invalid=main.replace('Micronaut.run(Application.class,args);','throw new IllegalStateException("owned restart startup failure");');
    assert.notEqual(invalid,main);
    await fs.writeFile(app,invalid);
    const unhealthy=await service.prepareRestart();
    await assert.rejects(apply(unhealthy),/exited before readiness/u);
    await retained();

    await fs.writeFile(app,main);
    const alreadyCancelled=new AbortController();
    alreadyCancelled.abort();
    const preCancelled=await service.prepareRestart();
    await assert.rejects(apply(preCancelled,{cancellation:alreadyCancelled.signal}),/cancelled/u);
    await retained();

    let cancelledDuringBuild=false;
    if(observe){
      const cancel=new AbortController();
      const review=await service.prepareRestart();
      let tail='';
      observe(value=>{
        tail=(tail+value).slice(-1000);
        if(tail.includes('Task :compileJava')){cancelledDuringBuild=true;cancel.abort();}
      });
      try{await assert.rejects(apply(review,{cancellation:cancel.signal}),/cancelled/u);}
      finally{observe(undefined);}
      assert.equal(cancelledDuringBuild,true);
      await retained();
    }

    const good=await service.prepareRestart();
    assert.deepEqual(good.changes,[{file:configFile,action:'modified'}]);
    const result=await apply(good);
    assert.deepEqual([result.kind,result.mode,result.restartedFrom,result.sourceDigest,result.environment],
      ['gradle-distribution','owned-jvm-restart',old.runId,good.sourceDigest,'dev']);
    const [reportedProject, requestedProject] = await Promise.all(
      [result.projectUri, projectUri].map(uri => fs.realpath(fileURLToPath(uri))));
    assert.equal(path.relative(reportedProject, requestedProject),'');
    assert.equal(result.previousArtifactSha256,old.sha256);
    assert.equal(result.ownershipVerified,true);
    assert.notEqual(result.sha256,old.sha256);
    assert.notEqual(result.baseUrl,old.baseUrl);
    assert.equal(service.getState().runId,result.runId);
    await assertClosed(Number(new URL(old.baseUrl).port));
    assert.equal(await readApp(result),newMessage);
    assert.equal(await readJdbc(result),'2');
    assert.equal(sha(await fs.readFile(untouched)),originalJar);
    await assert.rejects(apply(good),/current one-use/u);
    const continuing=await service.prepareRestart();
    assert.equal(continuing.runId,result.runId);
    assert.deepEqual(continuing.changes,[]);
    assert.equal((await service.stop()).state,'stopped');
    await assertClosed(Number(new URL(result.baseUrl).port));
    const springJdbc=await jdbcReadback();
    assert.deepEqual(springJdbc,{people:2,departments:1,rolledBackNames:0});
    return {springJdbc,micronautJdbc:2,oldResponse:oldMessage,newResponse:newMessage,sourceDigest:result.sourceDigest,
      stagedClasspathSha256:result.sha256,classpathLibraries:result.libraryCount,oldArtifactUnchanged:true,
      staleRefused:true,failedBuildRetainedOld:true,candidateStartupFailureRetainedOld:true,preCancelledRetainedOld:true,
      cancelledDuringBuild,oneUseReview:true,oldAndNewListenerClosed:true};
  }finally{await service.stop();}
}

async function runMicronautGradleRestartChecks(api,vscode,checks){
  const parent=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,parent);
  const result=await withOwnedDatabase(()=>copyUnder(parent,async root=>{
    const projectUri=vscode.Uri.file(root).toString(), service=api.java.micronaut;
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.micronaut.restart'));
    try{
      await api.java.workbench.resyncProject({projectUri,...approved});
      return await exercise(service,root,projectUri);
    }finally{
      await service.stop();
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(()=>{});
    }
  }));
  checks.push('Reviewed a Gradle Micronaut rebuild, preserved the old owned JVM through stale input, compilation and candidate startup failures, and switched to a verified fresh HTTP and JDBC JVM.');
  return result;
}

module.exports={runMicronautGradleRestartChecks};
if(require.main===module)withOwnedDatabase(()=>withImportedGradle(({service,root,uri,observe})=>exercise(service,root,uri,{observe})))
  .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});
