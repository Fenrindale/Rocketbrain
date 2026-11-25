'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {registerJavaWorkbench}=require('../src/java/workbench');
const Spring=require('../src/java/spring-launch');
const {chooseSpringLaunch}=require('../src/java/spring-launch-vscode');
const F=require('./java-workbench-fixture');
const storageKey='rocketbrain.java.workbench.configurations.v18';

const property={key:'fixture.cache-timeout',source:'environment',value:'private fixture value'};
const settings={profiles:['local-db','staging'],profileSource:'jvm',properties:[
  property,{key:'fixture.extra',source:'arguments',value:'literal = ${env:UNUSED}'}
]};

test('Spring launch values are injected in the selected source only after managed debug resolution',()=>{
  const options=Spring.springLaunchOptions(settings);
  const summary=Spring.describeSpringLaunch(options);
  assert.deepEqual(summary.properties,[{key:'fixture.cache-timeout',source:'environment'},{key:'fixture.extra',source:'arguments'}]);
  const launch={[Spring.marker]:'fixture-marker',[Spring.springMarker]:true,args:['generic'],vmArgs:['-XX:-UsePerfData'],env:{HOME_TEST:'generic'}};
  try{
    Spring.retainSpringLaunch('fixture-marker',Spring.restoreSpringLaunch(summary,options.properties.map(value=>value.value)));
    assert.doesNotMatch(JSON.stringify(launch),/private fixture|literal =/);
    Spring.applyManagedSpringLaunch(launch);
    assert.deepEqual(launch.args,['generic','--fixture.extra=literal = ${env:UNUSED}']);
    assert.deepEqual(launch.vmArgs,['-XX:-UsePerfData','-Dspring.profiles.active=local-db,staging']);
    assert.deepEqual(launch.env,{HOME_TEST:'generic',FIXTURE_CACHETIMEOUT:'private fixture value'});
  }finally{Spring.discardSpringLaunch('fixture-marker');}
  assert.throws(()=>Spring.applyManagedSpringLaunch(launch),/cancelled or replaced/);
  const standard={[Spring.marker]:'legacy',args:[]};
  Spring.applyManagedSpringLaunch(standard);
  assert.deepEqual(standard,{[Spring.marker]:'legacy',args:[]});
});

test('Spring protection rejects ambiguous source duplicates, invalid forms and projected limits',()=>{
  const options=Spring.springLaunchOptions(settings);
  for(const base of [{args:['--fixture.cacheTimeout=2']},{vmArgs:['-Dfixture.extra=earlier']},{env:{SPRING_PROFILES_ACTIVE:'generic'}},
    {env:{FIXTURE_CACHE_TIMEOUT:'different spelling'}}])
    assert.throws(()=>Spring.projectSpringLaunch(base,options),/existing launch option/);
  for(const change of [{profiles:['bad profile']},{profiles:['dev','dev']},{profileSource:''},{properties:[property,{...property,key:'fixture.cachetimeout'}]},
    {properties:[{...property,key:'spring.profiles.active'}]},{properties:[{...property,source:'shell'}]},{properties:[{...property,value:'bad\nline'}]}])
    assert.throws(()=>Spring.springLaunchOptions({...settings,...change}),/profile|source|duplicate|single-line|literal/i);
  assert.throws(()=>Spring.projectSpringLaunch({args:Array(64).fill('x')},options),/64 arguments/);
  assert.throws(()=>Spring.restoreSpringLaunch(Spring.describeSpringLaunch(options),[]),/values are unavailable/);
});

