'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {gradleInit,task,parseGradleAdvisoryGraph}=require('../src/java/gradle-advisory-graph');
const {auditMavenPackages}=require('../src/java/dependency-advisories');
const {buildSpec}=require('../src/java/workbench-tasks');
const {jdbcReadback}=require('./java-source-analysis-host');

const configuration='runtimeClasspath';
const directKey='org.springframework.boot:spring-boot-starter-webmvc@4.1.2';

async function exercise(resolve,audit,publish) {
  const tree=await resolve();
  assert.equal(tree.buildTool,'gradle');
  assert.equal(tree.configuration,configuration);
  assert.equal(tree.unresolved,0);
  const direct=tree.packages.find(item=>item.key===directKey);
  const web=tree.packages.find(item=>item.name==='org.springframework:spring-webmvc');
  assert.equal(direct?.direct,true);
  assert.equal(web?.direct,false);
  assert.ok(web.paths.some(chain=>chain.includes(directKey)));
  const jdbcDriver=tree.packages.find(item=>item.name==='com.mysql:mysql-connector-j');
  assert.ok(jdbcDriver?.direct);
  const keys=[direct.key,web.key];
  const report=await audit(tree,keys);
  assert.deepEqual(report.packages.map(item=>item.key),keys);
  assert.equal(report.configuration,configuration);
  await publish?.(report);
  assert.deepEqual(await jdbcReadback(),{people:2,departments:1,rolledBackNames:0});
  return {configuration,stdlibResolved:true,selectedVersion:true,correctDirectPath:true,correctTransitivePath:true,
    dependencyCount:tree.packages.length,selectedPackages:keys.length};
}

async function actualGradleAdvisoryBackend() {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const temp=await fs.realpath(os.tmpdir());
  const folder=await fs.mkdtemp(path.join(temp,'rb-gradle-advisories-'));
  const initFile=path.join(folder,'advisories.init.gradle'),output=path.join(folder,'tree.json');
  try {
    await fs.writeFile(initFile,gradleInit,{flag:'wx'});
    const spec=buildSpec({root:config.projectPath,name:'Spring verification',tool:'gradle'},
      {javaHome:process.env.ROCKETBRAIN_SPRING_JAVA_HOME,gradleHome:process.env.ROCKETBRAIN_GRADLE_HOME},
      [task],{discovery:true,output,initFile});
    spec.args.unshift('-Drocketbrain.advisories.configuration='+configuration);
    spec.args.push('--no-configuration-cache','--offline');
    await promisify(execFile)(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:90000})
      .catch(error=>{throw Error(String(error.stderr||error.message).slice(-3000));});
    return await exercise(async()=>parseGradleAdvisoryGraph(await fs.readFile(output,'utf8'),configuration),
      (tree,keys)=>auditMavenPackages(tree,keys,{fetcher:async(_,options)=>{
        const queries=JSON.parse(options.body).queries;
        assert.deepEqual(queries.map(item=>item.package.name+'@'+item.version),keys);
        return new Response(JSON.stringify({results:keys.map(()=>({}))}));
      }}));
  } finally {
    assert.equal(path.relative(folder,await fs.realpath(folder)),'');
    assert.equal(path.dirname(folder),temp);
    await fs.unlink(initFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.unlink(output).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.rmdir(folder);
  }
}

async function runGradleAdvisoryChecks(api,vscode,checks) {
  const directory=vscode.workspace.workspaceFolders[0].uri,advisories=api.java.dependencyAdvisories;
  await assert.rejects(advisories.resolveGradleTree(directory,configuration),/start resolution/);
  const proof=await exercise(()=>advisories.resolveGradleTree(directory,configuration,{allowProjectExecution:true}),
    (tree,keys)=>advisories.audit(tree,keys,{allowLookup:true}),
    async report=>{
      const uri=await advisories.publish(report);
      const document=await vscode.workspace.openTextDocument(uri);
      assert.match(document.getText(),/Gradle dependency advisories/);
      assert.match(document.getText(),/Resolved configuration · runtimeClasspath/);
      assert.match(document.getText(),/spring-webmvc[^\n]+transitive/);
      assert.equal(document.isDirty,false);
    });
  checks.push('The installed Gradle audit resolved the selected Spring runtime configuration and queried OSV only for two selected public coordinates.');
  return {...proof,nativeReadonlyReport:true,publicOsvLookup:true};
}

module.exports={runGradleAdvisoryChecks,actualGradleAdvisoryBackend};
if(require.main===module)actualGradleAdvisoryBackend().then(proof=>console.log(JSON.stringify(proof)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
