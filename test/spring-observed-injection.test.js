'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { normalizeObservedInjection, normalizeObservedMembers, sourceParameter, sourceMember,
  sourceBeanDefinition } = require('../src/spring/observed-injection');
const { registerObserver } = require('../src/jpa/observer-vscode');

const text = 'package example; import vendor.Value; class Consumer { Consumer(Value left, Value right) {} }';
const site = {owner:'example.Consumer',requestingBean:'consumer',parameterIndex:1,parameterName:'right',parameterTypes:['vendor.Value','vendor.Value']};
const event = {id:1,state:'resolved',context:{key:'context-2',id:'sample'},site,selectedBean:'registeredRight',suggestedName:'registeredRight'};
const trace = {processId:999,state:'observed',omitted:0,events:[event],inspectionInvokedBeans:false,beanValuesRetained:false,observerExecutedSql:false};
const uri = file => ({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
const memberSite={owner:'example.Consumer',requestingBean:'consumer',kind:'field',member:'named',
  requestedType:'java.util.Map',dependencyType:'vendor.Value'};
const memberEvent={id:5,context:event.context,site:memberSite,state:'aggregated',selectedBeans:['left','right']};

test('hierarchy evidence binds exact selected labels, context distances, shadow paths and optional source shape',()=>{
  const ancestor={key:'context-1',id:'sample'};
  const source={kind:'bean-method',owner:'example.Parents',member:'right',returnType:'vendor.Value',parameterTypes:[]};
  const owners=[{beanName:'left',context:event.context,distance:0},
    {beanName:'right',context:ancestor,distance:1,source}];
  const observed={owners,resolverHint:'explicit-hint'};
  const row={...memberEvent,hierarchy:observed};
  const raw={...trace,events:[row]};
  assert.deepEqual(normalizeObservedMembers(raw).events,[row]);
  const shadow={beanName:'right',context:ancestor,distance:1,hiddenBy:event.context,hiddenByDistance:0,mode:'hidden'};
  assert.deepEqual(normalizeObservedMembers({...raw,events:[{...row,hierarchy:{...observed,
    byTypeLookupObserved:true,shadowed:[shadow]}}]}).events[0].hierarchy.shadowed,[shadow]);
  const tryHierarchy=hierarchy=>normalizeObservedMembers({...raw,events:[{...row,hierarchy}]});
  for (const malformed of [
    {owners:[...owners].reverse()},
    {owners:[owners[0],{...owners[1],context:event.context}]},
    {owners:[owners[0],{...owners[1],distance:0}]},
    {owners:[owners[0],{...owners[1],source:{...source,parameterTypes:['../source']}}]},
    {owners:[owners[0],{...owners[1],source:{...source,parameterTypes:Array(5).fill('a'.repeat(240))}}]},
    {...observed,shadowed:[shadow]},
    {...observed,byTypeLookupObserved:true,shadowed:[{...shadow,hiddenByDistance:1}]}
  ])assert.throws(()=>tryHierarchy(malformed),/hierarchy/u);
});

test('observed Bean declaration navigation matches factory signatures or declared classes only',()=>{
  const java='package example; import vendor.Value; import org.springframework.context.annotation.Bean; '+
    'class Parents { @Bean Value right() { return null; } @Bean Value right(String origin) { return null; } }';
  const method={kind:'bean-method',owner:'example.Parents',member:'right',returnType:'vendor.Value',parameterTypes:[]};
  const selected=sourceBeanDefinition({text:java},method);
  assert.equal(java.slice(selected.start,selected.end),'right');
  assert.equal(java[selected.end+1],')');
  assert.equal(sourceBeanDefinition({text:java.replace('@Bean Value right()','Value right()')},method),undefined);
  assert.equal(sourceBeanDefinition({text:java.replace('vendor.Value','other.Value')},method),undefined);
  const declared=sourceBeanDefinition({text:java},{kind:'class',owner:'example.Parents'});
  assert.equal(java.slice(declared.start,declared.end),'Parents');
});

test('member evidence accepts bounded local aggregate names and typed actual missing without changing constructor events',()=>{
  const methodSite={...memberSite,kind:'method',member:'wire',parameterTypes:['vendor.Value','java.util.Map'],
    parameterIndex:1,parameterName:'map'};
  const fields={...trace,events:[{...memberEvent,returned:'private'}]};
  assert.deepEqual(normalizeObservedMembers(fields).events,[memberEvent]);
  assert.throws(()=>normalizeObservedInjection(fields),/event/u);
  const absent={...memberEvent,state:'missing',site:methodSite};
  delete absent.selectedBeans;
  assert.deepEqual(normalizeObservedMembers({...fields,events:[absent]}).events,[absent]);
  for(const bad of [
    {...memberEvent,selectedBeans:['left','left']},
    {...memberEvent,selectedBeans:Array.from({length:13},(_,i)=>'named'+i)},
    {...memberEvent,site:{...memberSite,requestedType:'java.util.Optional'}},
    {...memberEvent,site:{...memberSite,parameterTypes:['vendor.Value']}},
    {...memberEvent,site:{...methodSite,parameterIndex:0}},
    {...absent,selectedBean:'invented'},
    {...memberEvent,suggestedName:'unchecked-hint'}
  ])assert.throws(()=>normalizeObservedMembers({...fields,events:[bad]}),/Spring/u);
});

test('exact member navigation validates annotation, wrapped type specification and overload signature',()=>{
  const source=`package example;
    import vendor.Value;
    import other.NewValue;
    import java.util.Map;
    import org.springframework.beans.factory.annotation.Autowired;
    class Consumer {
      @Autowired Map<String,Value> named;
      @Autowired void wire(Value item, Map<String,Value> map){}
      @Autowired void wire(NewValue unused, Map<String,Value> map){}
      @Autowired Value[] array;
    }`;
  const found=sourceMember({text:source},memberSite);
  assert.equal(source.slice(found.start,found.end),'named');
  assert.equal(found.sameSourceRevisionVerified,false);
  assert.equal(sourceMember({text:source.replace('Map<String,Value> named','Map<String,NewValue> named')},memberSite),undefined);
  assert.equal(sourceMember({text:source.replace('@Autowired Map<String,Value> named','Map<String,Value> named')},memberSite),undefined);
  const methodSite={...memberSite,kind:'method',member:'wire',parameterTypes:['vendor.Value','java.util.Map'],
    parameterIndex:1,parameterName:'map'};
  const param=sourceMember({text:source},methodSite);
  assert.equal(param.start,source.indexOf('map)'));
  assert.equal(sourceMember({text:source}, {...methodSite,parameterTypes:['vendor.Different','java.util.Map']}),undefined);
  const field=sourceMember({text:source},{...memberSite,member:'array',requestedType:'vendor.Value[]'});
  assert.equal(source.slice(field.start,field.end),'array');
});

test('constructor evidence preserves index, factory context and unresolved ambiguity boundaries', () => {
  const ambiguous = {...event,id:2,state:'ambiguous',context:{key:'context-3',id:'sample'}};
  delete ambiguous.selectedBean;
  delete ambiguous.suggestedName;
  const input={...trace,events:[{...event,value:'never returned'},ambiguous]};
  assert.deepEqual(normalizeObservedInjection(input).events,[event,ambiguous]);
  assert.throws(()=>normalizeObservedInjection({...trace,events:[event,{...ambiguous,selectedBean:'fake'}]}),/event/);
  assert.throws(()=>normalizeObservedInjection({...trace,events:[event,event]}),/event/);
  assert.throws(()=>normalizeObservedInjection({...trace,beanValuesRetained:true}),/resolution data/);
});

test('source navigation requires a unique constructor with matching parameter types and index', () => {
  const position = sourceParameter({text},site);
  assert.equal(text.slice(position.start,position.end),'right');
  assert.equal(position.sameSourceRevisionVerified,false);
  assert.equal(sourceParameter({text:text.replace('vendor.Value','different.Value')},site),undefined);
  assert.equal(sourceParameter({text:text.replace('Value right','Value changed')},site),undefined);
  assert.equal(sourceParameter({text:text.replace('Value right','Value... right')},site),undefined);
  assert.equal(sourceParameter({text:text.replace('right) {}','right) {} Consumer(Value left, Value right) {}')},site),undefined);
  assert.equal(sourceParameter({text:text.replace('import vendor.Value;','import vendor.*;')},site),undefined);
});

test('normal observed-injection commands read the retained event and verified saved source', async t => {
  const parent=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(parent,'rb-runtime-wiring-'));
  const file=path.join(root,'Consumer.java');
  await fs.writeFile(file,text);
  t.after(async()=>{
    const local=path.relative(parent,await fs.realpath(root));
    assert.match(local,/^rb-runtime-wiring-[A-Za-z0-9]+$/u);
    await fs.rm(root,{recursive:true,force:true});
  });
  let changeOnRead=false, observations=0;
  const server=http.createServer(async(request,response)=>{
    if(request.url==='/snapshot'){response.end(JSON.stringify({processId:999,capabilities:{springAutowireTrace:true},
      factories:[],events:[]}));return;}
    assert.equal(request.method,'GET');
    assert.equal(request.url,'/spring-observed-constructor-injection');
    observations++;
    if(changeOnRead&&observations===5)await fs.writeFile(file,text.replace('Value right','Value changed'));
    response.end(JSON.stringify(trace));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  class Emitter { event(){return {dispose(){}};} fire(){} dispose(){} }
  const commands=new Map(), opened=[];
  const document={languageId:'java',version:1,uri:uri(file),isDirty:false,isClosed:false,getText:()=>text,
    positionAt:offset=>({offset})};
  const vscode={
    EventEmitter:Emitter,
    Range:class{constructor(start,end){Object.assign(this,{start,end});}},
    commands:{registerCommand(name,action){commands.set(name,action);return {dispose(){}};}},
    workspace:{isTrusted:true,workspaceFolders:[{uri:uri(root)}],async openTextDocument(value){return value.scheme?document:value;}},
    window:{async showQuickPick(items){return items[0];},async showOpenDialog(){return [uri(file)];},
      async showErrorMessage(message){throw Error(message);},async showTextDocument(value,options){opened.push({value,options});}}
  };
  const observer=registerObserver({},vscode,{appendLine(){}},{source:async()=>({entities:[]})});
  t.after(()=>observer.dispose());
  await observer.connect({url:'http://127.0.0.1:'+server.address().port,token:'d'.repeat(64)});
  const report=await commands.get('rocketbrain.jpa.observer.inspectObservedInjection')();
  assert.deepEqual(report.event,event);
  assert.deepEqual(JSON.parse(opened[0].value.content),report);
  const source=await commands.get('rocketbrain.jpa.observer.openObservedInjectionSource')();
  assert.deepEqual(source.range,opened[1].options.selection);
  assert.equal(text.slice(source.range.start.offset,source.range.end.offset),'right');
  changeOnRead=true;
  await assert.rejects(observer.openObservedInjectionSource({eventId:1,sourceUri:uri(file)}),error=>error.code==='STALE');
  assert.equal(opened.length,2);
});
