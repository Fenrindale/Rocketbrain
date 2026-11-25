'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL,fileURLToPath}=require('node:url');
const {registerJavaTesting}=require('../src/java/testing-vscode');
function host(backend,{workspaceState}={}){
  const workspace=path.resolve('test/fixtures/spring-boot-app'),runs=[],handlers=new Map(),profiles=new Map(),events={};
  class Event{listeners=new Set();event=callback=>{this.listeners.add(callback);return{dispose:()=>this.listeners.delete(callback)};};fire(value){for(const fn of this.listeners)fn(value);}}
  class Collection extends Map{add(item){this.set(item.id,item);}replace(items){this.clear();for(const item of items)this.add(item);}forEach(callback){for(const item of this.values())callback(item);}}
  const uri=value=>({scheme:'file',fsPath:value,toString:()=>pathToFileURL(value).href});
  const controller={items:new Collection(),createTestItem:(id,label,value)=>({id,label,uri:value,children:new Collection()}),createRunProfile:(name,kind,handler)=>{handlers.set(kind,handler);const profile={dispose(){}};profiles.set(name,profile);return profile;},createTestRun:()=>{const data={events:[],coverage:[],output:[],ended:false,enqueued:item=>data.events.push(['queued',item.id]),started:item=>data.events.push(['started',item.id]),passed:item=>data.events.push(['passed',item.id]),failed:(item,message)=>data.events.push(['failed',item.id,message]),errored:(item,message)=>data.events.push(['error',item.id,message]),skipped:item=>data.events.push(['skipped',item.id]),appendOutput:text=>data.output.push(text),addCoverage:value=>data.coverage.push(value),end:()=>{data.ended=true;}};runs.push(data);return data;},dispose(){}};
  const vscode={tests:{createTestController:()=>controller},TestRunProfileKind:{Run:1,Coverage:3},TestRunRequest:class{constructor(include,exclude){this.include=include;this.exclude=exclude;}},CancellationTokenSource:class{constructor(){const event=new Event();this.token={isCancellationRequested:false,onCancellationRequested:event.event};this.cancel=()=>{this.token.isCancellationRequested=true;event.fire();};}dispose(){}},Uri:{file:uri,parse:value=>uri(fileURLToPath(value))},Range:class{constructor(...args){this.args=args;}},Position:class{constructor(line,character){this.line=line;this.character=character;}},Location:class{constructor(value,range){this.uri=value;this.range=range;}},TestMessage:class{constructor(message){this.message=message;}static diff(message,expected,actual){return {message,expected,actual};}},FileCoverage:class{constructor(value,lines,branches,methods,includesTests){Object.assign(this,{uri:value,lines,branches,methods,includesTests});}},StatementCoverage:class{constructor(executed,location,branches=[]){Object.assign(this,{executed,location,branches});}},BranchCoverage:class{constructor(executed,location,label){Object.assign(this,{executed,location,label});}},DeclarationCoverage:class{constructor(name,executed,location){Object.assign(this,{name,executed,location});}},window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),showErrorMessage:async()=>{}},commands:{registerCommand:()=>({dispose(){}})},workspace:{isTrusted:true,workspaceFolders:[{uri:uri(workspace)}],textDocuments:[],getWorkspaceFolder:()=>({uri:uri(workspace)}),getConfiguration:()=>({get:(key,fallback)=>fallback})}};
  for(const name of ['onDidChangeTextDocument','onDidCreateFiles','onDidDeleteFiles','onDidRenameFiles','onDidChangeWorkspaceFolders','onDidChangeConfiguration']){events[name]=new Event();vscode.workspace[name]=events[name].event;}
  events.disk=new Event();vscode.workspace.createFileSystemWatcher=()=>({onDidChange:events.disk.event,onDidCreate:()=>({dispose(){}}),onDidDelete:()=>({dispose(){}}),dispose(){}});
  const project={id:'fixture',workspace,classPath:[process.execPath],javaHome:workspace,testClassPaths:[workspace],sourceRoots:[workspace],classDirectories:[workspace],runtimePath:'unused'};
  if(workspaceState){
    const configuration=vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration=section=>section==='rocketbrain.java.testing'?
      {get:(key,fallback)=>key==='saveHistory'?true:configuration().get(key,fallback)}:configuration(section);
  }
  const api=registerJavaTesting({globalStorageUri:uri(workspace),workspaceState},vscode,{backend,java:{}});
  return {api,project,vscode,runs,events,controller,handlers,profiles,uri};
}
const testData=[{id:'engine',label:'JUnit',kind:'container'},{id:'template',parentId:'engine',label:'parameterized',kind:'container'},{id:'simple',parentId:'engine',label:'simple',kind:'test'}];
test('native Java test integration is offline until discovery and preserves template selections',async()=>{
  let discoveries=0,selection;
  const h=host({discoverTests:async()=>{discoveries++;return{state:'completed',tests:testData};},runTests:async(config,options)=>{selection=options.selectors;return{state:'completed',summary:{succeeded:2}};}});
  try{assert.equal(discoveries,0);await h.api.discover({projects:[h.project],build:false});const template=h.api.snapshot().tests.find(t=>t.id==='template');await h.api.run({includeIds:[template.nativeId],build:false});assert.deepEqual(selection,[{kind:'uniqueId',value:'template'}]);assert.equal(h.runs[0].ended,true);}finally{await h.api.dispose();}
});
test('native test failures retain expected/actual and rerun only failed unique IDs',async()=>{
  let lastSelection,fail=true;
  const h=host({discoverTests:async()=>({state:'completed',tests:testData}),runTests:async(config,options)=>{lastSelection=options.selectors;options.onEvent({type:'finished',state:fail?'failed':'passed',test:testData[2],error:fail?{message:'difference',expected:'expected',actual:'actual'}:undefined});return{state:'completed',summary:{failed:fail?1:0}};}});
  try{await h.api.discover({projects:[h.project],build:false});await h.api.run({build:false});assert.equal(h.runs[0].events.find(e=>e[0]==='failed')[2].expected,'expected');fail=false;await h.api.rerunFailed({build:false});assert.deepEqual(lastSelection,[{kind:'uniqueId',value:'simple'}]);assert.equal((await h.api.rerunFailed()).state,'no-failures');}finally{await h.api.dispose();}
});
test('saved failed TestNG child reruns from a new controller even when discovery only exposes its method',async()=>{
  const state=new Map(),workspaceState={
    get:(key,fallback)=>state.has(key)?structuredClone(state.get(key)):fallback,
    async update(key,value){state.set(key,structuredClone(value));}
  };
  const method={id:'method-7',className:'fixture.Cases',methodName:'amount',methodParameterTypes:'int',label:'amount',kind:'container'};
  const invocation={...method,id:'method-7/[invocation:safe:0]',parentId:method.id,kind:'test',rerunnable:true};
  let fail=true,renamed=false,calls=0,lastSelection;
  const backend={
    async discoverTests(){return {state:'completed',tests:[renamed?{...method,methodName:'another'}:method]};},
    async runTests(_config,options){
      calls++;lastSelection=options.selectors;
      options.onEvent({type:'finished',state:fail?'failed':'passed',test:invocation,
        error:fail?{message:'review',expected:'seven',actual:'nine',comparisonKind:'opentest4j'}:undefined});
      return {state:'completed',summary:{testsFound:1,testsFailed:fail?1:0,testsSucceeded:fail?0:1}};
    }
  };
  const first=host(backend,{workspaceState});
  let id;
  try {
    await first.api.discover({projects:[{...first.project,framework:'testng'}],build:false});
    id=(await first.api.run({build:false})).historyId;
    assert.ok(id);
  }finally{await first.api.dispose();}
  const second=host(backend,{workspaceState});
  try {
    fail=false;
    const projects=[{...second.project,framework:'testng'}];
    const state=second.api.history.list().find(run=>run.id===id);
    assert.equal(state.failures[0].comparison.expected,'seven');
    const tree=await second.api.discover({projects,build:false});
    assert.ok(!tree.tests.some(item=>item.id===invocation.id));
    await second.api.history.replay(id,0,{build:false});
    assert.deepEqual(lastSelection,[{kind:'uniqueId',value:invocation.id}]);
    assert.ok(second.runs[0].events.some(event=>event[0]==='passed'));
    renamed=true;
    await second.api.discover({projects,build:false});
    await assert.rejects(second.api.history.replay(id,0,{build:false}),/no longer matches/);
    assert.equal(calls,2);
  }finally{await second.api.dispose();}
});
test('native TestNG keeps the retry pending until one terminal outcome and reruns that invocation',async()=>{
  let failing=true,selected;
  const data=testData[2];
  const h=host({discoverTests:async()=>({state:'completed',tests:testData}),runTests:async(config,options)=>{
    selected=options.selectors;
    options.onEvent({type:'started',test:data,attempt:1});
    options.onEvent({type:'retry',test:data,attempt:1});
    options.onEvent({type:'started',test:data,attempt:2});
    options.onEvent({type:'finished',test:data,attempt:2,state:failing?'failed':'passed'});
    return {state:'completed',summary:{testsFound:1,testAttempts:2,retriesScheduled:1}};
  }});
  try{
    await h.api.discover({projects:[{...h.project,framework:'testng'}],build:false});
    await h.api.run({build:false});
    assert.deepEqual(h.runs[0].events.map(event=>event[0]),['queued','started','failed']);
    assert.match(h.runs[0].output.join(''),/after attempt 1/);
    failing=false;
    await h.api.rerunFailed({build:false});
    assert.deepEqual(selected,[{kind:'uniqueId',value:'simple'}]);
    assert.deepEqual(h.runs[1].events.map(event=>event[0]),['queued','started','passed']);
  }finally{await h.api.dispose();}
});
test('native coverage uses run aggregates and line/declaration details, suppressing changed-source mapping',async()=>{
  let mutate=false,h;
  const backend={discoverTests:async()=>({state:'completed',tests:testData}),runTests:async()=>{if(mutate)h.events.onDidChangeTextDocument.fire({document:{languageId:'java'}});return {state:'completed',summary:{succeeded:1},coverage:{state:'available',perTestCoverage:false,files:[{uri:pathToFileURL(path.join(h.project.workspace,'src/main/java/fixture/boot/RiskPolicy.java')).href,lines:{covered:2,total:4},branches:{covered:1,total:2},methods:{covered:1,total:2},details:[{line:3,covered:true},{line:4,covered:false}],methodDetails:[{name:'category',line:3,covered:true}]}]}};}};
  h=host(backend);try{await h.api.discover({projects:[h.project],build:false});await h.api.run({coverage:true,build:false});assert.equal(h.runs[0].coverage[0].branches.covered,1);assert.equal(h.api.snapshot().lastReport.perTestCoverage,false);mutate=true;await h.api.run({coverage:true,build:false});assert.equal(h.runs[1].coverage.length,0);assert.equal(h.api.snapshot().lastReport.sourceChanged,true);}finally{await h.api.dispose();}
});
test('native discovery rejects trust loss and dirty Java sources without publishing stale test items',async()=>{
  let release,started;const gate=new Promise(resolve=>{started=resolve;});
  const h=host({discoverTests:async()=>{started();return new Promise(resolve=>{release=()=>resolve({state:'completed',tests:testData});});}});
  try{const work=h.api.discover({projects:[h.project],build:false});await gate;h.vscode.workspace.isTrusted=false;release();await assert.rejects(()=>work,/Trust/);assert.equal(h.api.snapshot().tests.length,0);h.vscode.workspace.isTrusted=true;h.vscode.workspace.textDocuments=[{languageId:'java',isDirty:true,uri:h.uri(path.join(h.project.workspace,'Dirty.java'))}];await assert.rejects(()=>h.api.discover({projects:[h.project],build:false}),/Save/);}finally{await h.api.dispose();}
});
test('failed rediscovery retains the previous tree as stale rather than publishing an empty successful result',async()=>{
  let broken=false;const h=host({discoverTests:async()=>broken?{state:'errored',errors:[{message:'engine missing'}]}:{state:'completed',tests:testData}});
  try{await h.api.discover({projects:[h.project],build:false});broken=true;await assert.rejects(()=>h.api.discover({projects:[h.project],build:false}),/engine missing/);assert.equal(h.api.snapshot().tests.length,3);assert.equal(h.api.snapshot().state,'stale');}finally{await h.api.dispose();}
});
test('a rejected concurrent request cannot stop disposal from waiting for the running JVM operation',async()=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const h=host({discoverTests:async()=>({state:'completed',tests:testData}),runTests:async()=>{entered();return new Promise(resolve=>{release=()=>resolve({state:'cancelled',summary:{}});});}});
  try{await h.api.discover({projects:[h.project],build:false});const work=h.api.run({build:false});void work.catch(()=>{});await ready;await assert.rejects(()=>h.api.discover({projects:[h.project],build:false}),/Wait/);let stopped=false;const closing=h.api.dispose().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);release();await closing;await assert.rejects(()=>work,/closed/);}finally{await h.api.dispose();}
});
test('discovery rechecks trust before loading the next project test engine',async()=>{
  let count=0,h;h=host({discoverTests:async()=>{count++;h.vscode.workspace.isTrusted=false;return {state:'completed',tests:testData};}});
  try{await assert.rejects(()=>h.api.discover({projects:[h.project,{...h.project,id:'second'}],build:false}),/Trust/);assert.equal(count,1);assert.equal(h.api.snapshot().tests.length,0);}finally{await h.api.dispose();}
});

