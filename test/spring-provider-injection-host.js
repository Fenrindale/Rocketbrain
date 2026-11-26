'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {ObserverClient}=require('../src/jpa/observer-client');
const {sourceMember,sourceBeanDefinition}=require('../src/spring/observed-injection');
const {withObservedInjectionFixture}=require('./spring-observed-injection-host');

const source='src/main/java/fixture/boot/ProviderInjectionProbe.java';
const owner='fixture.boot.ProviderConsumer';
const siteName=event=>event.site.member||event.site.parameterName;
const scoped=trace=>trace.events.filter(event=>event.site.owner===owner);

async function verify({config,token,call},client) {
  const connected=await client.refresh();
  assert.equal(connected.capabilities.springProviderTrace,true);
  assert.deepEqual(await call('provider-prepare'),{prototypes:0,singletons:0,callbacks:0});
  const initial=await client.observedProviderInjection();
  assert.equal(initial.state,'observed',JSON.stringify(connected.warnings));
  assert.deepEqual(scoped(initial),[],JSON.stringify(initial.events));
  assert.deepEqual(await call('provider-counters'),{prototypes:0,singletons:0,callbacks:0});
  assert.deepEqual(await call('provider-resolve'),{
    prototype:'fixture-provider-delayed',qualified:'fixture-provider-east',missing:true,ambiguous:'ambiguous',jsr:'fixture-provider-jsr'
  });
  assert.deepEqual(await call('provider-counters'),{prototypes:3,singletons:0,callbacks:0});
  const trace=await client.observedProviderInjection();
  const events=scoped(trace), beforeCache=new Map(events.map(event=>[siteName(event),event]));
  const expected=[
    ['first','getObject','resolved','providerDelayedAncestor',1],
    ['qualified','getIfAvailable','resolved','providerEast',1],
    ['missing','getIfAvailable','missing',null,null],
    ['ambiguous','getIfAvailable','ambiguous',null,null],
    ['jsr','get','resolved','providerJsr',0]
  ];
  const printed=JSON.stringify({events,warnings:connected.warnings},null,2);
  assert.equal(beforeCache.size,expected.length,printed);
  const text=await fs.readFile(path.join(config.projectPath,source),'utf8');
  for(const [name,operation,state,selection,distance] of expected){
    const event=beforeCache.get(name);
    assert.deepEqual([event?.operation,event?.state,event?.selectedBean??null],[operation,state,selection],printed);
    assert.equal(event.context.id,'fixture-provider-child');
    const site=sourceMember({text},event.site);
    assert.ok(site,name);
    assert.equal(text.slice(site.start,site.end),name);
    const ancestor=event.hierarchy?.owners[0];
    assert.equal(ancestor?.distance??null,distance);
    if(selection){
      assert.equal(ancestor.context.id,distance?'fixture-provider-parent':'fixture-provider-child');
      assert.equal(ancestor.context.key===event.context.key,distance===0);
      const declaration=sourceBeanDefinition({text},ancestor.source);
      assert.ok(declaration,name);
      assert.equal(text.slice(declaration.start,declaration.end),selection);
    }
  }
  assert.deepEqual(scoped(await client.observedProviderInjection()),events);
  assert.deepEqual(await call('provider-counters'),{prototypes:3,singletons:0,callbacks:0});
  assert.deepEqual(await call('provider-supplier'),{origin:'caller-only-provider-fallback'});
  assert.deepEqual(scoped(await client.observedProviderInjection()),events);
  assert.deepEqual(await call('provider-cached'),{origin:'fixture-provider-cached'});
  const cached=await client.observedProviderInjection();
  assert.equal(scoped(cached).length,events.length+1,JSON.stringify(cached.events));
  assert.equal(scoped(cached).at(-1).selectedBean,'providerCached');
  assert.deepEqual(await call('provider-cached'),{origin:'fixture-provider-cached'});
  assert.deepEqual(scoped(await client.observedProviderInjection()),scoped(cached));
  assert.deepEqual(await call('provider-counters'),{prototypes:3,singletons:1,callbacks:1});
  assert.ok(!JSON.stringify(cached).includes(token));
  assert.doesNotMatch(JSON.stringify(cached),/fixture-provider-(?:delayed|east|jsr|cached)|caller-only-provider-fallback/u);
  assert.deepEqual([trace.inspectionInvokedBeans,trace.beanValuesRetained,trace.observerExecutedSql],[false,false,false]);
  assert.equal(trace.processId,connected.processId);
  return {events,siteTargets:5,owningDefinitionTargets:3,ancestorFallback:true,
    resolvedMissingAndAmbiguous:true,actualJakartaProvider:true,initiallyDeferred:true,cachedRetrievalNotReplayed:true,
    callerSupplierOnce:true,metadataOnlyNoReplay:true,springFramework:'7.0.10'};
}

async function runSpringProviderInjectionChecks(api,vscode,checks) {
  const proof=await withObservedInjectionFixture(async input=>{
    const {config,token,call}=input, connection={url:config.observerUrl,token};
    const client=new ObserverClient(connection), observer=api.jpa.observer;
    try {
      await observer.connect(connection);
      const {events,...result}=await verify(input,client);
      const root=await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
      assert.ok(root.split(path.sep).includes('test-output'));
      const sourceUri=vscode.Uri.file(path.join(root,source));
      const commands=await vscode.commands.getCommands(true), prefix='rocketbrain.jpa.observer.';
      assert.ok(commands.includes(prefix+'inspectObservedProviderInjection')&&commands.includes(prefix+'openObservedProviderSource'));
      for(const event of events){
        const report=await vscode.commands.executeCommand(prefix+'inspectObservedProviderInjection',event.id);
        assert.deepEqual(report.event,event);
        const selected=await vscode.commands.executeCommand(prefix+'openObservedProviderSource',{eventId:event.id,sourceUri});
        assert.equal(vscode.window.activeTextEditor.document.getText(selected.range),siteName(event));
        if(event.selectedBean){
          const declared=await vscode.commands.executeCommand(prefix+'openObservedProviderSource',
            {eventId:event.id,target:'bean-definition',beanName:event.selectedBean,sourceUri});
          assert.equal(vscode.window.activeTextEditor.document.getText(declared.range),event.selectedBean);
          assert.equal(declared.owningContext.key,event.hierarchy.owners[0].context.key);
        }
      }
      assert.deepEqual(await call('provider-counters'),{prototypes:3,singletons:1,callbacks:1});
      return {...result,nativeView:true};
    } finally {client.dispose();observer.disconnect();}
  });
  checks.push('Observed genuine late ObjectProvider and Jakarta Provider decisions with exact injection and owning Bean source navigation and no bean or callback replay.');
  return proof;
}

function headless(){
  return withObservedInjectionFixture(async input=>{
    const client=new ObserverClient({url:input.config.observerUrl,token:input.token});
    try {const {events,...result}=await verify(input,client);return {...result,nativeView:false};}
    finally {client.dispose();}
  });
}

module.exports={runSpringProviderInjectionChecks};
if(require.main===module)headless().then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
