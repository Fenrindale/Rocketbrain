'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {normalizeArcInterceptors}=require('../src/java/quarkus-interceptors');
const {arcObservedMethodSource}=require('../src/java/quarkus-arc-lookups');
const {renderArcInterceptors}=require('../src/java/quarkus-interceptors-vscode');

function report() {
  return {state:'ready',processId:11,packages:['sample.beans'],bindingValuesRetained:false,argumentsRetained:false,
    inspectionInvokedApplication:false,invocations:[{
      id:'arc-interception-1',target:{owner:'sample.beans.Service',member:'run',descriptor:'(I)I'},
      bindingTypes:['sample.beans.Audit'],configured:[{kind:'source',priority:100,target:{owner:'sample.beans.First',
        member:'around',descriptor:'(Ljakarta/interceptor/InvocationContext;)Ljava/lang/Object;'}}],
      entered:[0],outcome:'returned'
    }]};
}

test('validates bounded interceptor identities, chain entries and privacy flags',()=>{
  assert.deepEqual(normalizeArcInterceptors(report()),report());
  for(const change of [
    value=>{value.argumentsRetained=true;},
    value=>{value.bindingValuesRetained=true;},
    value=>{value.invocations[0].target.owner='sample.beansforeign.Service';},
    value=>{value.invocations[0].configured[0].target.descriptor='()I';},
    value=>{value.invocations[0].entered=[1];},
    value=>{value.invocations[0].bindingTypes=['sample.beans.Audit','sample.beans.Audit'];},
    value=>{value.invocations[0].configured[0]={kind:'unresolved'};}
  ]){
    const invalid=report();change(invalid);
    assert.throws(()=>normalizeArcInterceptors(invalid),/Invalid Quarkus interceptor observation/u);
  }
  const partial=report();partial.state='partial';partial.invocations[0].configured=[{kind:'unresolved'}];
  assert.match(renderArcInterceptors(normalizeArcInterceptors(partial)),/Source and priority unavailable/u);
});

test('navigates only an exact target overload or a direct Jakarta AroundInvoke callback',()=>{
  const source={text:'package sample.beans; class Service { int run(long x) {return 1;} int run(int x) {return 2;} }'};
  const target=report().invocations[0].target;
  const selected=arcObservedMethodSource(source,target);
  assert.equal(selected.start,source.text.lastIndexOf('run'));
  assert.equal(arcObservedMethodSource(source,{...target,descriptor:'(D)I'}),undefined);
  const wrapped={text:'package sample.beans; import jakarta.interceptor.AroundInvoke; import jakarta.interceptor.InvocationContext;'+
    ' class First { @AroundInvoke Object around(InvocationContext value) {return value;} }'};
  const callback=report().invocations[0].configured[0].target;
  assert.equal(arcObservedMethodSource(wrapped,callback,'jakarta.interceptor.AroundInvoke').name,'around');
  assert.equal(arcObservedMethodSource({text:wrapped.text.replace('import jakarta.interceptor.AroundInvoke;',
    'import other.AroundInvoke;')},callback,'jakarta.interceptor.AroundInvoke'),undefined);
});
