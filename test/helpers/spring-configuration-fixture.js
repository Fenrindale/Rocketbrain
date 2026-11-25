'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const { execFile,spawn }=require('node:child_process');
const { promisify }=require('node:util');
const { setTimeout:delay }=require('node:timers/promises');

const root=path.resolve(__dirname,'../..');
const project=path.join(root,'test','fixtures','spring-configuration-app');
const metadata=path.join('build','classes','java','main','META-INF','spring-configuration-metadata.json');
const jar=path.join(project,'build','libs','spring-configuration-fixture-1.0.0.jar');
const javaSource=path.join('src','main','java','fixture','configuration','CatalogSettings.java');
const yamlSource=path.join('src','main','resources','application.yml');
const propsSource=path.join('src','main','resources','application-local-db.properties');
const run=promisify(execFile);
const probeValue='runtime-command-line-override';

async function runtime(){
  const location=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
  const settings=location?JSON.parse(await fs.readFile(location,'utf8')):{};
  const home=process.env.ROCKETBRAIN_SPRING_JAVA_HOME||settings.javaHome||settings.settings?.['rocketbrain.java.javaHome'];
  if(!home||!path.isAbsolute(home))throw Error('Use the independent fixture JDK 25.');
  const release=await fs.readFile(path.join(home,'release'),'utf8');
  if(!/JAVA_VERSION="25\./.test(release)||/JetBrains|JBR/i.test(release))throw Error('Use a general JDK 25 for the fixture.');
  return {home,java:path.join(home,'bin',process.platform==='win32'?'java.exe':'java')};
}

function cleanEnv(){
  const env={...process.env};
  for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','GRADLE_OPTS'])delete env[key];
  return env;
}

async function buildConfigurationFixture(){
  const {home,java}=await runtime();
  const gradle=process.env.ROCKETBRAIN_GRADLE_HOME;
  if(!gradle||!path.isAbsolute(gradle))throw Error('Use an independent Gradle 9.1.0 distribution.');
  const cache=process.env.ROCKETBRAIN_SPRING_CONFIGURATION_GRADLE_CACHE||path.join(root,'test-output','java-gradle-user-home');
  const launcher=path.join(gradle,'lib','gradle-launcher-9.1.0.jar');
  try {
    await run(java,['-Dorg.gradle.java.home='+home,'-cp',launcher,'org.gradle.launcher.GradleMain',
      '--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',cache,'bootJar'],
    {cwd:project,env:cleanEnv(),windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  }catch(error){throw Error('The configuration fixture failed to build.\n'+String(error.stderr||error.stdout||error.message).slice(-2800),{cause:error});}
  await fs.access(jar);
  await fs.access(path.join(project,metadata));
  return {jar,metadata:path.join(project,metadata)};
}

async function startConfigurationFixture(config,override=false){
  const {java}=await runtime();
  const db=JSON.parse(await fs.readFile(config.dbConfigPath,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(config.dbConfigPath),'owner.json'),'utf8'));
  const engine=config.dbEngine;
  const kinds={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
  if(!kinds[engine]||owner.kind!==kinds[engine]||db.host!=='127.0.0.1'||!/^[A-Za-z0-9_]+$/.test(db.database)||
    !Number.isSafeInteger(db.port)||db.port<1024||db.port>65535)throw Error('Use an owned loopback Spring database fixture.');
  const artifact=process.env.ROCKETBRAIN_SPRING_CONFIGURATION_JAR||jar;
  await fs.access(artifact);
  const datasource='jdbc:'+engine+'://127.0.0.1:'+db.port+'/'+db.database+
    (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
  const env={...cleanEnv(),SPRING_PROFILES_ACTIVE:'local-db',SPRING_DATASOURCE_URL:datasource,
    SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password};
  const args=['-jar',artifact,...(override?['--fixture.catalog.display-name='+probeValue]:[])];
  const child=spawn(java,args,{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let port,ended=false,recent='';
  const capture=chunk=>{
    recent=(recent+chunk.toString('utf8').split(db.password).join('[redacted]')).slice(-5000);
    port=Number(/RocketbrainConfigurationFixture listening on (\d+)/.exec(recent)?.[1])||port;
  };
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const exit=new Promise(resolve=>{
    child.once('exit',()=>{ended=true;resolve();});
    child.once('error',()=>{ended=true;resolve();});
  });
  let stopping;
  const close=()=>stopping??=(async()=>{if(!ended)child.kill();await exit;})();
  try {
    const deadline=Date.now()+40000;
    while(!ended&&Date.now()<deadline){
      if(port)return {url:'http://127.0.0.1:'+port,close};
      await delay(80);
    }
    throw Error('The owned configuration fixture did not start.\n'+recent);
  }catch(error){await close();throw error;}
}

module.exports={runtime,project,metadata,javaSource,yamlSource,propsSource,probeValue,buildConfigurationFixture,startConfigurationFixture};
if(require.main===module)buildConfigurationFixture().then(value=>console.log(JSON.stringify(value)),error=>{
  console.error(error.message);process.exitCode=1;
});
