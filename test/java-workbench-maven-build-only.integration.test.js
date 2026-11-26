'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {fileURLToPath,pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {listEarArtifacts}=require('../src/java/jakarta-war');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {execute}=require('../src/java/testing/provision');
const {registerJavaWorkbench}=require('../src/java/workbench');
const {StdioLsp}=require('./helpers/stdio-lsp');
const F=require('./java-workbench-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome=process.env.ROCKETBRAIN_MAVEN_HOME;
const mavenRepo=process.env.ROCKETBRAIN_JAKARTA_WILDFLY_EAR_MAVEN_REPO;
const uri=file=>pathToFileURL(file).href;

test('stock JDT imports the exact non-Java Maven reactor and the workbench packages its real EAR', {
 skip:!javaConfig||!mavenHome||!mavenRepo,timeout:240000
},async()=>{
 const runtime=JSON.parse(await fs.readFile(javaConfig,'utf8'));
 const parent=await fs.realpath(os.tmpdir());
 const owned=await fs.mkdtemp(path.join(parent,'rb-ear-build-only-'));
 const workspace=path.join(owned,'workspace'), reactor=path.join(workspace,'late-reactor');
 const application=path.join(reactor,'application');
 let lsp,workbench;
 try {
  await fs.mkdir(workspace);
  lsp=new StdioLsp(resolveLaunch({...runtime,storagePath:path.join(owned,'jdt')}));
  const settings=serverSettings([{name:'JavaSE-25',path:runtime.javaHome,default:true}]);
  settings.java.autobuild.enabled=false;
  settings.java.import.gradle.enabled=false;
  await lsp.request('initialize',{processId:process.pid,rootUri:uri(workspace),
   workspaceFolders:[{uri:uri(workspace),name:'owned EAR build'}],
   capabilities:{workspace:{configuration:true,workspaceFolders:true}},
   initializationOptions:{bundles:[],workspaceFolders:[uri(workspace)],settings}},90000);
  lsp.notify('initialized',{});
  const send=(command,args)=>lsp.request('workspace/executeCommand',{command,arguments:args},60000);
  await send('java.project.getAll',[]);
  const inputs=[];
  const host=F.fakeVscode({parent:owned,root:workspace,uri:uri(workspace),javaHome:runtime.javaHome,mavenHome});
  host.java.requestWorkspaceCommand=async(name,args)=>{
   inputs.push({name,args});
   try { return await send(name,args); }
   catch(error){
    let rpc;
    try { rpc=JSON.parse(error.message); } catch { throw error; }
    throw Object.assign(Error(rpc.message),{code:rpc.code});
   }
  };
  const runner={async execute(spec){
   assert.equal(path.relative(spec.cwd,reactor),'');
   assert.equal(spec.args.at(-1),'package');
   const result=await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeoutMs:160000,maxOutputBytes:1024*1024});
   assert.equal(result.code,0,result.output.slice(-2500));
   return {code:result.code,terminationConfirmed:true};
  },async stop(){},async dispose(){}};
  workbench=registerJavaWorkbench(host.context,host.vscode,host.java,host.output,{runner});
  await fs.cp(path.join(__dirname,'fixtures/java/jakarta-ear'),reactor,{recursive:true});
  await fs.mkdir(path.join(reactor,'.mvn'));
  await fs.writeFile(path.join(reactor,'.mvn/maven.config'),'-Dmaven.repo.local='+await fs.realpath(mavenRepo)+'\n');
  const snapshot=await workbench.resyncProject({projectUri:uri(reactor),allowProjectExecution:true});
  const imported=inputs.filter(row=>row.name==='java.project.changeImportedProjects');
  assert.equal(imported.length,1);
  assert.deepEqual(imported[0].args,[[uri(path.join(reactor,'pom.xml'))],[],[]]);
  const buildProjects=snapshot.projects.filter(project=>project.buildOnly);
  const at=(projects,root)=>projects.find(project=>path.relative(project.root,root)==='');
  const root=at(buildProjects,reactor),ear=at(snapshot.projects,application);
  assert.equal(root?.packaging,'pom');
  assert.equal(ear?.tool,'maven');
  const observedMembers=root.reactorMembers?.map(member=>path.relative(reactor,member)).sort();
  if(observedMembers)assert.deepEqual(observedMembers,['application','beans','contract','web']);
  for(const project of buildProjects){
   assert.deepEqual(project.sourceRoots,[]);
   assert.deepEqual(project.libraries,[]);
   assert.deepEqual(await workbench.mainClasses({projectUri:project.uri}),[]);
   assert.ok(!inputs.some(row=>['java.project.getSettings','java.project.getClasspaths'].includes(row.name)&&
    row.args[0]?.startsWith('file:')&&path.relative(fileURLToPath(row.args[0]),project.root)===''));
  }
  assert.ok(!(await send('java.project.getAll',[])).some(value=>path.relative(fileURLToPath(value),reactor)===''));
  assert.equal(at((await workbench.refresh()).projects,reactor)?.id,root.id);
  const task=(await workbench.discoverTasks({projectUri:root.uri})).find(value=>value.name==='package');
  assert.equal((await workbench.runTask({projectUri:root.uri,taskId:task.id,allowProjectExecution:true})).state,'succeeded');
  const [archive]=listEarArtifacts(ear);
  assert.ok(archive&&listEarArtifacts(ear).length===1);
  const receipt=process.env.ROCKETBRAIN_MAVEN_BUILD_ONLY_RECEIPT;
  if(receipt)await fs.writeFile(receipt,JSON.stringify({
   sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
   jdt:'1.63.0',lateImportDispatches:imported.length,rootAbsentFromJavaOnly:true,reactorPackaging:root.packaging,
   ...(observedMembers&&{observedMembers}),
   earBuildOnly:ear.buildOnly===true,observedMavenPackaging:buildProjects.map(project=>project.packaging).sort(),
   buildTask:'package',earArchiveObserved:true,refreshPreservesIdentity:true
  },null,2)+'\n');
 }finally{
  await workbench?.dispose();
  await lsp?.close();
  const actual=await fs.realpath(owned);
  assert.equal(path.relative(parent,path.dirname(actual)),'');
  assert.ok(path.basename(actual).startsWith('rb-ear-build-only-'));
  await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:200});
 }
});
