'use strict';

const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createServer}=require('node:http');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {randomBytes}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {setTimeout:delay}=require('node:timers/promises');
const {javaRuntime}=require('./spring-security-fixture');
const {readDatabase}=require('./spring-maven-bom-fixture');

const run=promisify(execFile),root=path.resolve(__dirname,'../..');
const project=path.join(root,'test','fixtures','spring-feign-contract-app');
const jar=path.join(project,'build','libs','spring-feign-contract-fixture-1.0.0.jar');
const routes=new Map([
  ['/partner/people/7',['GET','person-7']], ['/partner/status',['GET','status']],
  ['/partner/new-notice',['GET','current-notice']], ['/effective/rewritten/native/9',['POST','custom-9']]
]);

async function buildFeignFixture() {
  const {home,java}=await javaRuntime();
  const gradle=process.env.ROCKETBRAIN_GRADLE_HOME??path.join(root,'research','implementation','runtimes','gradle-9.1.0','extracted','gradle-9.1.0');
  const cache=process.env.ROCKETBRAIN_SPRING_SECURITY_GRADLE_CACHE??path.join(root,'test-output','java-gradle-user-home');
  await run(java,['-Dorg.gradle.java.home='+home,'-cp',path.join(gradle,'lib','gradle-launcher-9.1.0.jar'),
    'org.gradle.launcher.GradleMain','--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',cache,'bootJar'],
  {cwd:project,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  await fs.access(jar);
  return jar;
}

async function startFeignFixture(config,{enabled=true,observerJar}={}) {
  const {home,java}=await javaRuntime();
  const artifact=process.env.ROCKETBRAIN_SPRING_FEIGN_CONTRACT_JAR??jar;
  await fs.access(artifact);
  const agent=observerJar??(await require('../../scripts/jpa-observer-build')
    .buildObserver({target:path.join(root,'test-output','v86-observer'),javaHome:home})).jarPath;
  const db=config?await readDatabase(config):null;
  const env={...process.env,RB_FEIGN_JDBC:undefined,RB_FEIGN_USER:undefined,RB_FEIGN_PASSWORD:undefined};
  if(db) {
    env.RB_FEIGN_JDBC='jdbc:'+config.dbEngine+'://127.0.0.1:'+db.port+'/'+db.database+
      (config.dbEngine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
    env.RB_FEIGN_USER=db.user;
    env.RB_FEIGN_PASSWORD=db.password;
  }
  const requests=[];
  const server=createServer((incoming,response)=>{
    try {
      const target=new URL(incoming.url,'http://127.0.0.1');
      const route=routes.get(target.pathname);
      incoming.resume();
      if(!route||incoming.method!==route[0]){response.writeHead(404).end();return;}
      requests.push({method:incoming.method,path:target.pathname,
        privateQuery:target.searchParams.get('token')==='private-query-feign-fixture',
        privateHeader:incoming.headers['x-private-contract']==='private-header-feign-fixture'});
      response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end(route[1]);
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const upstream='http://127.0.0.1:'+server.address().port;
  let temp,files=[],child,closed,done;
  const token=randomBytes(32).toString('hex');
  function close(){
    return done??=(async()=>{
      try {
        if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
        await closed;
      }finally{
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
        for(const file of files)await fs.rm(file,{force:true});
        if(temp)await fs.rmdir(temp);
      }
    })();
  }
  try {
    temp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-feign-contract-'));
    const [tokenFile,descriptorFile,configFile]=files=['token','connection.json','observer.json'].map(name=>path.join(temp,name));
    await fs.writeFile(tokenFile,token,{flag:'wx',mode:0o600});
    await fs.writeFile(configFile,JSON.stringify({tokenFile,descriptorFile,feignContractTrace:enabled}),{flag:'wx',mode:0o600});
    child=spawn(java,['--add-modules=jdk.httpserver','-javaagent:'+agent+'=config='+pathToFileURL(configFile).href,
      '-jar',artifact,'--server.address=127.0.0.1','--server.port=0','--spring.output.ansi.enabled=never',
      '--fixture.upstream-url='+upstream,'--fixture.custom-prefix=/effective'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let ended=false,output='',port;
    closed=new Promise(resolve=>{
      child.once('error',()=>{ended=true;resolve();});
      child.once('exit',()=>{ended=true;resolve();});
    });
    const collect=data=>{
      output=(output+data.toString('utf8')).slice(-12000);
      port=Number(/Tomcat started on port (\d+)/.exec(output)?.[1])||port;
    };
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const expires=Date.now()+45000;
    while(!ended&&Date.now()<expires){
      if(port){
        const baseUrl='http://127.0.0.1:'+port;
        const response=await fetch(baseUrl+'/ready',{signal:AbortSignal.timeout(1000)}).catch(()=>null);
        if(response?.ok&&(await response.json()).ready===true){
          const observer=JSON.parse(await fs.readFile(descriptorFile,'utf8'));
          if(observer.feignContractTraceEnabled!==enabled)throw Error('The Feign fixture observer did not honor its opt-in.');
          return {baseUrl,upstream,observer:{url:observer.baseUrl,token},requests,close};
        }
      }
      await delay(100);
    }
    for(const value of [token,upstream,db?.password,db?.user,env.RB_FEIGN_JDBC].filter(Boolean))output=output.replaceAll(value,'[private]');
    throw Error('The owned OpenFeign fixture did not start. '+output.slice(-2000));
  }catch(error){await close();throw error;}
}

module.exports={buildFeignFixture,startFeignFixture,project};
if(require.main===module)buildFeignFixture().then(console.log,error=>{
  console.error(error.stderr||error.message);
  process.exitCode=1;
});
