'use strict';

const test=require('node:test'), assert=require('node:assert/strict');
const {normalizeArcLookups,arcProducerSource}=require('../src/java/quarkus-arc-lookups');
const {renderArcLookups}=require('../src/java/quarkus-arc-vscode');

const method={kind:'method',owner:'sample.Factory',member:'make',descriptor:'(I)Lsample/Service;'};
const normal={state:'ready',processId:412,packages:['sample'],inspectionResolvedBeans:false,
  qualifierValuesRetained:false,beanValuesRetained:false,lookups:[{
    id:'arc-lookup-1',scope:'arc-loader-1',requiredType:'sample.Service',qualifierTypes:['jakarta.inject.Named'],
    status:'selected',eligibleCount:1,candidates:[{id:'arc-bean-1',kind:'method',target:method}]
  }]};

test('Arc responses validate exact lookup and identity scopes and strip extra data',()=>{
  const payload=structuredClone(normal);
  payload.lookups[0].candidates[0].retainedValue='private';
  assert.deepEqual(normalizeArcLookups(payload),normal);
  const modifies=[
    value=>value.lookups[0].status='ambiguous',
    value=>value.lookups[0].requiredType='outside.Service',
    value=>value.lookups[0].qualifierTypes=null,
    value=>value.lookups[0].candidates[0].target.owner='outside.Factory',
    value=>value.lookups[0].candidates[0].target.descriptor='invalid',
    value=>value.lookups[0].candidates[0].kind='opaque',
    value=>value.lookups.push({...value.lookups[0],id:'arc-lookup-2',scope:'arc-loader-2'}),
    value=>{const lookup=value.lookups[0];lookup.status='ambiguous';lookup.eligibleCount=2;lookup.candidates.push(lookup.candidates[0]);},
    value=>value.qualifierValuesRetained=true,
    value=>value.state='waiting'
  ];
  for(const mutate of modifies){
    const bad=structuredClone(normal);
    mutate(bad);
    assert.throws(()=>normalizeArcLookups(bad),/Invalid Quarkus Arc lookup evidence/u);
  }
  const partial=structuredClone(normal);
  partial.state='partial';
  partial.lookups[0].qualifierTypes=null;
  assert.deepEqual(normalizeArcLookups(partial),partial);
});

test('Arc navigation requires one correctly annotated exact JVM signature',()=>{
  const text=`package sample;
import jakarta.enterprise.inject.Produces;
import outside.Example;
class Factory {
  @Produces Service make(String value) { return null; }
  Service make(long value) { return null; }
  @Produces Service make(int value) { return null; }
  @Produces Example[] item;
  class Nested {
    @jakarta.enterprise.inject.Produces Service item(){ return null; }
  }
}`;
  const physical=arcProducerSource({text},method);
  assert.equal(text.slice(physical.start,physical.end),'make');
  assert.equal(physical.start,text.indexOf('make(int'));
  assert.equal(physical.sameSourceRevisionVerified,false);
  assert.equal(arcProducerSource({text},{...method,descriptor:'(J)Lsample/Service;'}),undefined);
  assert.equal(arcProducerSource({text},{...method,descriptor:'(F)Lsample/Service;'}),undefined);
  assert.equal(arcProducerSource({text:text.replace('jakarta.enterprise.inject.Produces;','other.Produces;')},method),undefined);
  assert.equal(arcProducerSource({text:text.replace('Service make(String','Service make(int')},method),undefined);
  const field=arcProducerSource({text},{kind:'field',owner:'sample.Factory',member:'item',descriptor:'[Loutside/Example;'});
  assert.equal(field.start,text.indexOf('item;'));
  const nested=arcProducerSource({text},{kind:'method',owner:'sample.Factory$Nested',member:'item',descriptor:'()Lsample/Service;'});
  assert.equal(nested.start,text.indexOf('item()'));
});

test('Arc renderer shows observation and navigation availability with no scripts',()=>{
  const payload=structuredClone(normal);
  payload.lookups[0].candidates[0]={id:'arc-bean-1',kind:'opaque',target:null};
  const html=renderArcLookups(normalizeArcLookups(payload));
  assert.match(html,/No direct Java producer target observed/u);
  assert.match(html,/selected · 1/u);
  assert.match(html,/Qualifier values are omitted/u);
  assert.match(html,/default-src 'none'/u);
  assert.doesNotMatch(html,/<script/u);
});
