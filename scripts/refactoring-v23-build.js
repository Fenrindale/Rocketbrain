'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');
const project=path.join(root,'test/fixtures/refactoring-v23-build');
const routes=Object.freeze({bridge:[],core:['-PskipBridge=yes'],alternate:['-Proute=alternate']});

function buildV23(java,route='bridge') {
 if(!Object.hasOwn(routes,route))throw Error('Use an owned v0.23 build route.');
 const home=process.env.ROCKETBRAIN_GRADLE_HOME||java.gradleHome;
 const launcher=path.join(home,'lib/gradle-launcher-9.1.0.jar');
 const tasks=[':v23-app:classes',':v23-core:jar',':v23-bridge:jar',':v23-alternate:jar',':v23-app:writeClasspath'];
 const result=spawnSync(path.join(java.javaHome,'bin',process.platform==='win32'?'java.exe':'java'),[
  '-Dorg.gradle.java.home='+java.javaHome,'-cp',launcher,'org.gradle.launcher.GradleMain',
  '--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',path.join(root,'test-output/java-gradle-user-home'),
  ...routes[route],...tasks
 ],{cwd:project,windowsHide:true,encoding:'utf8',timeout:240000});
 if(result.error||result.status!==0)throw Error(`Owned Gradle route ${route} failed. ${result.error||''}\n${result.stderr}\n${result.stdout}`);
 const classpathFile=path.join(project,'v23-app/build/runtime-classpath.txt');
 const classpath=fs.readFileSync(classpathFile,'utf8').split(path.delimiter);
 for(const dependency of ['bridge','alternate']){
  const present=classpath.some(file=>path.basename(file)===`v23-${dependency}.jar`);
  if(present!==(route===dependency))throw Error('The Gradle classpath did not select the requested route: '+route);
 }
 if(!classpath.some(file=>path.basename(file)==='v23-core.jar'))throw Error('The Gradle classpath is missing its reviewed core JAR.');
 return classpathFile;
}

async function main() {
 const separator=process.argv.indexOf('--');
 if(separator<0||!process.argv[separator+1])throw Error('Pass the owned child Node script after --.');
 const parent=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
 const java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
 const config={...parent,projectPath:path.join(project,'v23-app'),buildV23Root:project,
  mainClass:'fixture.buildv23.BuildApplication',refactoringClassPathFile:buildV23(java)};
 const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.23';
 const file=path.join(root,'test-output',prefix+'-build-v23-runtime-'+crypto.randomUUID()+'.json');
 fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
 process.exitCode=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,process.argv.slice(separator+1),{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,ROCKETBRAIN_BUILD_V23_CONFIG:file}});
  child.once('error',reject);
  child.once('exit',code=>resolve(code??1));
 });
}

if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={buildV23,routes};
