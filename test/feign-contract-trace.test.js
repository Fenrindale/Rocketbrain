'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {endpointContractFile,inheritedFeignContracts}=require('../src/spring/endpoint-contracts');
const {normalizeFeignContracts}=require('../src/spring/feign-contract-trace');
const {renderFeignContracts}=require('../src/spring/feign-contract-trace-vscode');

const feign='import org.springframework.cloud.openfeign.FeignClient;';
const routes='import org.springframework.web.bind.annotation.GetMapping;';
const records=(...inputs)=>inputs.flatMap(([name,text])=>endpointContractFile(text,'file:///'+name+'.java',true).interfaces);

test('Feign inheritance follows exact imports and overloads while child overrides take precedence',()=>{
  const input=records(
    ['Client', 'package api; '+feign+' '+routes+' import shared.Middle; @FeignClient(path="/client") interface TestClient extends Middle {'+
      '@GetMapping("/own") String call(int id); }'],
    ['Middle','package shared; interface Middle extends Root {}'],
    ['Root','package shared; '+routes+' interface Root {'+
      '@GetMapping("/old") String call(int id); @GetMapping("/text/{name}") String call(String name); '+
      '@GetMapping("/skipped") default String skipped(){return "";} }'],
    ['Wrong','package other; '+routes+' interface Middle { @GetMapping("/wrong") String bad(); }']
  );
  const output=inheritedFeignContracts(input);
  assert.equal(output.replacements.size,1);
  assert.deepEqual(output.inherited.map(item=>[item.path,item.uri,item.clientType,item.declaringType]),[
    ['/client/text/{name}','file:///Root.java','api.TestClient','shared.Root']
  ]);
  const range=output.inherited[0].range;
  assert.equal(range.start.line,0);
  assert.ok(range.end.character>range.start.character);
});

test('Feign inheritance retains unresolved state for missing, duplicate and unsupported parent interfaces',()=>{
  const child='package api; '+feign+' import shared.Parent; @FeignClient(path="/safe") interface Client extends Parent {}';
  const parent='package shared; '+routes+' interface Parent { @GetMapping("/route") String route(); }';
  for(const inputs of [
    [['Client',child]],
    [['Client',child],['Parent',parent],['Duplicate',parent]],
    [['Client',child],['Parent',parent.replace('interface Parent','interface Parent<T>')]],
    [['Client',child.replace('{}','{ String route(); }')],['Parent',parent]],
    [['Client',child.replace('extends Parent','extends Parent, Another')],['Parent',parent]],
    [['Client',child.replace('path="/safe"','path="/safe", configuration=Custom.class')],['Parent',parent]]
  ]){
    const listed=inheritedFeignContracts(records(...inputs));
    assert.equal(listed.replacements.size,0);
    assert.deepEqual(listed.inherited,[]);
  }
});

test('the runtime Feign projection retains only bounded methods and excludes query or header data',()=>{
  const client={client:'fixture.Client',contract:'fixture.RewritingContract',basePathObserved:true,unavailable:0,
    url:'https://private.invalid',methods:[{declaration:'fixture.Shared',name:'read',parameters:['int'],inherited:true,
      verb:'GET',template:'/item/{id}',path:'/prefix/item/{id}',headers:{'Authorization':'private'}}]};
  const payload={schemaVersion:1,state:'ready',enabled:true,dropped:0,clients:[client]};
  const normalized=normalizeFeignContracts(payload);
  const rendered=renderFeignContracts(normalized);
  assert.match(rendered,/GET \/prefix\/item\/\{id\}/);
  assert.match(rendered,/fixture.Shared.read\(int\)/);
  assert.match(rendered,/Inherited/);
  assert.match(rendered,/Content-Security-Policy/);
  assert.ok(!JSON.stringify(normalized).includes('private'));
  assert.ok(!rendered.includes('private'));
  assert.throws(()=>normalizeFeignContracts({...payload,clients:[{...client,methods:[{...client.methods[0],path:'/prefix?a=b'}]}]}),/Invalid OpenFeign/);
  assert.throws(()=>normalizeFeignContracts({...payload,state:'unsupported'}),/Invalid OpenFeign/);
});
