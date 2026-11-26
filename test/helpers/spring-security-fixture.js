'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const { spawn,execFile }=require('node:child_process');
const { promisify }=require('node:util');
const { randomUUID,randomBytes }=require('node:crypto');
const { pathToFileURL }=require('node:url');
const { setTimeout:delay }=require('node:timers/promises');

const run=promisify(execFile);
const root=path.resolve(__dirname,'../..');
const project=path.join(root,'test','fixtures','spring-security-app');
const jar=path.join(project,'build','libs','spring-security-fixture-1.0.0.jar');
const runtimes=path.join(root,'research','implementation','runtimes');

async function javaRuntime() {
  let home=process.env.ROCKETBRAIN_SPRING_JAVA_HOME;
  if (!home && process.env.ROCKETBRAIN_JAVA_TEST_CONFIG) {
    const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
    home=config.javaHome ?? config.settings?.['rocketbrain.java.javaHome'];
  }
  home??=path.join(runtimes,'temurin25','extracted','jdk-25.0.5+8');
  const release=await fs.readFile(path.join(home,'release'),'utf8');
  if (!/JAVA_VERSION="25\./.test(release) || /JetBrains|JBR/i.test(release)) throw Error('Use the independent Temurin JDK 25 for the fixture.');
  return {home,java:path.join(home,'bin',process.platform==='win32'?'java.exe':'java')};
}

async function buildSpringSecurityFixture() {
  const {home,java}=await javaRuntime();
  const gradle=process.env.ROCKETBRAIN_GRADLE_HOME ?? path.join(runtimes,'gradle-9.1.0','extracted','gradle-9.1.0');
  const cache=process.env.ROCKETBRAIN_SPRING_SECURITY_GRADLE_CACHE ?? path.join(root,'test-output','java-gradle-user-home');
  const launcher=path.join(gradle,'lib','gradle-launcher-9.1.0.jar');
  await run(java,['-Dorg.gradle.java.home='+home,'-cp',launcher,'org.gradle.launcher.GradleMain',
    '--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',cache,'bootJar'],
  {cwd:project,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  await fs.access(jar);
  return jar;
}

async function startSpringSecurityFixture(config,{trace=false,methodTrace=false,traceRoles=[],authenticationProviderTrace=false,
  customAuthentication=false,parentAuthentication=false,observerJar}={}) {
  const {home,java}=await javaRuntime();
  const selected=process.env.ROCKETBRAIN_SPRING_SECURITY_JAR ?? jar;
  await fs.access(selected);
  const db=JSON.parse(await fs.readFile(config.dbConfigPath,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(config.dbConfigPath),'owner.json'),'utf8'));
  const engine=config.dbEngine;
  const kind={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'}[engine];
  if (!kind || owner.kind!==kind || db.host!=='127.0.0.1' || !/^[A-Za-z0-9_]+$/.test(db.database) ||
      !Number.isSafeInteger(db.port) || db.port<1024 || db.port>65535) throw Error('Choose an owned loopback Spring database fixture.');
  const account=role=>({name:role+'-'+randomUUID().slice(0,8),password:randomUUID()});
  const operator=account('operator'), reviewer=account('reviewer'), viewer=account('viewer');
  const auth=(item,password=item.password)=>'Basic '+Buffer.from(item.name+':'+password).toString('base64');
  const datasource='jdbc:'+engine+'://127.0.0.1:'+db.port+'/'+db.database+
    (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
  const env={...process.env,SPRING_DATASOURCE_URL:datasource,SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password,
    RB_SECURITY_OPERATOR:operator.name,RB_SECURITY_OPERATOR_PASSWORD:operator.password,
    RB_SECURITY_REVIEWER:reviewer.name,RB_SECURITY_REVIEWER_PASSWORD:reviewer.password,
    RB_SECURITY_VIEWER:viewer.name,RB_SECURITY_VIEWER_PASSWORD:viewer.password,RB_FIXTURE_CUSTOM_AUTHENTICATION:String(customAuthentication),
    RB_FIXTURE_PARENT_AUTHENTICATION:String(parentAuthentication)};
  let traceFiles,agentArgs=[];
  async function discardTraceFiles(){
    if(!traceFiles)return;
    for(const file of [traceFiles.tokenFile,traceFiles.descriptorFile,traceFiles.configFile])await fs.rm(file,{force:true});
    await fs.rmdir(traceFiles.directory);
  }
  if(trace||authenticationProviderTrace){
    const output=path.join(root,'test-output');
    const jarPath=observerJar??(await require('../../scripts/jpa-observer-build')
      .buildObserver({target:path.join(output,'spring-security-observer'),javaHome:home})).jarPath;
    await fs.access(jarPath);
    const directory=await fs.mkdtemp(path.join(output,'spring-security-trace-'));
    const token=randomBytes(32).toString('hex'),tokenFile=path.join(directory,'token'),descriptorFile=path.join(directory,'connection.json'),configFile=path.join(directory,'observer.json');
    traceFiles={directory,token,tokenFile,descriptorFile,configFile};
    try{
      await fs.writeFile(tokenFile,token,{flag:'wx',mode:0o600});
      await fs.writeFile(configFile,JSON.stringify({tokenFile,descriptorFile,securityTrace:trace,securityMethodTrace:methodTrace,securityTraceRoles:traceRoles,authenticationProviderTrace}),{flag:'wx',mode:0o600});
      agentArgs=['--add-modules=jdk.httpserver','-javaagent:'+jarPath+'=config='+pathToFileURL(configFile).href];
    }catch(error){await discardTraceFiles();throw error;}
  }
  const child=spawn(java,[...agentArgs,'-jar',selected],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let port,ended=false;
  const exited=new Promise(resolve=>{
    child.once('error',()=>{ended=true;resolve();});
    child.once('exit',()=>{ended=true;resolve();});
  });
  let output='';
  child.stdout.on('data',chunk=>{
    output=(output+chunk.toString('utf8')).slice(-4096);
    port=Number(/RocketbrainSecurityFixture listening on ([0-9]+)/.exec(output)?.[1]) || port;
  });
  child.stderr.resume();
  let stopping;
  function close() {return stopping??=(async()=>{if(!ended)child.kill();await exited;await discardTraceFiles();})();}
  try {
    const expires=Date.now()+45000;
    while (!ended && Date.now()<expires) {
      if (port) {
        const baseUrl='http://127.0.0.1:'+port;
        const response=await fetch(baseUrl+'/ready',{signal:AbortSignal.timeout(1000)}).catch(()=>null);
        if (response?.ok && (await response.json()).ready===true) {
          const descriptor=traceFiles?JSON.parse(await fs.readFile(traceFiles.descriptorFile,'utf8')):null;
          if(descriptor&&(descriptor.securityTraceEnabled!==true||methodTrace&&descriptor.securityMethodTraceEnabled!==true||
              authenticationProviderTrace&&descriptor.authenticationProviderTraceEnabled!==true))throw Error('The requested Spring Security tracing was not enabled.');
          return {baseUrl,operator,reviewer,viewer,auth,close,
            ...(descriptor?{observer:{url:descriptor.baseUrl,token:traceFiles.token,processId:descriptor.processId}}:{})};
        }
      }
      await delay(120);
    }
    throw Error('The isolated Spring Security fixture did not start.');
  } catch(error) {
    await close();
    throw error;
  }
}

if (require.main===module) buildSpringSecurityFixture().then(console.log).catch(error=>{
  console.error(error.stderr || error.message);process.exitCode=1;
});

module.exports={javaRuntime,buildSpringSecurityFixture,startSpringSecurityFixture};
