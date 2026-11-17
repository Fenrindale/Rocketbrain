'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {StringDecoder}=require('node:string_decoder');
const {parseJavaFile}=require('../../spring/java');
const {provisionTestingRuntime,validateJavaHome,execute,TestingError,ARTIFACTS,sha}=require('./provision');
const {parseCoverageXml,snapshotInputs,locateSource}=require('./coverage');
const LIMITS={classPaths:1000,roots:40,selectors:2000,events:50000,eventBytes:32*1024*1024};
const isCancelled=value=>Boolean(value?.isCancellationRequested||value?.aborted);
function absolute(value,label,directory=false){if(typeof value!=='string'||!path.isAbsolute(value)||value.length>4096||value.includes('\0'))throw new TestingError('INVALID_CONFIG',label+' must be an absolute local path.');const real=fs.realpathSync(value);if(directory&&!fs.statSync(real).isDirectory())throw new TestingError('INVALID_CONFIG',label+' must be a directory.');return real;}
function paths(value,label,maximum,directory=false){if(!Array.isArray(value)||value.length>maximum)throw new TestingError('INVALID_CONFIG',label+' must be a bounded path list.');return [...new Set(value.map(item=>absolute(item,label,directory)))];}
function resolveRuntime(value){
  const runtime=typeof value==='string'?JSON.parse(fs.readFileSync(absolute(value,'Testing runtime'),'utf8').replace(/^\uFEFF/,'')):value;
  if(!runtime||runtime.version!=='0.9.0'||runtime.junitVersion!=='6.0.3'||runtime.jacocoVersion!=='0.8.16'||runtime.testngVersion!=='7.11.0')throw new TestingError('RUNTIME_REQUIRED','Prepare the independent Java testing runtime first.');
  const result={...runtime};
  for(const [key,name]of [['junitJar','junit'],['jacocoAgentJar','jacocoAgent'],['jacocoCliJar','jacocoCli'],['jacocoCoreJar','jacocoCore'],['testngJar','testng'],['slf4jJar','slf4j'],['jcommanderJar','jcommander'],['jqueryJar','jquery']]){result[key]=absolute(runtime[key],key);if(sha(fs.readFileSync(result[key]))!==ARTIFACTS.find(item=>item.name===name).sha256)throw new TestingError('ARTIFACT_MISMATCH','Testing runtime integrity check failed: '+key);}
  result.launcherJar=absolute(runtime.launcherJar,'Launcher JAR');if(!/^[a-f0-9]{64}$/.test(runtime.launcherSha256||'')||sha(fs.readFileSync(result.launcherJar))!==runtime.launcherSha256)throw new TestingError('ARTIFACT_MISMATCH','Owned launcher integrity check failed.');return result;
}
function normalizeConfig(input){
  if(!input||typeof input!=='object')throw new TestingError('INVALID_CONFIG','A Java testing project is required.');
  const jdk=validateJavaHome(input.javaHome),workspace=absolute(input.workspace,'Project workspace',true),runtime=resolveRuntime(input.runtimePath||input.runtime);
  const classPath=paths(input.classPath||[],'Test classpath',LIMITS.classPaths),testClassPaths=paths(input.testClassPaths||[],'Test output roots',LIMITS.roots,true),sourceRoots=paths(input.sourceRoots||[],'Source roots',LIMITS.roots,true),classDirectories=paths(input.classDirectories||[],'Main class directories',LIMITS.roots,true);
  if(!testClassPaths.length)throw new TestingError('INVALID_CONFIG','Build the project and provide test output roots.');
  const timeoutMs=input.timeoutMs??180000;if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30*60*1000)throw new TestingError('INVALID_CONFIG','Testing timeout must be 1 second to 30 minutes.');
  const jvmArgs=input.jvmArgs||[];if(!Array.isArray(jvmArgs)||jvmArgs.length>100||jvmArgs.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>8192||/^(?:-cp|-classpath|--class-path|-jar|--module-path|-p|@)/.test(arg)))throw new TestingError('INVALID_CONFIG','JVM options cannot replace the managed testing classpath or argument file.');
  const env={...process.env};if(input.env!==undefined){if(!input.env||typeof input.env!=='object'||Array.isArray(input.env)||Object.keys(input.env).length>200)throw new TestingError('INVALID_CONFIG','Invalid testing environment.');for(const [key,value]of Object.entries(input.env)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||value.includes('\0'))throw new TestingError('INVALID_CONFIG','Invalid testing environment entry.');env[key]=value;}}
  // Engine communication is always local stdio/files, never inherited JDT socket controls.
  for(const key of ['CLIENT_PORT','CLIENT_HOST','CLIENT_PIPE'])delete env[key];
  const outputRoot=input.outputRoot||path.join(os.tmpdir(),'rocketbrain-java-testing');if(!path.isAbsolute(outputRoot))throw new TestingError('INVALID_CONFIG','Testing output root must be absolute.');
  const framework=input.framework||'junit';if(!['junit','testng'].includes(framework))throw new TestingError('INVALID_CONFIG','Select junit or testng as the testing framework.');
  return {...input,...jdk,workspace,runtime,framework,classPath,testClassPaths,sourceRoots,classDirectories,timeoutMs,jvmArgs,env,outputRoot};
}
function normalizeSelectors(selectors=[]){
  if(!Array.isArray(selectors)||selectors.length>LIMITS.selectors)throw new TestingError('INVALID_SELECTORS','Invalid test selection.');
  return selectors.map(selector=>{if(!selector||!['uniqueId','class','method','package'].includes(selector.kind)||typeof selector.value!=='string'||!selector.value.trim()||selector.value.length>8192||/[\r\n\0]/.test(selector.value))throw new TestingError('INVALID_SELECTORS','Use class, method, package or exact JUnit unique-ID selectors.');return {kind:selector.kind,value:selector.value};});
}
function sourceLocator(roots){
  const cache=new Map();
  return item=>{
    if(!item||typeof item!=='object')return item;
    const result={...item},className=typeof item.className==='string'?item.className:null;
    if(className){
      const top=className.split('$')[0],relative=top.replaceAll('.','/')+'.java',location=locateSource(roots,relative);
      if(location){result.uri=location.uri;if(!cache.has(location.file)){try{const text=fs.readFileSync(location.file,'utf8');cache.set(location.file,text.length<=2*1024*1024?parseJavaFile({uri:location.uri,text}):null);}catch{cache.set(location.file,null);}}
        const file=cache.get(location.file),type=file?.types?.find(value=>value.fqn===className.replaceAll('$','.'))||(!className.includes('$')?file?.types?.find(value=>value.fqn===top):undefined);
        if(item.methodName&&file){const methods=(type?.methods||[]).filter(method=>method.name===item.methodName);const parameterCount=typeof item.methodParameterTypes==='string'?(item.methodParameterTypes?item.methodParameterTypes.split(',').length:0):undefined;const choices=parameterCount===undefined?methods:methods.filter(method=>method.parameters?.length===parameterCount);if(choices.length===1&&choices[0].range){result.range=choices[0].range;result.line=result.range.start.line;}}
        if(result.line===undefined&&type?.range){result.range=type.range;result.line=type.range.start.line;}
      }
    }
    if(result.error?.frames)result.error={...result.error,frames:result.error.frames.map(frame=>{const location=frame.className&&locateSource(roots,frame.className.split('$')[0].replaceAll('.','/')+'.java');return location?{...frame,uri:location.uri}:frame;})};
    return result;
  };
}
function manifestText(files){
  const urls=files.map(file=>pathToFileURL(file).href+(fs.statSync(file).isDirectory()?'/':''));
  const header='Class-Path: '+urls.join(' ');let remaining=header,lines=['Manifest-Version: 1.0'];let first=true;
  while(remaining.length){const amount=first?70:69;lines.push((first?'':' ')+remaining.slice(0,amount));remaining=remaining.slice(amount);first=false;}
  return lines.join('\r\n')+'\r\n\r\n';
}
async function classpathJar(config,directory,coverage){
  const filtered=config.classPath.filter(file=>!/^junit-(?:platform-|jupiter-|vintage-|4(?:\.|-))/.test(path.basename(file))&&!/^testng-/.test(path.basename(file)));
  const fallbacks=[['slf4jJar',/^slf4j-api-/],['jcommanderJar',/^jcommander-/],['jqueryJar',/^jquery-/]].filter(([,pattern])=>!filtered.some(file=>pattern.test(path.basename(file)))).map(([key])=>config.runtime[key]);
  const files=[...new Set([config.runtime.launcherJar,config.runtime.junitJar,config.runtime.testngJar,...(coverage?[config.runtime.jacocoAgentJar,config.runtime.jacocoCoreJar]:[]),...config.testClassPaths,...filtered,...fallbacks])];
  const manifest=path.join(directory,'MANIFEST.MF'),jar=path.join(directory,'classpath.jar');await fsp.writeFile(manifest,manifestText(files));
  const result=await execute(path.join(config.javaHome,'bin','jar'+(process.platform==='win32'?'.exe':'')),['--create','--file',jar,'--manifest',manifest],{cwd:directory});if(result.code!==0)throw new TestingError('CLASSPATH_BUILD','Could not create the private testing classpath manifest.');return jar;
}
function privateProperties(entries){return Object.entries(entries).map(([key,value])=>key+'='+Buffer.from(String(value),'utf8').toString('base64')).join('\n')+'\n';}
async function generateCoverage(config,directory,before,onOutput,cancellation){
  const execFile=path.join(directory,'jacoco.exec'),xmlFile=path.join(directory,'coverage.xml'),htmlDirectory=path.join(directory,'coverage-html');
  const unavailable=reason=>({state:'unavailable',scope:'run',perTestCoverage:false,execFile,xmlFile,files:[],warnings:[reason]});
  if(!fs.existsSync(execFile))return unavailable('No coverage execution data was saved; cancelled or abruptly terminated JVMs may not run shutdown hooks.');
  const after={classes:await snapshotInputs(config.classDirectories,'.class'),sources:await snapshotInputs(config.sourceRoots,'.java',{maximumFiles:10000,maximumBytes:64*1024*1024})};
  if(JSON.stringify(before)!==JSON.stringify(after))return unavailable('Compiled classes or source files changed during the run. Rebuild and rerun coverage.');
  const args=['-jar',config.runtime.jacocoCliJar,'report',execFile,...config.classDirectories.flatMap(file=>['--classfiles',file]),...config.sourceRoots.flatMap(file=>['--sourcefiles',file]),'--encoding','UTF-8','--xml',xmlFile,'--html',htmlDirectory];
  const result=await execute(path.join(config.javaHome,'bin','java'+(process.platform==='win32'?'.exe':'')),args,{cwd:config.workspace,env:config.env,timeoutMs:60000,onOutput,cancellation});
  if(result.code!==0||result.cancelled||/does not match|do not match|Some classes do not match/.test(result.output))return unavailable('Coverage report could not be matched to the current compiled classes. '+result.output.slice(-1500));
  return parseCoverageXml(await fsp.readFile(xmlFile,'utf8'),{sourceRoots:config.sourceRoots,execFile,xmlFile,htmlDirectory});
}
async function mergeCoverage(config,directory,cp,inputs,output,cancellation){
  const merge=path.join(directory,'merge-'+crypto.randomUUID()+'.properties'),entries={count:inputs.length,output:pathToFileURL(output).href};inputs.forEach((file,index)=>entries['file.'+index]=pathToFileURL(file).href);await fsp.writeFile(merge,privateProperties(entries),{flag:'wx',mode:0o600});
  const result=await execute(path.join(config.javaHome,'bin','java'+(process.platform==='win32'?'.exe':'')),['-cp',cp,'rocketbrain.testing.CoverageFiles',pathToFileURL(merge).href],{cwd:config.workspace,env:config.env,timeoutMs:60000,cancellation});
  if(result.code!==0||result.cancelled||result.timedOut)throw new TestingError('COVERAGE_MERGE','JaCoCo interval data could not be merged: '+result.output.slice(-1000));
}
async function intervalCoverage(config,directory,cp,events,before,options){
  const warnings=['Measurements cover serial global probe intervals, including any background/async work observed in that interval; they do not prove sole causality.',config.framework==='testng'?'TestNG test listener boundaries exclude @BeforeMethod/@AfterMethod; those configurations and shared suite/class lifecycle work are unattributed.':'JUnit test execution intervals include per-test lifecycle; shared class/suite lifecycle and gaps are unattributed.'];
  const scope='test-execution-interval',unavailable=reason=>({state:'unavailable',scope,tests:[],warnings:[...warnings,reason],concurrencyObserved:events.some(event=>event.type==='perTestCoverage'&&event.concurrencyObserved)});
  const records=events.filter(event=>event.type==='coverageWindow'),files=records.map(event=>{if(!/^coverage-window-\d{6}\.exec$/.test(event.file)||event.testId!==null&&typeof event.testId!=='string')throw new TestingError('EVENT_PROTOCOL','Invalid coverage interval record.');return path.join(directory,event.file);});
  const final=path.join(directory,'jacoco.exec'),tail=path.join(directory,'jacoco-tail.exec');if(fs.existsSync(final)){await fsp.rename(final,tail);files.push(tail);}if(files.length)await mergeCoverage(config,directory,cp,files,final,options.cancellation);
  const status=events.findLast(event=>event.type==='perTestCoverage');if(!status||status.state!=='available'||events.some(event=>event.type==='perTestCoverageError'))return unavailable(events.filter(event=>event.type==='perTestCoverageError').map(event=>event.message).join(' ')||'Complete serial callback boundaries were not established.');
  const groups=new Map();for(const event of records){const key=event.testId??null;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(path.join(directory,event.file));}
  const result={state:'available',scope,tests:[],warnings,concurrencyObserved:false};let count=0;
  for(const [testId,inputs]of groups){if(isCancelled(options.cancellation))return unavailable('Coverage reporting was cancelled.');if(testId!==null&&count++>=100){result.state='partial';if(!warnings.some(w=>w.includes('100 tests')))warnings.push('Per-test detailed reports are limited to 100 tests; complete overall run coverage is retained.');continue;}
    const report=path.join(directory,'interval-reports',testId===null?'unattributed':String(count).padStart(4,'0'));await fsp.mkdir(report,{recursive:true});await mergeCoverage(config,directory,cp,inputs,path.join(report,'jacoco.exec'),options.cancellation);const coverage=await generateCoverage(config,report,before,options.onOutput,options.cancellation);coverage.scope=testId===null?'unattributed-lifecycle-interval':scope;coverage.perTestCoverage=false;
    if(coverage.state!=='available')return unavailable(coverage.warnings.join(' '));if(testId===null)result.unattributed={coverage};else result.tests.push({testId,coverage});
  }
  if(!result.tests.length)return unavailable('No actual completed test interval was measured.');return result;
}
async function perform(mode,input,options={}){
  const config=normalizeConfig(input),selectors=normalizeSelectors(options.selectors),excluded=normalizeSelectors(options.excludes);
  if(excluded.some(item=>item.kind!=='uniqueId'||config.framework==='junit'&&/\[(?:dynamic-test|test-template-invocation):/.test(item.value)))throw new TestingError('UNSUPPORTED_EXCLUSION','Exclude discovered containers/tests by unique ID. Select positive JUnit dynamic invocation IDs instead of excluding late-created invocations.');
  if(isCancelled(options.cancellation))return {state:'cancelled',tests:[],events:[],summary:{},output:'',coverage:undefined};
  const perTestCoverage=mode==='run'&&options.perTestCoverage===true,coverage=mode==='run'&&(options.coverage===true||perTestCoverage);if(coverage&&!config.classDirectories.length)throw new TestingError('COVERAGE_INPUT','Provide compiled main class directories for coverage.');
  const debug=options.debug;if(debug!==undefined&&(mode!=='run'||!debug||!Number.isInteger(debug.port)||debug.port<1024||debug.port>65535||typeof debug.onStarted!=='function'))throw new TestingError('INVALID_DEBUG','Managed test debugging requires a run, a local port and startup callback.');
  if(debug&&coverage)throw new TestingError('DEBUG_COVERAGE','Run debug and coverage profiles separately. Debugger evaluations can change coverage observations.');
  if(debug&&config.jvmArgs.some(arg=>/^-agentlib:jdwp|^-Xrunjdwp|^-agentpath:.*jdwp/i.test(arg)))throw new TestingError('INVALID_DEBUG','Remove the existing JDWP option; the test debugger manages its own local JVM agent.');
  const childEnv={...config.env};if(debug)for(const key of Object.keys(childEnv))if(/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key))delete childEnv[key];
  await fsp.mkdir(config.outputRoot,{recursive:true});const directory=await fsp.mkdtemp(path.join(config.outputRoot,'run-')),nonce=crypto.randomBytes(32).toString('hex');
  const eventsFile=path.join(directory,'events.jsonl'),configFile=path.join(directory,'launcher.properties'),execFile=path.join(directory,'jacoco.exec');
  await fsp.writeFile(path.join(directory,'owner.json'),JSON.stringify({kind:'RocketbrainJavaTestingRun-v1',version:'0.9.0',id:path.basename(directory),createdAt:new Date().toISOString()}),{mode:0o600});await fsp.writeFile(eventsFile,'',{flag:'wx',mode:0o600});
  const entries={nonce,events:pathToFileURL(eventsFile).href,mode,framework:config.framework,perTestCoverage:String(perTestCoverage),coverageFile:coverage?pathToFileURL(execFile).href:'',rootCount:config.testClassPaths.length,selectorCount:selectors.length,excludeCount:excluded.length};
  config.testClassPaths.forEach((root,index)=>entries['root.'+index]=pathToFileURL(root).href);selectors.forEach((selector,index)=>{entries['selector.'+index+'.kind']=selector.kind;entries['selector.'+index+'.value']=selector.value;});excluded.forEach((selector,index)=>entries['exclude.'+index]=selector.value);
  const parameters=config.configurationParameters||{};if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).length>100)throw new TestingError('INVALID_CONFIG','Invalid JUnit configuration parameters.');entries.parameterCount=Object.keys(parameters).length;Object.entries(parameters).forEach(([key,value],index)=>{if(typeof value!=='string'||key.length>512||value.length>8192)throw new TestingError('INVALID_CONFIG','Invalid JUnit configuration value.');entries['parameter.'+index+'.key']=key;entries['parameter.'+index+'.value']=value;});
  await fsp.writeFile(configFile,privateProperties(entries),{flag:'wx',mode:0o600});const cp=await classpathJar(config,directory,coverage);
  const before=coverage?{classes:await snapshotInputs(config.classDirectories,'.class'),sources:await snapshotInputs(config.sourceRoots,'.java',{maximumFiles:10000,maximumBytes:64*1024*1024})}:null;
  const located=sourceLocator(config.sourceRoots),tests=new Map(),events=[],errors=[],decoder=new StringDecoder('utf8'),abort=new AbortController();let lastSequence=0,offset=0,tail='',reading,protocolError,externalCancellation;
  if(options.cancellation?.onCancellationRequested)externalCancellation=options.cancellation.onCancellationRequested(()=>abort.abort());else if(options.cancellation?.addEventListener){const stop=()=>abort.abort();options.cancellation.addEventListener('abort',stop,{once:true});externalCancellation={dispose:()=>options.cancellation.removeEventListener('abort',stop)};}if(isCancelled(options.cancellation))abort.abort();
  async function readEvents(){
    if(reading)return reading;
    reading=(async()=>{const stat=await fsp.stat(eventsFile);if(stat.size>LIMITS.eventBytes)throw new TestingError('EVENT_LIMIT','Testing event file exceeds the size limit.');if(stat.size===offset)return;const handle=await fsp.open(eventsFile,'r');let bytes;try{const buffer=Buffer.alloc(stat.size-offset);const read=await handle.read(buffer,0,buffer.length,offset);offset+=read.bytesRead;bytes=buffer.subarray(0,read.bytesRead);}finally{await handle.close();}tail+=decoder.write(bytes);const lines=tail.split('\n');tail=lines.pop();for(const line of lines){if(!line.trim())continue;let event;try{event=JSON.parse(line);}catch{throw new TestingError('EVENT_PROTOCOL','Java testing event JSON is malformed.');}if(event.nonce!==nonce||event.sequence!==lastSequence+1||!['discovered','dynamic','started','finished','skipped','plan','complete','error','coverageError','coverageWindow','perTestCoverage','perTestCoverageError'].includes(event.type))throw new TestingError('EVENT_PROTOCOL','Java testing event provenance/order is invalid.');lastSequence=event.sequence;delete event.nonce;if(event.test){event.test=located(event.test);tests.set(event.test.id,event.test);}if(event.error?.frames)event=located(event);events.push(event);if(events.length>LIMITS.events)throw new TestingError('EVENT_LIMIT','Too many testing events.');if(event.type==='error')errors.push(event.error);try{options.onEvent?.(structuredClone(event));}catch{}}})();
    try{await reading;}finally{reading=null;}
  }
  const poll=setInterval(()=>{void readEvents().catch(error=>{protocolError=error;abort.abort();});},40);
  let execution;
  try{
    const args=[...config.jvmArgs,...(debug?['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:'+debug.port]:[]),...(coverage?['-javaagent:'+config.runtime.jacocoAgentJar+'=output=none,dumponexit=false,sessionid='+nonce]:[]),'-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8','-cp',cp,'rocketbrain.testing.Runner',pathToFileURL(configFile).href];
    execution=await execute(path.join(config.javaHome,'bin','java'+(process.platform==='win32'?'.exe':'')),args,{cwd:config.workspace,env:childEnv,timeoutMs:config.timeoutMs,onOutput:options.onOutput,cancellation:abort.signal,onStarted:debug?details=>debug.onStarted({...details,port:debug.port}):undefined});
    await readEvents();await readEvents();tail+=decoder.end();if(protocolError)throw protocolError;if(tail.trim())throw new TestingError('EVENT_PROTOCOL','Java testing event file ended mid-record.');
  }finally{clearInterval(poll);externalCancellation?.dispose();}
  const complete=events.findLast(event=>event.type==='complete'),state=execution.cancelled?'cancelled':execution.timedOut||!complete||errors.length||![0,1].includes(execution.code)?'errored':'completed';
  let intervals;if(perTestCoverage&&state!=='cancelled')try{intervals=await intervalCoverage(config,directory,cp,events,before,options);}catch(error){intervals={state:'unavailable',scope:'test-execution-interval',tests:[],warnings:[error.message],concurrencyObserved:false};}
  const result={state,mode,tests:[...tests.values()],events,summary:complete?.summary||{},output:execution.output,exitCode:execution.code,timedOut:execution.timedOut,cancelled:execution.cancelled,runDirectory:directory,eventsFile,errors,...(coverage?{coverage:state==='cancelled'?{state:'unavailable',scope:'run',perTestCoverage:false,files:[],warnings:['Run was cancelled; complete coverage was not established.']}:await generateCoverage(config,directory,before,options.onOutput,options.cancellation)}:{})};
  if(perTestCoverage){result.perTestCoverage=intervals||{state:'unavailable',scope:'test-execution-interval',tests:[],warnings:['Run was cancelled.'],concurrencyObserved:false};if(result.coverage)result.coverage.perTestCoverage=['available','partial'].includes(result.perTestCoverage.state);}
  await fsp.writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
}
const discoverTests=(config,options)=>perform('discover',config,options),runTests=(config,options)=>perform('run',config,options);
module.exports={provisionTestingRuntime,discoverTests,runTests,normalizeConfig,normalizeSelectors,resolveRuntime,manifestText,TestingError,LIMITS};
