'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {ObserverClient}=require('../src/jpa/observer-client');
const {sourceMember}=require('../src/spring/observed-injection');
const {withObservedInjectionFixture,verifyObservedConstructorInjection}=require('./spring-observed-injection-host');

const file='src/main/java/fixture/boot/ObservedInjectionProbe.java';
const prefix='rocketbrain.jpa.observer.';
const consumer='fixture.boot.MemberWireConsumer';
const ambiguous='fixture.boot.AmbiguousMemberWireConsumer';
const contextId='rocketbrain-runtime-wiring-child';
const left='runtimeWireLeft',right='runtimeWireRight';

async function verify(input,client){
  const constructor=await verifyObservedConstructorInjection(input,client);
  const {config,call,token}=input;
  assert.deepEqual(await call('members'),{
    field:'fixture-only-left-value',picked:'fixture-only-right-value',members:2,mapKeys:[left,right],
    optionalAbsent:true,wrappedAbsent:true,optionalMethodSkipped:true,arrayMembers:2,qualifiedSetMembers:1
  });
  assert.deepEqual(await call('ambiguous-member'),{candidates:2});
  const before=await call('counters');
  const snapshot=await client.refresh();
  const {processId,state,events,omitted,inspectionInvokedBeans,beanValuesRetained,observerExecutedSql}=await client.observedMemberInjection();
  assert.equal(state,'observed',JSON.stringify(snapshot.warnings));
  assert.equal(processId,snapshot.processId);
  assert.deepEqual([omitted,inspectionInvokedBeans,beanValuesRetained,observerExecutedSql],[0,false,false,false]);
  const owned=events.filter(event=>[consumer,ambiguous].includes(event.site.owner));
  assert.equal(owned.length,12,JSON.stringify(owned));
  const details=new Map(owned.map(event=>[event.site.parameterName||event.site.member,event]));
  const dependency='fixture.boot.ObservedDynamicValue', absent='fixture.boot.ObservedAbsentValue';
  const expected=[
    ['field','field','resolved',dependency,dependency,left],
    ['optional','field','missing',absent,absent],
    ['wrapped','field','missing','java.util.Optional',absent],
    ['vector','field','aggregated',dependency+'[]',dependency,[left,right]],
    ['filtered','field','aggregated','java.util.Set',dependency,[left]],
    ['first','method','resolved',dependency,dependency,left,0],
    ['group','method','aggregated','java.util.List',dependency,[left,right],1],
    ['named','method','aggregated','java.util.Map',dependency,[left,right],2],
    ['selected','method','resolved','java.util.Optional',dependency,right,3],
    ['available','method','resolved',dependency,dependency,left,0],
    ['missing','method','missing',absent,absent,undefined,1],
    ['competing','field','ambiguous',dependency,dependency]
  ];
  const source=await fs.readFile(path.join(config.projectPath,file),'utf8');
  for(const [name,kind,status,requested,element,selected,index] of expected){
    const event=details.get(name);
    assert.ok(event,name);
    assert.deepEqual([event.site.kind,event.state,event.site.requestedType,event.site.dependencyType,event.selectedBean??event.selectedBeans,
      event.site.parameterIndex],[kind,status,requested,element,selected,index],name);
    const target=sourceMember({text:source},event.site);
    assert.ok(target,'No exact saved declaration for '+name);
    assert.equal(source.slice(target.start,target.end),name);
  }
  const contexts=await client.persistenceContexts();
  const active=details.get('field').context.key, failed=details.get('competing').context.key;
  assert.notEqual(active,failed);
  assert.ok(owned.every(event=>event.context.id===contextId&&event.site.requestingBean==='memberConsumer'));
  assert.ok(owned.filter(event=>event.site.owner===consumer).every(event=>event.context.key===active));
  assert.equal(contexts.contexts.find(entry=>entry.key===active)?.parentState,'observed');
  assert.ok(!contexts.contexts.some(entry=>entry.key===failed));
  for(const event of constructor.events)assert.ok(![active,failed].includes(event.context.key));
  const endpoint=config.observerUrl+'/spring-observed-member-injection', headers={Authorization:'Bearer '+token};
  assert.equal((await fetch(endpoint)).status,401);
  assert.equal((await fetch(endpoint,{method:'POST',headers})).status,405);
  assert.equal((await fetch(endpoint+'?replay=1',{headers})).status,400);
  const latest=await client.observedMemberInjection();
  assert.deepEqual(latest.events,events);
  assert.ok((await client.observedInjection()).events.every(event=>event.site.kind===undefined));
  assert.deepEqual(await call('counters'),before);
  const serialized=JSON.stringify(latest);
  assert.doesNotMatch(serialized,/fixture-only-(?:left|right)-value/u);
  assert.ok(!serialized.includes(token));
  return {events:owned,exactSourceTargets:expected.length,constructorEvents:constructor.events.length,
    actualStates:expected.map(([name,,outcome])=>({name,outcome})),suppliersUnchanged:true,separateFactoryKeys:true,
    optionalMethodSkipped:true,aggregatesAndQualifiersVerified:true,rawValuesRetained:false};
}

async function runSpringMemberInjectionChecks(api,vscode,checks){
  const proof=await withObservedInjectionFixture(async input=>{
    const {config,token}=input, connection={url:config.observerUrl,token};
    const observer=api.jpa.observer, client=new ObserverClient(connection);
    try{
      await observer.connect(connection);
      const result=await verify(input,client);
      const root=await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
      assert.ok(root.split(path.sep).includes('test-output'));
      const sourceUri=vscode.Uri.file(path.join(root,file));
      for(const name of ['field','filtered','named','missing','competing']){
        const event=result.events.find(item=>(item.site.parameterName||item.site.member)===name);
        const inspected=await vscode.commands.executeCommand(prefix+'inspectObservedMemberInjection',event.id);
        assert.deepEqual(inspected.event,event);
        assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()),inspected);
        const opened=await vscode.commands.executeCommand(prefix+'openObservedMemberSource',{eventId:event.id,sourceUri});
        assert.equal(opened.uri.toString(),sourceUri.toString());
        assert.equal(vscode.window.activeTextEditor.document.getText(opened.range),name);
      }
      return {...result,nativeView:true,installedNavigationTargets:5};
    }finally{client.dispose();observer.disconnect();}
  });
  checks.push('Installed Spring field and method inspection navigated actual qualified, optional, aggregated, and ambiguous injection observations across distinct BeanFactory contexts. Inspection left Bean supplier counts unchanged.');
  return proof;
}

if(require.main===module)withObservedInjectionFixture(async input=>{
  const {config,token}=input,client=new ObserverClient({url:config.observerUrl,token});
  try{
    const {events,...result}=await verify(input,client);
    return {...result,observedEvents:events.length,nativeView:false};
  }finally{client.dispose();}
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});

module.exports={runSpringMemberInjectionChecks};