test('managed stored settings preserve earlier secret versions on failure and clean secrets on deletion',async t=>{
  const fixture=F.fixture(t),harness=F.fakeVscode(fixture);
  const api=registerJavaWorkbench(harness.context,harness.vscode,harness.java,harness.output,{runner:harness.runner});
  t.after(()=>api.dispose());
  const entry={projectUri:fixture.uri,name:'Owned Spring config',mainClass:'demo.Main',springBoot:settings,env:{DB_PASSWORD:'owned DB password'}};
  const initial=await api.saveRunConfiguration(entry);
  assert.equal(initial.springBoot.profileSource,'jvm');
  assert.doesNotMatch(JSON.stringify([harness.state.get(storageKey),initial,api.getSnapshot(),api.getTreeChildren()]),/owned DB password|private fixture value/);
  const oldSecrets=new Map(harness.secrets);
  const update=harness.context.workspaceState.update;
  harness.context.workspaceState.update=async()=>{throw Error('simulated storage failure');};
  await assert.rejects(api.saveRunConfiguration({...entry,configurationId:initial.id,env:{DB_PASSWORD:'changed'},
    springBoot:{...settings,profileSource:'arguments'}}),/storage failure/);
  assert.deepEqual(harness.secrets,oldSecrets);
  assert.deepEqual(api.listRunConfigurations(),[initial]);
  harness.context.workspaceState.update=update;
  const run=await api.start({configurationId:initial.id,debug:true});
  const raw=harness.starts[0].configuration;
  assert.equal(raw[Spring.springMarker],true);
  assert.deepEqual(raw.args,[]);
  assert.equal(raw.env.DB_PASSWORD,'owned DB password');
  assert.doesNotMatch(JSON.stringify(raw),/private fixture value/);
  await api.stop({runId:run.runId});
  const changed=await api.saveRunConfiguration({...entry,configurationId:initial.id,springBoot:null});
  assert.equal(changed.springBoot,undefined);
  assert.equal(harness.secrets.size,1);
  await api.deleteRunConfiguration(initial.id);
  assert.equal(harness.secrets.size,0);
});

test('legacy environment records and separate Spring configuration edits remain readable',async t=>{
  const fixture=F.fixture(t),harness=F.fakeVscode(fixture);
  const api=registerJavaWorkbench(harness.context,harness.vscode,harness.java,harness.output,{runner:harness.runner});
  t.after(()=>api.dispose());
  const stored={format:'RocketbrainJavaRunConfiguration',formatVersion:1,id:'legacy-id',name:'Legacy',projectUri:fixture.uri,
    mainClass:'demo.Main',projectName:'fixture',javaHome:fixture.javaHome,args:['old parameter'],vmArgs:[],prelaunch:null,environmentKeys:['LEGACY']};
  await harness.context.workspaceState.update(storageKey,[stored]);
  harness.secrets.set('rocketbrain.java.workbench.environment.legacy-id',JSON.stringify({LEGACY:'kept'}));
  const edited=await api.saveRunConfiguration({configurationId:stored.id,projectUri:fixture.uri,name:stored.name,mainClass:stored.mainClass,
    args:stored.args,springBoot:settings});
  const run=await api.start({configurationId:edited.id});
  assert.deepEqual(harness.starts[0].configuration.env,{LEGACY:'kept'});
  assert.deepEqual(harness.starts[0].configuration.args,['old parameter']);
  await api.stop({runId:run.runId});
  const edit=await api.saveRunConfiguration({configurationId:edited.id,projectUri:fixture.uri,name:'Renamed',mainClass:stored.mainClass,args:stored.args});
  assert.deepEqual(edit.springBoot,edited.springBoot);
  await api.deleteRunConfiguration(edited.id);
  assert.equal(harness.secrets.size,0);
});

test('Spring wizard reviews profile and property sources with masked value entry',async()=>{
  const values=['local-db','fixture.test','private secret value',''],picks=['jvm','arguments'];
  let reviewed, masked;
  const selected=await chooseSpringLaunch({
    async showInputBox(options){if(options.title.startsWith('Value'))masked=options.password;return values.shift();},
    async showQuickPick(items){const selected=picks.shift();return items.find(item=>item.id===selected);},
    async showInformationMessage(_label,options){reviewed=options.detail;return 'Save settings';}
  },()=>{});
  assert.equal(masked,true);
  assert.match(reviewed,/local-db[\s\S]*JVM system property[\s\S]*fixture\.test[\s\S]*application argument/);
  assert.doesNotMatch(reviewed,/private secret/);
  assert.equal(selected.properties[0].value,'private secret value');
});
