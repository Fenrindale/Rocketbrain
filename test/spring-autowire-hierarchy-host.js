'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {ObserverClient}=require('../src/jpa/observer-client');
const {sourceBeanDefinition,sourceMember,sourceParameter}=require('../src/spring/observed-injection');
const {withObservedInjectionFixture}=require('./spring-observed-injection-host');

const source='src/main/java/fixture/boot/HierarchyInjectionProbe.java';
const members='fixture.boot.HierarchyMembers', constructor='fixture.boot.HierarchyConstructor';
const lookup=events=>new Map(events.map(event=>[event.site.member||event.site.parameterName,event]));

async function verifyHierarchy({config,call,token},client) {
  assert.deepEqual(await call('hierarchy'),{
    constructor:'fixture-parent-fallback',fallback:'fixture-parent-fallback',qualified:'fixture-parent-qualified',
    replacement:'fixture-child-replacement',hidden:true,aggregate:['aggregateAncestor','aggregateLocal']
  });
  const before=await call('hierarchy-counters');
  assert.ok(before.factories>=4);
  const snapshot=await client.refresh();
  const ctor=await client.observedInjection(), fields=await client.observedMemberInjection();
  assert.equal(ctor.state,'observed',JSON.stringify(snapshot.warnings));
  assert.equal(fields.state,'observed',JSON.stringify(snapshot.warnings));
  const events=[...ctor.events.filter(event=>event.site.owner===constructor),
    ...fields.events.filter(event=>event.site.owner===members)];
  assert.equal(events.length,6,JSON.stringify({events,warnings:snapshot.warnings},null,2));
  const entries=lookup(events), primary=entries.get('dependency'), local=entries.get('localReplacement');
  const upper=primary.hierarchy?.owners[0]?.context, lower=primary.context;
  const contextName='rocketbrain-observed-hierarchy';
  assert.ok(upper,JSON.stringify({events,warnings:snapshot.warnings},null,2));
  assert.deepEqual([upper.id,lower.id],[contextName,contextName]);
  assert.notEqual(upper.key,lower.key);
  assert.ok(events.every(event=>event.context.key===lower.key));
  const expected=[
    ['dependency','resolved',[['hierarchyFallback',1,'hierarchyFallback']]],
    ['parentOnly','resolved',[['hierarchyFallback',1,'hierarchyFallback']]],
    ['selected','resolved',[['parentEast',1,'parentEast']]],
    ['localReplacement','resolved',[['hierarchyReplacement',0,'hierarchyReplacement']]],
    ['hiddenBeforeQualification','missing',[]],
    ['choices','aggregated',[['aggregateAncestor',1,'aggregateAncestor'],['aggregateLocal',0,'aggregateLocal']]]
  ];
  const text=await fs.readFile(path.join(config.projectPath,source),'utf8');
  for(const [name,state,origins] of expected){
    const item=entries.get(name);
    assert.equal(item?.state,state,JSON.stringify(item));
    const observed=item.hierarchy?.owners||[];
    assert.deepEqual(observed.map(row=>[row.beanName,row.distance,row.source?.member]),origins,JSON.stringify(item));
    assert.ok(observed.every(row=>row.context.key===(row.distance?upper.key:lower.key)));
    for(const row of observed){
      const match=sourceBeanDefinition({text},row.source);
      assert.ok(match,JSON.stringify(row));
      assert.equal(text.slice(match.start,match.end),row.source.member);
    }
    const site=item.site.kind?sourceMember({text},item.site):sourceParameter({text},item.site);
    assert.ok(site,name);
    assert.equal(text.slice(site.start,site.end),name);
  }
  assert.equal(entries.get('selected').hierarchy.resolverHint,'east');
  assert.equal(entries.get('selected').selectedBean,'parentEast');
  assert.deepEqual(local.hierarchy.shadowed,[{beanName:'hierarchyReplacement',context:upper,distance:1,hiddenBy:lower,
    hiddenByDistance:0,mode:'replaced'}]);
  assert.deepEqual(entries.get('hiddenBeforeQualification').hierarchy.shadowed,[{beanName:'hierarchyMasked',context:upper,distance:1,
    hiddenBy:lower,hiddenByDistance:0,mode:'hidden'}]);
  assert.ok(local.hierarchy.byTypeLookupObserved&&entries.get('hiddenBeforeQualification').hierarchy.byTypeLookupObserved);
  assert.equal((await client.persistenceContexts()).contexts.find(context=>context.key===lower.key)?.parentKey,upper.key);
  assert.deepEqual(await call('hierarchy-counters'),before);
  assert.ok(!JSON.stringify(events).includes(token));
  assert.doesNotMatch(JSON.stringify(events),/fixture-(?:parent|child)-/u);
  assert.ok([ctor,fields].every(record=>record.inspectionInvokedBeans===false&&record.observerExecutedSql===false));
  return {events,duplicateDisplayIdDistinctContexts:true,exactSourceTargets:6,ancestorFallback:true,
    wrongTypeChildShadow:true,sameTypeChildReplacement:true,distinctResolverHint:true,mixedAggregateOwners:true,
    metadataOnlyNoReplay:true,springFramework:'7.0.10'};
}

async function runSpringAutowireHierarchyChecks(api,vscode,checks) {
  const proof=await withObservedInjectionFixture(async input=>{
    const {config,token}=input, connection={url:config.observerUrl,token};
    const client=new ObserverClient(connection), observer=api.jpa.observer;
    try {
      await observer.connect(connection);
      const {events,...result}=await verifyHierarchy(input,client);
      const root=await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
      assert.ok(root.split(path.sep).includes('test-output'));
      const sourceUri=vscode.Uri.file(path.join(root,source));
      const entries=lookup(events);
      const cases=[['dependency','hierarchyFallback','hierarchyFallback'],['selected','parentEast','parentEast'],
        ['localReplacement','hierarchyReplacement','hierarchyReplacement'],['choices','aggregateAncestor','aggregateAncestor']];
      for(const [name,beanName,method] of cases){
        const event=entries.get(name), prefix='rocketbrain.jpa.observer.';
        const inspect=event.site.kind?'inspectObservedMemberInjection':'inspectObservedInjection';
        const open=event.site.kind?'openObservedMemberSource':'openObservedInjectionSource';
        const report=await vscode.commands.executeCommand(prefix+inspect,event.id);
        assert.deepEqual(report.event,event);
        assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()).event.hierarchy,event.hierarchy);
        const opened=await vscode.commands.executeCommand(prefix+open,{eventId:event.id,target:'bean-definition',beanName,sourceUri});
        assert.equal(opened.owningContext.key,event.hierarchy.owners.find(owner=>owner.beanName===beanName).context.key);
        assert.equal(vscode.window.activeTextEditor.document.getText(opened.range),method);
      }
      return {...result,nativeView:true,nativeDefinitionTargets:cases.length};
    } finally {client.dispose();observer.disconnect();}
  });
  checks.push('Observed the actual Spring parent and child BeanFactory decisions, selected ancestor definitions, ordinary name replacement and a wrong-type shadow, independent qualifier hints, and opened exact Bean methods without replay.');
  return proof;
}

if(require.main===module)withObservedInjectionFixture(async input=>{
  const client=new ObserverClient({url:input.config.observerUrl,token:input.token});
  try {
    const {events,...result}=await verifyHierarchy(input,client);
    return {...result,observedEvents:events.length,nativeView:false};
  }finally{client.dispose();}
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});

module.exports={runSpringAutowireHierarchyChecks};
