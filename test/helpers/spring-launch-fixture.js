'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {createServer}=require('node:net');
const assert=require('node:assert/strict');
const {readDatabase}=require('./spring-maven-bom-fixture');
const configuration=require('./spring-configuration-fixture');
const run=promisify(execFile);
const main='fixture.configuration.ConfigurationFixtureApplication';
const versions={environment:'systemEnvironment',jvm:'systemProperties',arguments:'commandLineArgs'};
const artifact=()=>process.env.ROCKETBRAIN_SPRING_CONFIGURATION_JAR||
  path.join(configuration.project,'build','libs','spring-configuration-fixture-1.0.0.jar');

async function readRuntime(){
  const runtime=await configuration.runtime();
  return {...runtime,jar:path.join(runtime.home,'bin',process.platform==='win32'?'jar.exe':'jar')};
}

async function availablePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  await new Promise(resolve=>server.close(resolve));
  return port;
}

async function inputs(config,profileSource){
  const db=await readDatabase(config),port=await availablePort(),engine=config.dbEngine;
  const sample='owned literal application value = '+profileSource;
  return {port,sample,profileSource,env:{
    SERVER_ADDRESS:'127.0.0.1',SERVER_PORT:String(port),
    SPRING_DATASOURCE_URL:'jdbc:'+engine+'://127.0.0.1:'+db.port+'/'+db.database+(engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':''),
    SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password
  },springBoot:{profiles:['local-db'],profileSource,properties:[
    {key:'fixture.catalog.retries',source:'environment',value:'12'},
    {key:'fixture.catalog.query-limit',source:'jvm',value:'1'},
    {key:'fixture.catalog.display-name',source:'arguments',value:sample}
  ]}};
}

async function ownedProject(workspace,runtime){
  const parent=await fs.realpath(workspace),root=await fs.mkdtemp(path.join(parent,'rb-spring-launch-'));
  const name='rbSpringLaunch'+randomUUID().replaceAll('-',''),owner=path.join(root,'owner.json');
  await fs.writeFile(owner,JSON.stringify({kind:'RocketbrainSpringLaunchTest-v1',name}),{flag:'wx'});
  const uri=pathToFileURL(root).href;
  async function close(){
    const candidate=await fs.realpath(root);
    const marker=JSON.parse(await fs.readFile(owner,'utf8'));
    assert.equal(path.dirname(candidate),parent);
    assert.ok(path.basename(candidate).startsWith('rb-spring-launch-'));
    assert.equal(marker.kind,'RocketbrainSpringLaunchTest-v1');
    assert.equal(marker.name,name);
    await fs.rm(candidate,{recursive:true,maxRetries:3});
  }
  try{
    const source='src/main/java/fixture/configuration/ConfigurationFixtureApplication.java';
    for(const relative of [source,configuration.javaSource,configuration.yamlSource,configuration.propsSource]){
      const output=path.join(root,relative);
      await fs.mkdir(path.dirname(output),{recursive:true});
      await fs.copyFile(path.join(configuration.project,relative),output);
    }
    await fs.access(artifact());
    await run(runtime.jar,['xf',artifact(),'BOOT-INF/lib'],{cwd:root,windowsHide:true,timeout:25000,maxBuffer:1024*1024});
    const libraries=(await fs.readdir(path.join(root,'BOOT-INF','lib'))).filter(file=>/^[A-Za-z0-9_.-]+\.jar$/.test(file)).sort();
    assert.ok(libraries.some(file=>file.startsWith('spring-boot-'))&&libraries.some(file=>file.startsWith('mysql-connector-j-'))&&
      libraries.some(file=>file.startsWith('mariadb-java-client-')));
    const xml=['<classpath>','<classpathentry kind="src" path="src/main/java"/>',
      '<classpathentry kind="src" path="src/main/resources"/>','<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
      ...libraries.map(file=>'<classpathentry kind="lib" path="BOOT-INF/lib/'+file+'"/>'),
      '<classpathentry kind="output" path="bin"/>','</classpath>'].join('\n');
    await fs.writeFile(path.join(root,'.classpath'),xml,{flag:'wx'});
    await fs.writeFile(path.join(root,'.project'),'<projectDescription><name>'+name+'</name>'+
      '<buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>'+
      '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>',{flag:'wx'});
    await fs.mkdir(path.join(root,'.settings'));
    await fs.writeFile(path.join(root,'.settings','org.eclipse.jdt.core.prefs'),['eclipse.preferences.version=1',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform=25','org.eclipse.jdt.core.compiler.compliance=25',
      'org.eclipse.jdt.core.compiler.source=25',''].join('\n'),{flag:'wx'});
    return {root,uri,name,source:path.join(root,source),close};
  }catch(error){await close();throw error;}
}

function startOwnedArtifact(runtime,resolved){
  const env={...process.env,...resolved.env};
  for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS'])delete env[key];
  const child=spawn(runtime.java,[...resolved.vmArgs,'-jar',artifact(),...resolved.args],
    {cwd:path.dirname(artifact()),env,windowsHide:true,stdio:['ignore','ignore','ignore']});
  let closed=false;
  const stopped=new Promise(resolve=>{
    child.once('exit',()=>{closed=true;resolve();});
    child.once('error',()=>{closed=true;resolve();});
  });
  return {async stop(){if(!closed)child.kill();await stopped;}};
}

module.exports={main,versions,artifact,readRuntime,inputs,ownedProject,startOwnedArtifact};
