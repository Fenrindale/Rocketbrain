'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {normalizeObservedProviders,sourceMember}=require('../src/spring/observed-injection');

const fixture=path.join(__dirname,'fixtures/spring-boot-app/src/main/java/fixture/boot/ProviderInjectionProbe.java');
const wrapper='org.springframework.beans.factory.ObjectProvider';
const context={key:'context-2',id:'child'};
const site={kind:'constructor',owner:'fixture.boot.ProviderConsumer',requestingBean:'providerConsumer',
  requestedType:wrapper,dependencyType:'fixture.boot.ProviderDelayed',parameterTypes:[wrapper],
  parameterIndex:0,parameterName:'first'};
const selected={id:1,operation:'getObject',state:'resolved',selectedBean:'providerDelayedAncestor',context,site,
  hierarchy:{owners:[{beanName:'providerDelayedAncestor',context:{key:'context-1',id:'parent'},distance:1}]}};
const report=events=>({processId:1,state:'observed',omitted:0,events,
  inspectionInvokedBeans:false,beanValuesRetained:false,observerExecutedSql:false});

test('provider evidence requires an observed operation, concrete declaration and selected owner',()=>{
  assert.deepEqual(normalizeObservedProviders(report([selected])).events,[selected]);
  for(const edge of [{...selected,operation:'get'},{...selected,hierarchy:undefined},
    {...selected,site:{...site,requestedType:'org.springframework.beans.factory.ObjectFactory'}},
    {...selected,state:'missing',selectedBean:undefined}]) {
    assert.throws(()=>normalizeObservedProviders(report([edge])),/Invalid Spring/u);
  }
});

test('provider source ties the constructor to its saved generic argument',()=>{
  const text=fs.readFileSync(fixture,'utf8');
  const matched=sourceMember({text},site);
  assert.equal(text.slice(matched.start,matched.end),'first');
  const changed=text.replace('ProviderConsumer(ObjectProvider<ProviderDelayed> first)',
    'ProviderConsumer(ObjectProvider<ProviderQualified> first)');
  assert.equal(sourceMember({text:changed},site),undefined);
  const wildcard=text.replace('ProviderConsumer(ObjectProvider<ProviderDelayed> first)',
    'ProviderConsumer(ObjectProvider<? extends ProviderDelayed> first)');
  assert.equal(sourceMember({text:wildcard},site),undefined);
});
