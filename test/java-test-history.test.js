'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const backend=require('../src/java/testing');
const {execute,provisionTestingRuntime,readLauncherSources}=require('../src/java/testing/provision');
const {createTestHistory,describeFailure,historicalSelection}=require('../src/java/testing-history');
const {historyTestSources}=require('./helpers/java-test-history-fixture');

const runtimeConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

function localState(file) {
  let value;
  return {
    async load(){value=JSON.parse(await fs.readFile(file,'utf8'));return this;},
    get(_key,fallback){return value??fallback;},
    async update(_key,stored){value=stored;await fs.writeFile(file,JSON.stringify(value??[]),'utf8');}
  };
}

test('history keeps summaries when individual comparison text fills the workspace storage budget',async()=>{
  let value;
  const history=createTestHistory({get:(_key,fallback)=>value??fallback,async update(_key,stored){value=stored;}});
  const project={id:'large',workspace:path.resolve('fixture'),framework:'junit'};
  const failure=describeFailure(project,{id:'id',kind:'test',label:'large'},{
    expected:'\u0000'.repeat(8192),actual:'\u0001'.repeat(8192)
  },'Diff with control characters');
  const id=await history.append({projects:[{project,summary:{testsFailed:60}}],failures:Array(60).fill(failure),
    failureCount:60,mode:'run',sourceChanged:false});
  const saved=history.get(id);
  assert.equal(saved.projects[0].failed,60);
  assert.ok(saved.failures.length>0&&saved.omittedFailures>0);
  assert.equal(saved.failures.length+saved.omittedFailures,60);
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=2*1024*1024);
});

