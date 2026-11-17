'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const VERSION='0.9.0',JUNIT_VERSION='6.0.3',JACOCO_VERSION='0.8.16',TESTNG_VERSION='7.11.0';
const MAVEN='https://repo.maven.apache.org/maven2/';
const ARTIFACTS=[
  {name:'jacocoCore',file:'org.jacoco.core-0.8.16.jar',url:MAVEN+'org/jacoco/org.jacoco.core/0.8.16/org.jacoco.core-0.8.16.jar',sha256:'5d2db23c5d698e5645f47f07d1b6019ccd03e15cc933d60d1d4e798ac6bd1f84',sha1:'bd8f844aac034877b49780c8154007ade7023735',license:'EPL-2.0; source retained in upstream JaCoCo archive'},
  {name:'junit',file:'junit-platform-console-standalone-6.0.3.jar',url:MAVEN+'org/junit/platform/junit-platform-console-standalone/6.0.3/junit-platform-console-standalone-6.0.3.jar',sha256:'3ba0d6150af79214a1411f9ea2fbef864eef68b68c89a17f672c0b89bff9d3a2',sha1:'ba30d592392d0a989291830597fd39dbff5694c2',license:'EPL-2.0 plus bundled component notices'},
  {name:'jacocoAgent',file:'org.jacoco.agent-0.8.16-runtime.jar',url:MAVEN+'org/jacoco/org.jacoco.agent/0.8.16/org.jacoco.agent-0.8.16-runtime.jar',sha256:'37ae2f374ad77e85c59c6e5b46565226c3ac3cb460ac19de0bcb844ac2f43e33',sha1:'4325ec32eef129534b61041814d25ec88e3023ce',license:'EPL-2.0 plus embedded ASM BSD notices'},
  {name:'jacocoCli',file:'org.jacoco.cli-0.8.16-nodeps.jar',url:MAVEN+'org/jacoco/org.jacoco.cli/0.8.16/org.jacoco.cli-0.8.16-nodeps.jar',sha256:'1f2a806225623fbd9f53d1ee0e42a6975323de0adebe01c12fc464ed147d756a',sha1:'00718402b9bf534b3c8dceb66408b3c568907e64',license:'EPL-2.0 plus shaded ASM/args4j notices'},
  {name:'junitSources',file:'junit-framework-r6.0.3.zip',url:'https://codeload.github.com/junit-team/junit-framework/zip/refs/tags/r6.0.3',sha256:'8f805edbb5ef6634c57da88c5a7cdfce560ec2eaccdf8989e3ae149cbfe5318f',source:true},
  {name:'jacocoSources',file:'jacoco-v0.8.16.zip',url:'https://codeload.github.com/jacoco/jacoco/zip/refs/tags/v0.8.16',sha256:'267f34b106b4ffb96240bb963b0357407854d606282fcc28b09ef5760dfd5252',source:true},
  {name:'asmSources',file:'asm-9.11.1-sources.jar',url:MAVEN+'org/ow2/asm/asm/9.11.1/asm-9.11.1-sources.jar',sha256:'3cfc56ad047260d8ccff50cd55af8922a9c9e2b0439c6eba801dbfaf0870a3ae',source:true,license:'BSD-3-Clause'},
  {name:'asmCommonsSources',file:'asm-commons-9.11.1-sources.jar',url:MAVEN+'org/ow2/asm/asm-commons/9.11.1/asm-commons-9.11.1-sources.jar',sha256:'3a432534d33bed91412c6dcf8b75805e21c5a360844c01f48dab9bb68aedb314',source:true,license:'BSD-3-Clause'},
  {name:'asmTreeSources',file:'asm-tree-9.11.1-sources.jar',url:MAVEN+'org/ow2/asm/asm-tree/9.11.1/asm-tree-9.11.1-sources.jar',sha256:'203604136ea5f116a261aa10a415d25a8e74897749c128e532853ec4a748c572',source:true,license:'BSD-3-Clause'},
  {name:'args4jSources',file:'args4j-2.0.28-sources.jar',url:MAVEN+'args4j/args4j/2.0.28/args4j-2.0.28-sources.jar',sha256:'ec1eb6aa4859b9b4fd9da4d58efb28b2eb629a4c14919e9078054879540243b7',source:true,license:'MIT'},
  {name:'junit4Sources',file:'junit-4.13.2-sources.jar',url:MAVEN+'junit/junit/4.13.2/junit-4.13.2-sources.jar',sha256:'34181df6482d40ea4c046b063cb53c7ffae94bdf1b1d62695bdf3adf9dea7e3a',source:true,license:'EPL-1.0'},
  {name:'testng',file:'testng-7.11.0.jar',url:MAVEN+'org/testng/testng/7.11.0/testng-7.11.0.jar',sha256:'2edbe6b2211186d8f5439cba7998697cce883432e5f14e0696f6b59d0d58582b',sha1:'c75ee639e6fc9c0a406d32608d532d9ee9341941',license:'Apache-2.0'},
  {name:'slf4j',file:'slf4j-api-2.0.16.jar',url:MAVEN+'org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar',sha256:'a12578dde1ba00bd9b816d388a0b879928d00bab3c83c240f7013bf4196c579a',sha1:'0172931663a09a1fa515567af5fbef00897d3c04',license:'MIT'},
  {name:'jcommander',file:'jcommander-1.83.jar',url:MAVEN+'org/jcommander/jcommander/1.83/jcommander-1.83.jar',sha256:'e65f49c2119a1859b9076061e561fb5958a2fa6ffdb49f051ca8d59a0b3f87e4',sha1:'c342a2ad17ec08db105146e27c7ba9c535c9bb46',license:'Apache-2.0'},
  {name:'jquery',file:'jquery-3.7.1.jar',url:MAVEN+'org/webjars/jquery/3.7.1/jquery-3.7.1.jar',sha256:'262016dd3a559df87aefbe392804e9bf620787c9204c0ab8522d4c231ea65097',sha1:'42088e652462c40a369b64d87e18e825644acfab',license:'MIT; contains original unminified source'},
  {name:'testngSources',file:'testng-7.11.0-sources.jar',url:MAVEN+'org/testng/testng/7.11.0/testng-7.11.0-sources.jar',sha256:'46481629949f5b9a14785900465982f52d2a7c7035c97c6a15ba89351f077063',sha1:'ee9985cf84428b6e7ec90df79329be23e12676cb',source:true,license:'Apache-2.0'},
  {name:'slf4jSources',file:'slf4j-api-2.0.16-sources.jar',url:MAVEN+'org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16-sources.jar',sha256:'d938ad56953d65bd0806f75d17535fa32b1fc5078051212e0b010f69ec43f8cb',sha1:'68223612de5e53b90b752bbbe520390ae1f104db',source:true,license:'MIT'},
  {name:'jcommanderSources',file:'jcommander-1.83-sources.jar',url:MAVEN+'org/jcommander/jcommander/1.83/jcommander-1.83-sources.jar',sha256:'464d3bab6fe58dd9f516fe1ca79441c3d32bd70e059cda2f355635b766324572',sha1:'6922a28c613ecd528348292b319ab069b3e9e88a',source:true,license:'Apache-2.0'},
  {name:'jcommanderLicense',file:'jcommander-1.83-LICENSE.txt',url:'https://raw.githubusercontent.com/cbeust/jcommander/1.83/license.txt',sha256:'84e47ad478cd58ac4631a5dcf331eb7e74295eb5ec9d3846ed2163681b7db6c9',source:true,license:'Apache-2.0'},
  {name:'jqueryLicense',file:'jquery-3.7.1-LICENSE.txt',url:'https://raw.githubusercontent.com/jquery/jquery/3.7.1/LICENSE.txt',sha256:'d4db9ebe6f29f5168eac45ad713f055623ac5d0dcd5ba92da23d650ae012020d',source:true,license:'MIT'}
];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
class TestingError extends Error {constructor(code,message){super(message);this.name='JavaTestingError';this.code=code;}}
function validateJavaHome(javaHome){
  if(typeof javaHome!=='string'||!path.isAbsolute(javaHome))throw new TestingError('INVALID_JDK','Set an absolute independent full JDK25 or newer path.');
  const resolved=fs.realpathSync(javaHome),release=fs.readFileSync(path.join(resolved,'release'),'utf8');
  if(/jetbrains|intellij|datagrip|(?:^|[\\/])jbr(?:[\\/]|$)/i.test(resolved+'\n'+release))throw new TestingError('IDE_RUNTIME','Use an independent general JDK; an original IDE runtime is not used.');
  const major=Number(/^JAVA_VERSION="(\d+)/m.exec(release)?.[1]);if(!Number.isInteger(major)||major<25)throw new TestingError('INVALID_JDK','Java testing requires a full JDK25 or newer.');
  for(const name of ['java','javac','jar'])if(!fs.existsSync(path.join(resolved,'bin',name+(process.platform==='win32'?'.exe':''))))throw new TestingError('INVALID_JDK','The selected JDK is missing '+name+'.');
  return {javaHome:resolved,release,releaseHash:sha(release),version:/^JAVA_VERSION="([^"]+)/m.exec(release)?.[1]};
}
function execute(program,args,{cwd,env,timeoutMs=120000,onOutput,onStarted,cancellation,maxOutputBytes=2*1024*1024}={}){
  return new Promise((resolve,reject)=>{
    if(cancellation?.isCancellationRequested||cancellation?.aborted){resolve({code:null,cancelled:true,output:'',pid:null});return;}
    const child=spawn(program,args,{cwd,env:env||process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',bytes=0,settled=false,cancelled=false,timedOut=false,subscription,closed,hookDone=!onStarted,hookError;
    const startup=new AbortController();const stop=()=>{cancelled=true;startup.abort();child.kill();};
    if(cancellation?.onCancellationRequested)subscription=cancellation.onCancellationRequested(stop);
    else if(cancellation?.addEventListener)cancellation.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>{timedOut=true;startup.abort();child.kill();},timeoutMs);
    const finish=(error,code,signal)=>{if(settled)return;closed={error,code,signal};if(!hookDone)return;settled=true;clearTimeout(timer);subscription?.dispose();cancellation?.removeEventListener?.('abort',stop);const failure=hookError||error;failure?reject(failure):resolve({code,signal,cancelled,timedOut,output,pid:child.pid});};
    child.once('spawn',()=>{if(!onStarted)return;Promise.resolve().then(()=>onStarted({pid:child.pid,cancellation:startup.signal})).catch(error=>{if(!cancelled&&!timedOut)hookError=new TestingError('DEBUG_START','Managed Java debugger startup failed: '+(error?.message||error));startup.abort();child.kill();}).finally(()=>{hookDone=true;if(closed)finish(closed.error,closed.code,closed.signal);});});
    const decoders=[new StringDecoder('utf8'),new StringDecoder('utf8')];
    const capture=(data,stream)=>{bytes+=data.length;if(bytes>maxOutputBytes){if(bytes-data.length<=maxOutputBytes)output+='\n[Output limit reached; remaining application output omitted.]\n';return;}const text=decoders[stream].write(data);output+=text;try{onOutput?.(text);}catch{}};
    child.stdout.on('data',data=>capture(data,0));child.stderr.on('data',data=>capture(data,1));child.once('error',error=>{hookDone=true;startup.abort();finish(new TestingError('PROCESS_START','Java process could not start: '+error.code));});child.once('close',(code,signal)=>{startup.abort();finish(null,code,signal);});
    // A project may spawn a process inheriting these pipes. Do not let that keep
    // the completed test JVM's control request pending indefinitely.
    child.once('exit',(code,signal)=>{const drain=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();finish(null,code,signal);},100);drain.unref();});
    if(cancellation?.isCancellationRequested||cancellation?.aborted)stop();
  });
}
async function publish(file,bytes){
  await fsp.mkdir(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)){if(sha(await fsp.readFile(file))!==sha(bytes))throw new TestingError('ARTIFACT_MISMATCH','Existing testing artifact differs: '+path.basename(file));return;}
  const temp=file+'.'+crypto.randomUUID()+'.partial';
  try{await fsp.writeFile(temp,bytes,{flag:'wx',mode:0o600});try{await fsp.link(temp,file);}catch(error){if(error.code!=='EEXIST'||sha(await fsp.readFile(file))!==sha(bytes))throw error;}}finally{await fsp.rm(temp,{force:true});}
}
async function downloadArtifact(artifact,target,cacheDirectory){
  const file=path.join(target,artifact.file);
  if(fs.existsSync(file)){if(sha(await fsp.readFile(file))!==artifact.sha256)throw new TestingError('ARTIFACT_MISMATCH','Installed testing artifact hash differs: '+artifact.file);return file;}
  const cached=cacheDirectory&&path.join(cacheDirectory,artifact.file);let bytes;
  if(cached&&fs.existsSync(cached))bytes=await fsp.readFile(cached);
  else{
    const response=await fetch(artifact.url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new TestingError('DOWNLOAD_FAILED','Testing runtime download returned HTTP '+response.status+'.');
    if(Number(response.headers.get('content-length'))>16*1024*1024)throw new TestingError('DOWNLOAD_LIMIT','Testing artifact exceeds 16 MiB.');
    const parts=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>16*1024*1024)throw new TestingError('DOWNLOAD_LIMIT','Testing artifact exceeds 16 MiB.');parts.push(chunk);}bytes=Buffer.concat(parts);
  }
  if(sha(bytes)!==artifact.sha256)throw new TestingError('ARTIFACT_MISMATCH','Testing artifact SHA-256 does not match the pinned release: '+artifact.file);
  await publish(file,bytes);return file;
}
function readLauncherSources(){const dir=path.resolve(__dirname,'../../../runtime/java-testing/src/rocketbrain/testing');return Object.fromEntries(fs.readdirSync(dir).filter(name=>name.endsWith('.java')).sort().map(name=>[name,fs.readFileSync(path.join(dir,name),'utf8')]));}
async function provisionTestingRuntime({target,javaHome,sources,cacheDirectory,onProgress=()=>{}}={}){
  if(typeof target!=='string'||!path.isAbsolute(target))throw new TestingError('INVALID_TARGET','Testing installation target must be absolute.');
  const jdk=validateJavaHome(javaHome);await fsp.mkdir(target,{recursive:true});const tools={};
  for(const artifact of ARTIFACTS){onProgress('Verifying '+artifact.file);tools[artifact.name]=await downloadArtifact(artifact,target,cacheDirectory);}
  sources||=require('./launcher-sources.json');const entries=Object.entries(sources).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.length||entries.length>8||!entries.some(([name])=>name==='Runner.java'))throw new TestingError('INVALID_SOURCE','Owned test launcher source is missing.');
  for(const [name,text]of entries)if(!/^[A-Za-z][A-Za-z0-9]*\.java$/.test(name)||typeof text!=='string'||Buffer.byteLength(text)>150000)throw new TestingError('INVALID_SOURCE','Invalid owned Java launcher source.');
  const sourceHashes=entries.map(([name,text])=>({name,sha256:sha(text)})),identity=sha(JSON.stringify({version:VERSION,sourceHashes,jdkRelease:jdk.releaseHash,artifacts:ARTIFACTS.filter(a=>!a.source).map(a=>[a.name,a.sha256]),recipe:'javac25-source-lines-jar-date-v1'})).slice(0,20);
  const launcherJar=path.join(target,'rocketbrain-java-testing-'+VERSION+'-'+identity+'.jar'),provenance=launcherJar+'.json';
  const bin=name=>path.join(jdk.javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  if(!fs.existsSync(launcherJar)||!fs.existsSync(provenance)){
    const work=await fsp.mkdtemp(path.join(target,'.java-testing-build-'));
    try{
      const sourcePath=path.join(work,'source','rocketbrain','testing'),classes=path.join(work,'classes');await fsp.mkdir(sourcePath,{recursive:true});await fsp.mkdir(classes);
      for(const [name,text]of entries)await fsp.writeFile(path.join(sourcePath,name),text);
      const compiled=await execute(bin('javac'),['--release','25','-encoding','UTF-8','-g:source,lines','-classpath',[tools.junit,tools.testng,tools.jacocoCore].join(path.delimiter),'-d',classes,...entries.map(([name])=>path.join(sourcePath,name))]);
      if(compiled.code!==0)throw new TestingError('LAUNCHER_BUILD','Owned Java launcher compilation failed:\n'+compiled.output);
      const jarFile=path.join(work,'launcher.jar'),packed=await execute(bin('jar'),['--create','--date=2026-11-13T00:00:00Z','--file',jarFile,'-C',classes,'.']);if(packed.code!==0)throw new TestingError('LAUNCHER_BUILD','Owned launcher packaging failed.');
      const jar=await fsp.readFile(jarFile);await publish(launcherJar,jar);await publish(provenance,Buffer.from(JSON.stringify({version:VERSION,identity,sourceHashes,sha256:sha(jar),jdkVersion:jdk.version,jdkReleaseSha256:jdk.releaseHash},null,2)+'\n'));
    }finally{if(path.dirname(path.resolve(work))!==path.resolve(target)||!path.basename(work).startsWith('.java-testing-build-'))throw new TestingError('INVALID_CLEANUP','Unexpected launcher scratch directory.');await fsp.rm(work,{recursive:true,force:true});}
  }
  const stored=JSON.parse(await fsp.readFile(provenance,'utf8'));if(stored.sha256!==sha(await fsp.readFile(launcherJar)))throw new TestingError('ARTIFACT_MISMATCH','Owned Java launcher hash differs.');
  const sourceDir=path.join(target,'owned-source',identity);await fsp.mkdir(sourceDir,{recursive:true});for(const [name,text]of entries)await publish(path.join(sourceDir,name),Buffer.from(text));
  const notices=path.join(target,'notices');await fsp.mkdir(notices,{recursive:true});
  for(const artifact of ARTIFACTS.filter(item=>!item.source)){
    const listing=await execute(bin('jar'),['tf',tools[artifact.name]]);if(listing.code!==0)throw new TestingError('ARTIFACT_INSPECTION','Cannot inspect runtime notices.');
    const names=listing.output.split(/\r?\n/).filter(name=>/^META-INF\/(?:[^/]*(?:LICENSE|NOTICE)[^/]*|maven\/[\w./-]+\/pom\.(?:xml|properties))$/i.test(name)&&!name.split('/').includes('..'));
    if(names.length){const directory=path.join(notices,artifact.name);await fsp.mkdir(directory,{recursive:true});const extracted=await execute(bin('jar'),['--extract','--file',tools[artifact.name],'--dir',directory,...names]);if(extracted.code!==0)throw new TestingError('ARTIFACT_INSPECTION','Cannot retain published runtime notices.');}
  }
  await fsp.writeFile(path.join(notices,'README.txt'),'Independent Java testing runtime\n\nJUnit Platform/Jupiter6.0.3, TestNG7.11.0 and JaCoCo0.8.16 are separately downloaded official releases. Their original upstream sources are retained beside the binaries. JaCoCo CLI shaded ASM9.11.1 (BSD-3-Clause) and args4j2.0.28 (MIT) original sources are retained, including original copyright/license headers; the unshaded public JaCoCoCore API is used only for OR-merging execution data. JUnit Vintage bundled JUnit4.13.2 original source is retained (EPL-1.0). The junit directory contains original binary licenses for JUnit, Hamcrest, picocli, open-test-reporting and fastcsv. TestNG is Apache-2.0; required SLF4J2.0.16 is MIT, JCommander1.83 is Apache-2.0, and JQuery3.7.1 is MIT. Original TestNG/SLF4J binary licenses and all Java dependency source JARs are retained. JCommander/JQuery release license files are retained beside their binaries, and the JQuery webjar includes original unminified source. Optional Guice and SnakeYAML integrations are not provisioned. Sources are unmodified. No test engine binary is bundled in the Rocketbrain VSIX. The runtime JSON records exact URLs, SHA-256 pins and available publisher SHA-1 metadata.\n');
  const result={schemaVersion:1,version:VERSION,junitVersion:JUNIT_VERSION,jacocoVersion:JACOCO_VERSION,testngVersion:TESTNG_VERSION,javaHome:jdk.javaHome,launcherJar,launcherSha256:stored.sha256,junitJar:tools.junit,jacocoAgentJar:tools.jacocoAgent,jacocoCliJar:tools.jacocoCli,jacocoCoreJar:tools.jacocoCore,testngJar:tools.testng,slf4jJar:tools.slf4j,jcommanderJar:tools.jcommander,jqueryJar:tools.jquery,sourceDir,noticesDir:notices,
    artifacts:ARTIFACTS.map(artifact=>({...artifact,path:tools[artifact.name],verified:true,publisherChecksum:artifact.sha1?{algorithm:'sha1',expected:artifact.sha1,url:artifact.url+'.sha1'}:undefined})),sourceHashes,licenseScope:'Runtime binaries are separately provisioned, not included in the VSIX. Original binary embedded notices and original upstream source archives are retained. No original IDE or external VSIX is used.',installedAt:new Date().toISOString()};
  const runtimePath=path.join(target,'java-testing-runtime.json');await fsp.writeFile(runtimePath,JSON.stringify(result,null,2)+'\n');return {...result,runtimePath};
}
module.exports={provisionTestingRuntime,readLauncherSources,validateJavaHome,execute,TestingError,ARTIFACTS,VERSION,JUNIT_VERSION,JACOCO_VERSION,TESTNG_VERSION,sha};
