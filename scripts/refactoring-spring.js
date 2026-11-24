'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),project=path.join(root,'test/fixtures/refactoring-spring'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function startRefactoringApp(config,{classpath}={}){
 const java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG)),db=JSON.parse(fs.readFileSync(config.dbConfigPath)),port=await freePort(),baseUrl='http://127.0.0.1:'+port,cp=classpath||fs.readFileSync(path.join(config.projectPath,'build/runtime-classpath.txt'),'utf8').trim();
 const candidates=[
  [project,'fixture.boot.RefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-multi/app'),'fixture.movev20.MultiRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v21-multi/app'),'fixture.movev21.MultiRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v22-build/app'),'fixture.buildv22.MultiRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v22-package'),'fixture.packagev22.PackageRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v22-spring'),'fixture.dynamicv22.app.DynamicContractsApplication'],
  [path.join(root,'test/fixtures/refactoring-v22-state'),'fixture.statev22.StateApplication'],
  [path.join(root,'test/fixtures/refactoring-v23-build/v23-app'),'fixture.buildv23.BuildApplication'],
  [path.join(root,'test/fixtures/refactoring-v23-package'),'fixture.packagev23.PackageRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v23-spring'),'fixture.dynamicv23.app.DynamicContractsApplication'],
  [path.join(root,'test/fixtures/refactoring-v23-state'),'fixture.statev23.StateApplication'],
  [path.join(root,'test/fixtures/refactoring-v24-state'),'fixture.statev24.StateApplication'],
  [path.join(root,'test/fixtures/refactoring-v24-package'),'fixture.packagev24.PackageRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v25-package'),'fixture.packagev25.PackageRefactoringApplication'],
 [path.join(root,'test/fixtures/refactoring-v26-package'),'fixture.packagev26.PackageRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v27-package-http'),'fixture.packagev27.http.PackageRefactoringApplication'],
  [path.join(root,'test/fixtures/refactoring-v24-spring'),'fixture.dynamicv24.app.DynamicContractsApplication'],
  [path.join(root,'test/fixtures/refactoring-v25-spring'),'fixture.conditionsv25.app.ConditionsApplication'],
  [path.join(root,'test/fixtures/refactoring-v26-spring'),'fixture.conditionsv26.app.ConditionsApplication'],
  [path.join(root,'test/fixtures/refactoring-v27-spring'),'fixture.conditionsv27.app.ConditionsApplication'],
  [path.join(root,'test/fixtures/refactoring-v24-maven/rb24-app'),'fixture.mavenv24.MavenContractApplication'],
  [path.join(root,'test/fixtures/refactoring-v25-maven/rb25-app'),'fixture.mavenv25.MavenContractApplication'],
  [path.join(root,'test/fixtures/refactoring-v26-maven/rb26-app'),'fixture.mavenv26.MavenContractApplication'],
  [path.join(root,'test/fixtures/refactoring-v27-maven/rb27-app'),'fixture.mavenv27.MavenContractApplication'],
  [path.join(root,'test/fixtures/refactoring-v25-state'),'fixture.statev25.StateApplication'],
  [path.join(root,'test/fixtures/refactoring-v26-state'),'fixture.statev26.StateApplication'],
  [path.join(root,'test/fixtures/refactoring-v27-state'),'fixture.statev27.StateApplication']
 ];
 const selected=candidates.find(([folder])=>fs.existsSync(folder)&&path.relative(fs.realpathSync(config.projectPath),fs.realpathSync(folder))==='');
 if(!selected||cp.length>28000)throw Error('Use an owned refactoring Spring fixture and bounded classpath.');
 const child=spawn(path.join(java.javaHome,'bin/java.exe'),['-cp',cp,selected[1]],{cwd:selected[0],windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SERVER_ADDRESS:'127.0.0.1',SERVER_PORT:String(port),SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE:process.env.SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE||'2',SPRING_DATASOURCE_HIKARI_MINIMUM_IDLE:process.env.SPRING_DATASOURCE_HIKARI_MINIMUM_IDLE||'0',SPRING_DATASOURCE_URL:'jdbc:'+(config.dbEngine==='mariadb'?'mariadb':'mysql')+'://127.0.0.1:'+db.port+'/'+db.database,SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password}});let log='',exited=false;child.stdout.on('data',b=>{log=(log+b).slice(-12000);});child.stderr.on('data',b=>{log=(log+b).slice(-12000);});const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{exited=true;resolve(code);});});
 async function stop(){if(!exited)child.kill();let stopTimer;try{await Promise.race([exit,new Promise((_,reject)=>{stopTimer=setTimeout(()=>reject(Error('Owned refactoring Spring app did not stop.')),10000);})]);}finally{clearTimeout(stopTimer);}}
 try{const end=Date.now()+45000;while(Date.now()<end){if(exited)throw Error('Owned refactoring Spring app exited: '+log);try{const r=await fetch(baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(1000)});if(r.ok)return {baseUrl,stop};}catch{}await pause(150);}throw Error('Owned refactoring Spring app readiness timed out: '+log);}catch(e){await stop();throw e;}
}
async function verifyRefactoringHttp(config,{classpath,expectations={}}={}){const app=await startRefactoringApp(config,{classpath});try{const read=async url=>{const response=await fetch(app.baseUrl+url,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Transformed Spring endpoint failed: '+response.status);return response.json();};const extra={};for(const [route,expected]of Object.entries(expectations)){if(!route.startsWith('/')||route.startsWith('//')||Object.keys(extra).length>=12)throw Error('Use at most12 owned local HTTP verification paths.');const actual=await read(route);require('node:assert/strict').deepEqual(actual,expected);extra[route]=actual;}return {signature:await read('/probe/refactoring'),move:await read('/refactoring/move'),isolation:await read('/probe/testing-state'),...(Object.keys(extra).length?{extra}:{})};}finally{await app.stop();}}
async function main(){const separator=process.argv.indexOf('--');if(separator<0)throw Error('Pass the owned child Node script after --.');const parent=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG)),java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG)),gradle=process.env.ROCKETBRAIN_GRADLE_HOME||java.gradleHome||path.join(root,'research/implementation/runtimes/gradle-9.1.0/extracted/gradle-9.1.0'),launcher=path.join(gradle,'lib/gradle-launcher-9.1.0.jar'),build=spawnSync(path.join(java.javaHome,'bin/java.exe'),['-Dorg.gradle.java.home='+java.javaHome,'-cp',launcher,'org.gradle.launcher.GradleMain','--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',path.join(root,'test-output/java-gradle-user-home'),'classes','writeClasspath'],{cwd:project,windowsHide:true,encoding:'utf8',timeout:240000});if(build.status!==0)throw Error(build.stderr+'\n'+build.stdout);const config={...parent,projectPath:project,refactoringProjectPath:project,originalProjectPath:parent.projectPath,originalBaseUrl:parent.baseUrl};const app=await startRefactoringApp(config),file=path.join(root,'test-output',(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.20')+'-refactoring-runtime-'+crypto.randomUUID()+'.json');config.baseUrl=app.baseUrl;fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});try{process.exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,process.argv.slice(separator+1),{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,ROCKETBRAIN_SPRING_PROJECT_CONFIG:file}});child.once('error',reject);child.once('exit',code=>resolve(code??1));});}finally{await app.stop();}}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={startRefactoringApp,verifyRefactoringHttp};
