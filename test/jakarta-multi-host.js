'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const { pathToFileURL,fileURLToPath }=require('node:url');
const { execFile }=require('node:child_process');
const { promisify }=require('node:util');
const { createHash }=require('node:crypto');
const { registerJakartaWorkbench }=require('../src/java/jakarta-vscode');
const { buildSpec }=require('../src/java/workbench-tasks');
const { importedSpring,jdbcReadback }=require('./java-source-analysis-host');

const fixture=path.join(__dirname,'fixtures','java','jakarta-war');
const execute=promisify(execFile);
const uri=file=>pathToFileURL(file).href;
const checksum=buffer=>createHash('sha256').update(buffer).digest('hex');

async function modify(file,original,replacement) {
  const source=await fs.readFile(file,'utf8');
  assert.ok(source.includes(original));
  await fs.writeFile(file,source.replace(original,replacement));
}

async function ownedModules(directory,run) {
  const parent=await fs.realpath(directory);
  const real=await fs.mkdtemp(path.join(parent,'rb-jakarta-set-'));
  try {
    const modules=[];
    for (const name of ['blue','green']) {
      const root=path.join(real,name);
      await fs.cp(fixture,root,{recursive:true,filter:file=>!['target','.project','.classpath','.settings','.mvn'].includes(path.basename(file))});
      await modify(path.join(root,'pom.xml'),'<artifactId>jakarta-war</artifactId>',`<artifactId>jakarta-war-${name}</artifactId>`);
      await modify(path.join(root,'src/main/java/jakartafixture/PingServlet.java'),'jakarta-servlet:',`jakarta-${name}:`);
      await modify(path.join(root,'src/main/webapp/page.jsp'),'jakarta-page:',`jakarta-${name}-page:`);
      const repo=process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO;
      if (repo) {
        await fs.mkdir(path.join(root,'.mvn'));
        await fs.writeFile(path.join(root,'.mvn/maven.config'),'-Dmaven.repo.local='+path.resolve(repo)+'\n');
      }
      modules.push({root,uri:uri(root),name,tool:'maven'});
    }
    return await run(modules,real);
  } finally {
    assert.equal(await fs.realpath(real),real);
    assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^rb-jakarta-set-/u);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

async function get(url,expected=200) {
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,expected);
  return (await response.text()).trim();
}

async function verifyPeer(app,name) {
  assert.equal(await get(app.url+'/ping'),`jakarta-${name}:${app.context}:6`);
  assert.equal(await get(app.url+'/page.jsp'),`jakarta-${name}-page:${app.context}`);
}

async function exercise(service,modules) {
  const applications=[];
  for (const project of modules) {
    const built=await service.buildWar({projectUri:project.uri,allowProjectExecution:true});
    assert.equal(built.state,'succeeded');
    assert.equal(built.artifacts.length,1);
    const [{uri:warUri,name}]=built.artifacts;
    assert.equal(name,`jakarta-war-${project.name}-1.0.0.war`);
    applications.push({projectUri:project.uri,warUri,context:'rb-'+project.name});
  }
  await assert.rejects(service.reviewSet({applications:[applications[0]]}),/two to/u);
  await assert.rejects(service.reviewSet({applications:[applications[0],{...applications[1],context:applications[0].context}]}),/unique Tomcat context/u);
  const reviewed=await service.reviewSet({applications});
  assert.equal(service.getState().state,'stopped');
  for (const app of reviewed) assert.equal(app.expectedSha256,checksum(await fs.readFile(fileURLToPath(app.warUri))));
  assert.notEqual(reviewed[0].expectedSha256,reviewed[1].expectedSha256);
  await assert.rejects(service.deploySet({applications:reviewed}),/Explicitly deploy/u);
  await assert.rejects(service.deploySet({applications,allowDeploy:true}),/Review the SHA-256/u);

  const secondFile=fileURLToPath(reviewed[1].warUri);
  const original=await fs.readFile(secondFile);
  try {
    const changed=Buffer.from(original);
    changed[changed.length-1]^=1;
    await fs.writeFile(secondFile,changed);
    await assert.rejects(service.deploySet({applications:reviewed,allowDeploy:true}),/artifact changed while staging/u);
    assert.equal(service.getState().state,'stopped');
  } finally {
    await fs.writeFile(secondFile,original);
  }

  const deployed=await service.deploySet({applications:reviewed,allowDeploy:true});
  assert.equal(deployed.state,'running');
  assert.match(deployed.version,/^11\.0\./u);
  assert.equal(deployed.applications.length,2);
  const [blue,green]=deployed.applications;
  assert.deepEqual(deployed.applications.map(app=>new URL(app.url).origin),[deployed.url,deployed.url]);
  assert.deepEqual(deployed.applications.map(app=>app.sha256),reviewed.map(app=>app.expectedSha256));
  assert.deepEqual(service.getState(),deployed);
  await Promise.all([verifyPeer(blue,'blue'),verifyPeer(green,'green')]);
  const remove={deploymentId:deployed.deploymentId,context:blue.context,expectedSha256:blue.sha256};
  await assert.rejects(service.undeploy(remove),/Explicitly confirm/u);
  await assert.rejects(service.undeploy({...remove,deploymentId:'stale',allowUndeploy:true}),/no longer running/u);
  await assert.rejects(service.undeploy({...remove,expectedSha256:'a'.repeat(64),allowUndeploy:true}),/application has changed/u);
  const pending=service.undeploy({...remove,allowUndeploy:true});
  const conflict=assert.rejects(service.undeploy({...remove,allowUndeploy:true}),/Wait for the current/u);
  const [removed]=await Promise.all([pending,conflict]);
  assert.deepEqual(removed,{state:'undeployed',deploymentId:deployed.deploymentId,application:blue,remaining:1});
  await get(blue.url+'/ping',404);
  await verifyPeer(green,'green');
  assert.deepEqual(service.getState().applications,[green]);
  await assert.rejects(service.undeploy({...remove,allowUndeploy:true}),/application has changed/u);
  const last=await service.undeploy({...remove,context:green.context,expectedSha256:green.sha256,allowUndeploy:true});
  assert.equal(last.remaining,0);
  assert.deepEqual(service.getState(),{state:'stopped'});
  await assert.rejects(fetch(green.url+'/ping',{signal:AbortSignal.timeout(1200)}));
  assert.deepEqual(await service.stop(),{state:'stopped'});
  for (const app of reviewed) assert.equal(checksum(await fs.readFile(fileURLToPath(app.warUri))),app.expectedSha256);
  return {contexts:[blue.context,green.context],serverVersion:deployed.version,applicationCount:2,reviewedDigestCount:2,
    distinctArtifacts:true,sharedLoopbackOrigin:true,servletAndJspBothApps:true,verifiedSelectiveUndeploy:true,
    peerUninterrupted:true,wrongDigestLaunchRejected:true,staleAndReplayRemovalRejected:true,
    concurrentRemovalGuard:true,finalContextClosesServer:true,originalWarPreserved:true};
}

