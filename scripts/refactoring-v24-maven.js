'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {SaxesParser}=require('saxes');

const root=path.resolve(__dirname,'..');
const project=path.join(root,'test/fixtures/refactoring-v24-maven');
const routes=Object.freeze({base:[],runtime:['-Prb24-runtime'],compile:['-Prb24-compile'],both:['-Prb24-compile,rb24-runtime']});

function maven(java,cwd,args,name) {
 const home=process.env.ROCKETBRAIN_MAVEN_HOME||path.join(root,'research/implementation/runtimes/v0.18-maven-cache/extracted/apache-maven-3.9.11');
 const boot=path.join(home,'boot');
 const launchers=fs.readdirSync(boot).filter(file=>/^plexus-classworlds-[\d.]+\.jar$/.test(file));
 assert.equal(launchers.length,1,'Set ROCKETBRAIN_MAVEN_HOME to the independently installed Apache Maven distribution.');
 const result=spawnSync(path.join(java.javaHome,'bin',process.platform==='win32'?'java.exe':'java'),[
  '-Dfile.encoding=UTF-8','-Dmaven.home='+home,'-Dclassworlds.conf='+path.join(home,'bin/m2.conf'),
  '-Dmaven.multiModuleProjectDirectory='+cwd,'-cp',path.join(boot,launchers[0]),
  'org.codehaus.plexus.classworlds.launcher.Launcher','-B','-ntp',...args
 ],{cwd,windowsHide:true,encoding:'utf8',timeout:240000});
 const log=path.join(cwd,name+'.log');
 fs.writeFileSync(log,[result.stdout,result.stderr,result.error?.message].filter(Boolean).join('\n'),{flag:'wx'});
 if(result.error||result.status!==0)throw Error('Owned Maven fixture build failed. See '+log);
}

function effectiveAppScope(file) {
 const parser=new SaxesParser({xmlns:false}),stack=[];
 let current,scope;
 parser.on('opentag',tag=>{
  stack.push({name:tag.name,text:''});
  if(stack.map(node=>node.name).join('/')==='project/dependencies/dependency')current={};
 });
 parser.on('text',text=>{if(stack.length)stack.at(-1).text+=text;});
 parser.on('closetag',()=>{
  const item=stack.pop();
  if(current&&stack.length===3)current[item.name]=item.text.trim();
  if(current&&stack.length===2&&item.name==='dependency'){
   if(current.groupId==='org.rocketbrain.fixture.v24'&&current.artifactId==='rb24-app'){
    assert.equal(scope,undefined,'Duplicate effective rb24-app dependency.');
    scope=current.scope??'compile';
   }
   current=undefined;
  }
 });
 parser.write(fs.readFileSync(file,'utf8')).close();
 assert.ok(scope,'Maven effective POM is missing its app dependency.');
 return scope;
}

function buildMavenV24(java,route) {
 assert.ok(Object.hasOwn(routes,route));
 const parent=path.join(root,'test-output/v0.24-maven-build');
 fs.mkdirSync(parent,{recursive:true});
 const checkout=fs.mkdtempSync(path.join(parent,route+'-'));
 for(const module of ['', 'rb24-core','rb24-app','rb24-consumer']){
  const target=path.join(checkout,module),source=path.join(project,module);
  fs.mkdirSync(target,{recursive:true});fs.copyFileSync(path.join(source,'pom.xml'),path.join(target,'pom.xml'));
  if(module)fs.cpSync(path.join(source,'src'),path.join(target,'src'),{recursive:true,errorOnExist:true,force:false});
 }
 const flags=routes[route];
 maven(java,checkout,[...flags,'package','org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath',
  '-Dmdep.outputFile=target/runtime-classpath.txt','-DincludeScope=runtime','-DskipTests'],'package');
 const pom=path.join(checkout,'consumer-effective.xml');
 maven(java,checkout,[...flags,'-pl','rb24-consumer','org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom','-Doutput='+pom],'effective');
 const scope=effectiveAppScope(pom);
 assert.equal(scope,route==='runtime'?'runtime':'compile');
 const app=path.join(checkout,'rb24-app');
 const dependencies=fs.readFileSync(path.join(app,'target/runtime-classpath.txt'),'utf8').trim().split(path.delimiter);
 assert.ok(dependencies.every(file=>path.isAbsolute(file)&&fs.existsSync(file)));
 const core=fs.realpathSync(path.join(checkout,'rb24-core/target/rb24-core-1.0.0.jar'));
 assert.ok(dependencies.some(file=>path.relative(core,fs.realpathSync(file))===''));
 return {classpath:[path.join(app,'target/classes'),...dependencies].join(path.delimiter),scope};
}

async function main() {
 const separator=process.argv.indexOf('--');
 if(separator<0||!process.argv[separator+1])throw Error('Pass the owned child Node script after --.');
 const parent=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
 const config={...parent,projectPath:path.join(project,'rb24-app'),mavenV24Root:project};
 const output=path.join(root,'test-output','v0.24-maven-runtime-'+randomUUID()+'.json');
 fs.writeFileSync(output,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
 process.exitCode=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,process.argv.slice(separator+1),{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,ROCKETBRAIN_MAVEN_V24_CONFIG:output}});
  child.once('error',reject);child.once('exit',code=>resolve(code??1));
 });
}

if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={buildMavenV24,routes,maven};