test('real Jupiter, Vintage and TestNG failure values survive persisted history and replay only exact saved IDs',{
  skip:!runtimeConfig,timeout:220000
},async()=>{
  const {javaHome}=JSON.parse(await fs.readFile(runtimeConfig,'utf8'));
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-test-history-'));
  try {
    const cache=process.env.ROCKETBRAIN_TESTNG_API_CACHE;
    const runtime=await provisionTestingRuntime({target:path.join(root,'runtime'),javaHome,cacheDirectory:cache,sources:readLauncherSources()});
    const sourceRoot=path.join(root,'src'),packagePath=path.join(sourceRoot,'sample'),classes=path.join(root,'classes');
    await fs.mkdir(packagePath,{recursive:true});await fs.mkdir(classes);
    const fileMap=historyTestSources('sample',{junit:'JupiterHistory',vintage:'VintageHistory',testng:'TestNgHistory'}),files=[];
    for(const [name,source] of Object.entries(fileMap)){
      const file=path.join(packagePath,name);await fs.writeFile(file,source,{flag:'wx'});files.push(file);
    }
    const javac=path.join(javaHome,'bin','javac'+(process.platform==='win32'?'.exe':''));
    const built=await execute(javac,['-g','-proc:none','-cp',[runtime.testngJar,runtime.junitJar].join(path.delimiter),'-d',classes,...files]);
    assert.equal(built.code,0,built.output);
    const project=framework=>({id:'sample:'+framework,label:framework,workspace:root,framework,javaHome,runtime,
      classPath:[classes,runtime.testngJar,runtime.junitJar],testClassPaths:[classes],sourceRoots:[sourceRoot],
      classDirectories:[classes],outputRoot:path.join(root,'runs'),timeoutMs:45000});
    const projects=['junit','testng'].map(project),recorded=[],failures=[];
    for(const current of projects) {
      const result=await backend.runTests({...current,jvmArgs:['-Drb.history.fail=true']});
      assert.equal(result.state,'completed',JSON.stringify(result.errors));
      recorded.push({project:current,summary:result.summary});
      for(const event of result.events.filter(event=>event.type==='finished'&&event.state==='failed'&&event.test?.kind==='test')){
        failures.push(describeFailure(current,event.test,event.error,event.error.message));
      }
    }
    const comparison=kind=>failures.find(failure=>failure.comparison?.kind===kind&&failure.framework==='junit')?.comparison;
    assert.deepEqual(comparison('opentest4j'),{kind:'opentest4j',expected:'before\nexpected amount',actual:'before\nactual amount',
      expectedType:'java.lang.String',actualType:'java.lang.String'});
    assert.deepEqual(comparison('junit4'),{kind:'junit4',expected:'test\nlegacy expected',actual:'test\nlegacy actual',
      expectedType:'java.lang.String',actualType:'java.lang.String'});
    const typed=failures.find(failure=>failure.framework==='testng'&&failure.comparison?.kind==='opentest4j');
    assert.deepEqual(typed?.comparison,{kind:'opentest4j',expected:'44',actual:'52',expectedType:'java.lang.Integer',actualType:'java.lang.Long'});
    const stock=failures.find(failure=>failure.comparison?.kind==='testng-text');
    assert.deepEqual(stock?.comparison,{kind:'testng-text',expected:'expected inventory',actual:'actual inventory',expectedType:'',actualType:''});
    const ambiguous=failures.find(failure=>failure.label.startsWith('ambiguous'));
    assert.ok(ambiguous&&ambiguous.comparison===null);
    assert.ok(typed?.rerun&&comparison('junit4'));
    const file=path.join(root,'workspace-state.json'),first=createTestHistory(localState(file));
    const historyId=await first.append({projects:recorded,failures,failureCount:failures.length,mode:'run',sourceChanged:false});
    const second=createTestHistory(await localState(file).load()),saved=second.get(historyId);
    assert.deepEqual(saved.failures,failures);
    assert.ok(!JSON.stringify(saved).includes('rb.history.fail'));
    const discovered=new Map();
    for(const current of projects){
      const result=await backend.discoverTests(current);
      assert.equal(result.state,'completed',JSON.stringify(result.errors));
      discovered.set(current.id,new Map(result.tests.map(data=>[data.id,{data,item:{id:data.id}}])));
    }
    const lookup=(project,id)=>discovered.get(project.id)?.get(id);
    assert.ok(!lookup(projects[1],typed.selector),'TestNG exact child only appears at runtime');
    const chosen=saved.failures.filter(failure=>failure.comparison?.kind==='junit4'||
      failure.framework==='testng'&&failure.comparison?.kind==='opentest4j');
    const selection=historicalSelection(chosen,projects,lookup);
    let exactRuns=0;
    for(const [current,{selectors}] of selection) {
      assert.equal(selectors.length,1);
      const rerun=await backend.runTests(current,{selectors});
      assert.equal(rerun.state,'completed',JSON.stringify(rerun.errors));
      assert.equal(rerun.summary.testsSucceeded,1);
      assert.equal(rerun.summary.testsFound,1);
      assert.equal(rerun.summary.testsFailed,0);
      assert.ok(rerun.events.some(event=>event.type==='finished'&&event.test?.id===selectors[0].value));
      exactRuns++;
    }
    assert.throws(()=>historicalSelection([typed],[{...projects[1],sourceRoots:[path.join(root,'changed')]}],lookup),/no longer identifies/);
    assert.throws(()=>historicalSelection([typed],projects,()=>undefined),/no longer matches/);
    const receipt=process.env.ROCKETBRAIN_JAVA_HISTORY_RECEIPT;
    if(receipt)await fs.writeFile(receipt,JSON.stringify({junit:runtime.junitVersion,testng:runtime.testngVersion,
      savedFailures:saved.failures.length,structuredTestNG:true,supportedNativeTestNgText:true,ambiguousTextRefused:true,
      legacyComparison:true,reopenedWorkspaceState:true,exactRuns,deletedDescriptorRefused:true,projectDriftRefused:true},null,2)+'\n');
  }finally{
    const physical=await fs.realpath(root);
    assert.equal(path.dirname(physical),parent);assert.match(path.basename(physical),/^rb-test-history-/);
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});
