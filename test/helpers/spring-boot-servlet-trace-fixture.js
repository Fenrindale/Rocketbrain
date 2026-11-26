'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execute}=require('../../src/java/testing/provision');
const {manifestText}=require('../../src/java/testing');
const {jdbcOptions}=require('./coroutine-watch-fixture');
const {readRegistrationTrace}=require('../../src/spring/registration-trace');

const source=path.resolve(__dirname,'../fixtures/java/spring-boot-servlet-registration-trace/src/main/java/registry/BootServletRegistryProbe.java');
const mainClass='registry.BootServletRegistryProbe';
const order=['earlyInit','lateInit','imported','priority','ordered'];
const expected=[
  ['register','earlyInit',undefined,'Init','initialize'],
  ['register','lateInit',undefined,'Init','initialize'],
  ['register','ownedLazy',undefined,'Imported','registerBeanDefinitions'],
  ['alias','ownedLazy','stableAlias','PriorityRegistry','postProcessBeanDefinitionRegistry'],
  ['register','transientDefinition',undefined,'OrderedRegistry','postProcessBeanDefinitionRegistry'],
  ['remove','transientDefinition',undefined,'OrderedRegistry','postProcessBeanDefinitionRegistry'],
  ['alias','ownedLazy','lateAlias',undefined,undefined],
  ['unalias','lateAlias',undefined,undefined,undefined],
  ['register','lateDefinition',undefined,undefined,undefined],
  ['remove','lateDefinition',undefined,undefined,undefined]
];

function javaTool(home,key) {
  return path.join(home,'bin',key + (process.platform==='win32'?'.exe':''));
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(key)));
}

async function compile({javaHome,classpathFile,helperFiles,work}) {
  const cp=(await fs.readFile(classpathFile,'utf8')).trim().split(path.delimiter).filter(file=>file.endsWith('.jar'));
  assert.ok(cp.some(file=>path.basename(file)==='spring-boot-4.1.2.jar'));
  assert.ok(cp.some(file=>path.basename(file)==='spring-beans-7.0.10.jar'));
  assert.ok(cp.some(file=>path.basename(file)==='spring-boot-tomcat-4.1.2.jar'));
  const classes=path.join(work,'classes'), jar=path.join(work,'classpath.jar'), manifest=path.join(work,'classpath.mf');
  await fs.mkdir(classes);
  await fs.writeFile(manifest,manifestText([classes,...cp]),{flag:'wx'});
  const run=async(tool,args,env=cleanEnvironment())=>execute(javaTool(javaHome,tool),args,{cwd:work,timeoutMs:40000,env});
  const bundled=await run('jar',['--create','--file',jar,'--manifest',manifest]);
  assert.equal(bundled.code,0,bundled.output);
  const compiled=await run('javac',['-encoding','UTF-8','-g','-proc:none','-cp',jar,'-d',classes,...helperFiles,source]);
  assert.equal(compiled.code,0,compiled.output);
  return {run,jar};
}

async function exercise({javaHome,classpathFile,helperFiles,work,engine,configFile,readTrace=readRegistrationTrace}) {
  const owned=JSON.parse(await fs.readFile(path.join(path.dirname(configFile),'owner.json'),'utf8'));
  assert.equal(owned.kind,engine==='mysql'?'RocketbrainDisposableOracleMysqlFixture-v1':'RocketbrainDisposableMariaDbFixture-v1');
  const {run,jar}=await compile({javaHome,classpathFile,helperFiles,work});
  const {env}=await jdbcOptions({engine,classpathFile,configFile});
  const environment={...cleanEnvironment(),...env};
  const trace=path.join(work,'boot-registry.jsonl'), failure=path.join(work,'boot-failed.jsonl');
  async function launch(mode,file=trace,vm=[]) {
    const result=await run('java',[...vm,'-cp',jar,mainClass,mode,file],environment);
    assert.equal(result.code,0,result.output);
    return result.output;
  }
  const wanted=new RegExp('^BOOT_REGISTRY='+order.join(',')+'\\|([^|\\r\\n]+)\\|42\\|1\\|1$','mu');
  const ordinary=wanted.exec(await launch('plain'));
  assert.ok(ordinary);
  assert.match(ordinary[1],engine==='mysql'?/^8\.4\.13$/u:/^11\.4\.8.*MariaDB/u);
  const observed=wanted.exec(await launch('trace'));
  assert.equal(observed?.[0],ordinary[0]);

  const actual=await readTrace(trace);
  assert.equal(actual.version,2);
  assert.equal(actual.mode,'bean-factory');
  assert.equal(actual.truncated,false);
  assert.equal(actual.pendingLine,false);
  assert.equal(actual.scopes.length,1);
  assert.equal(actual.scopes[0].label,'servlet runtime');
  assert.equal(actual.scopes[0].outcome,'returned');
  const wantedNames=new Set(expected.map(([,name])=>name));
  const relevant=actual.mutations.filter(item=>wantedNames.has(item.name) &&
    (item.alias===undefined || ['stableAlias','lateAlias'].includes(item.alias)));
  assert.deepEqual(relevant.map(item=>[item.operation,item.name,item.alias,
    item.provider?.type.split('$').at(-1),item.provider?.method]),expected);
  const text=(await fs.readFile(source,'utf8')).split(/\r?\n/u);
  for (const [operation,name,marker] of [['register','ownedLazy','AUDITED_IMPORT_ORIGIN'],
    ['alias','ownedLazy','AUDITED_PRIORITY_ORIGIN'],['remove','lateDefinition','AUDITED_LATE_ORIGIN']]) {
    const selected=relevant.find(item=>item.operation===operation && item.name===name);
    assert.equal(selected.origin.file,path.basename(source));
    assert.equal(selected.origin.line,text.findIndex(line=>line.includes(marker))+1);
  }

  assert.match(await launch('fail-plain',failure),/^BOOT_REGISTRY_FAILURE=original$/mu);
  assert.match(await launch('fail-trace',failure),/^BOOT_REGISTRY_FAILURE=original$/mu);
  const failed=await readTrace(failure);
  assert.equal(failed.scopes[0].outcome,'threw');
  assert.ok(failed.mutations.some(item=>item.operation==='register' && item.name==='beforeFailure'));
  const aot=path.join(work,'aot-should-not-exist.jsonl');
  assert.match(await launch('aot',aot,['-Dspring.aot.enabled=true']),/^BOOT_REGISTRY_AOT=refused$/mu);
  const aotOutputs=await Promise.all(['source','resources','classes'].map(async name=>{
    const folder=path.join(work,'aot-'+name);
    await fs.mkdir(folder);
    return folder;
  }));
  const aotBuild=await run('java',['-cp',jar,'org.springframework.boot.SpringApplicationAotProcessor',
    mainClass,...aotOutputs,'fixture','boot-registry','aot',aot],environment);
  assert.notEqual(aotBuild.code,0);
  // The fixture catches the supported refusal; Boot then reports that the source chose no AOT context.
  assert.match(aotBuild.output,/^BOOT_REGISTRY_AOT=refused$/mu);
  await assert.rejects(fs.stat(aot),{code:'ENOENT'});
  return {engine,server:ordinary[1],jdbc:42,order,lateMutations:4,providerMutations:6,lazySupplierInvocations:1,
    contextCloses:1,originalFailure:true,generatedAotRefused:true,buildAotRefused:true,traceEvents:actual.mutations.length,
    selectedOrigins:relevant.map(({operation,name,origin,provider})=>({operation,name,origin,provider}))};
}

module.exports={exercise};