async function runJakartaMultiChecks(api,vscode,checks) {
  const service=api.java.jakarta;
  assert.ok(service.reviewSet&&service.deploySet&&service.undeploy);
  const commands=await vscode.commands.getCommands(true);
  for (const command of ['deploySet','undeploy']) assert.ok(commands.includes('rocketbrain.jakarta.'+command));
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const settings=vscode.workspace.getConfiguration('rocketbrain.java');
  const modified=[];
  try {
    for (const [key,name] of [['mavenHome','ROCKETBRAIN_MAVEN_HOME'],['jakarta.tomcatHome','ROCKETBRAIN_JAKARTA_TOMCAT_HOME']]) {
      const value=process.env[name];
      if (value) {
        const previous=settings.inspect(key)?.globalValue;
        await settings.update(key,value,vscode.ConfigurationTarget.Global);
        modified.push({key,previous});
      }
      assert.ok(settings.get(key),'Select the configured local runtime.');
    }
    return await ownedModules(workspace,async modules=>{
      try {
        for (const project of modules) {
          const imported=await api.java.workbench.resyncProject({projectUri:project.uri,allowProjectExecution:true});
          assert.ok(imported.projects.some(item=>!path.relative(item.root,project.root)&&item.tool==='maven'));
        }
        const result=await exercise(service,modules);
        checks.push('Deployed two checksum-reviewed Maven WARs to one local Tomcat, reached both Servlet and JSP routes, and undeployed one context while preserving its peer.');
        return {...result,jdbc:await jdbcReadback(),nativeView:true};
      } finally {
        await service.stop();
        await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],modules.map(item=>item.uri));
      }
    });
  } finally {
    for (const {key,previous} of modified.reverse()) await settings.update(key,previous,vscode.ConfigurationTarget.Global);
  }
}

function headlessService(modules,root,javaHome,mavenHome,tomcatHome) {
  const settings={javaHome,mavenHome,'jakarta.tomcatHome':tomcatHome};
  const disposable=()=>({dispose(){}});
  const output={append(){},appendLine(){},dispose(){}};
  const vscode={
    workspace:{isTrusted:true,workspaceFolders:[{uri:{scheme:'file',fsPath:root,toString:()=>uri(root)}}],textDocuments:[],
      getConfiguration:()=>({get:key=>settings[key]})},
    window:{createOutputChannel:()=>output},
    debug:{onDidStartDebugSession:disposable,onDidTerminateDebugSession:disposable},
    commands:{registerCommand:disposable}
  };
  const java={getState:()=>({javaHome}),workbench:{
    getSnapshot:()=>({projects:modules}),
    discoverTasks:async()=>[{id:'package',name:'package'}],
    async runTask({projectUri,taskId}) {
      assert.equal(taskId,'package');
      const project=modules.find(item=>item.uri===projectUri);
      const spec=buildSpec(project,{mavenHome,javaHome},['package']);
      await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeout:120000,maxBuffer:4*1024*1024,windowsHide:true});
      return {state:'succeeded'};
    }
  }};
  return registerJakartaWorkbench(vscode,java);
}

async function headless() {
  const {javaHome}=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
  const mavenHome=await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const tomcatHome=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_TOMCAT_HOME);
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  const jdbc=await jdbcReadback();
  assert.ok(jdbc&&['mysql','mariadb'].includes(engine));
  const result=await ownedModules(os.tmpdir(),async(modules,root)=>{
    const service=headlessService(modules,root,javaHome,mavenHome,tomcatHome);
    try {return await exercise(service,modules);}
    finally {await service.dispose();}
  });
  assert.deepEqual(await jdbcReadback(),jdbc);
  return {...result,engine,jdbc,actualMavenBuild:true,nativeView:false};
}

module.exports={runJakartaMultiChecks};
if (require.main===module) headless().then(receipt=>console.log(JSON.stringify(receipt))).catch(error=>{
  console.error(error.stack);
  process.exitCode=1;
});