test('serial per-test profile publishes only measured test intervals and preserves aggregate coverage',async()=>{
  let h,received;const uri=pathToFileURL(path.resolve('test/fixtures/spring-boot-app/src/main/java/fixture/boot/RiskPolicy.java')).href;
  const file={uri,lines:{covered:2,total:3},branches:{covered:1,total:2},methods:{covered:1,total:1},details:[{line:3,covered:true},{line:4,covered:true},{line:5,covered:false}]};
  h=host({discoverTests:async()=>({state:'completed',tests:testData}),runTests:async(config,options)=>{received=options;return {state:'completed',coverage:{state:'available',files:[file]},perTestCoverage:{state:'available',scope:'test-execution-interval',tests:[{testId:'simple',coverage:{state:'available',files:[{...file,lines:{covered:1,total:3},details:[{line:3,covered:true},{line:4,covered:false},{line:5,covered:false}]}]}}]}};}});
  try{
    await h.api.discover({projects:[{...h.project,framework:'testng'}],build:false});
    assert.equal(h.api.snapshot().projects[0].framework,'testng');await h.api.run({perTestCoverage:true,build:false});
    assert.equal(received.perTestCoverage,true);assert.equal(received.coverage,true);const coverage=h.runs[0].coverage[0];
    assert.equal(coverage.includesTests.length,1);assert.equal(coverage.lines.covered,2);
    const profile=h.profiles.get('Coverage by Test (Serial)'),all=await profile.loadDetailedCoverage(null,coverage),single=await profile.loadDetailedCoverageForTest(null,coverage,coverage.includesTests[0]);
    assert.equal(all.filter(s=>s.executed).length,2);assert.equal(single.filter(s=>s.executed).length,1);assert.equal(h.api.snapshot().lastReport.perTestCoverage,true);
  }finally{await h.api.dispose();}
});
test('test debugging cannot silently run a coverage profile',async()=>{
  let calls=0;const h=host({discoverTests:async()=>({state:'completed',tests:testData}),runTests:async()=>{calls++;return{state:'completed'};}});
  try{await assert.rejects(h.api.run({debug:true,perTestCoverage:true}),/separate/);assert.equal(calls,0);}finally{await h.api.dispose();}
});


test('external changes to closed project Java sources invalidate the compiled test tree',async()=>{
 let discoveries=0;const h=host({discoverTests:async()=>{discoveries++;return {state:'completed',tests:testData};},runTests:async()=>({state:'completed',summary:{}})});
 try{await h.api.discover({projects:[h.project],build:false});assert.equal(h.api.snapshot().state,'ready');h.events.disk.fire(h.uri(path.join(h.project.workspace,'src/test/java/fixture/boot/RocketbrainTestNGTest.java')));assert.equal(h.api.snapshot().state,'stale');await h.api.run({projects:[h.project],build:false});assert.equal(discoveries,2);assert.equal(h.api.snapshot().state,'ready');}finally{await h.api.dispose();}
});


test('native coverage details emit exact then and else ranges and discard stale branch locations',async()=>{
  const fs=require('node:fs'),crypto=require('node:crypto');
  const source=path.resolve('test/fixtures/spring-boot-app/src/main/java/fixture/boot/RiskPolicy.java'),uri=pathToFileURL(source).href;
  const range=(line,start,end)=>({start:{line,character:start},end:{line,character:end}});
  const condition=range(3,8,25),then=range(4,8,22),otherwise=range(5,8,24);
  const file={uri,lines:{covered:1,total:1},branches:{covered:1,total:2},methods:{covered:1,total:1},
    branchSourceSha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    details:[{line:3,covered:true,branchSource:{condition,arms:[
      {label:'then',covered:true,range:then},{label:'else',covered:false,range:otherwise}
    ]}}]};
  const h=host({discoverTests:async()=>({state:'completed',tests:testData}),runTests:async()=>({state:'completed',
    coverage:{state:'available',files:[file]},perTestCoverage:{state:'available',tests:[{testId:'simple',coverage:{state:'available',files:[file]}}]}})});
  try{
    await h.api.discover({projects:[h.project],build:false});
    await h.api.run({perTestCoverage:true,build:false});
    const coverage=h.runs[0].coverage[0],profile=h.profiles.get('Coverage by Test (Serial)');
    const aggregate=await profile.loadDetailedCoverage(null,coverage);
    const individual=await profile.loadDetailedCoverageForTest(null,coverage,coverage.includesTests[0]);
    assert.deepEqual(aggregate,individual);
    assert.deepEqual(aggregate[0].location.args.map(position=>({...position})),[condition.start,condition.end]);
    assert.deepEqual(aggregate[0].branches.map(branch=>[branch.label,branch.executed]),[['then',true],['else',false]]);
    assert.deepEqual(aggregate[0].branches[1].location.args.map(position=>({...position})),[otherwise.start,otherwise.end]);
    h.vscode.workspace.textDocuments.push({uri:h.uri(source),isDirty:true});
    const stale=await profile.loadDetailedCoverage(null,coverage);
    assert.equal(stale[0].branches.length,0);
    assert.equal(stale[0].location.character,0);
  }finally{await h.api.dispose();}
});
