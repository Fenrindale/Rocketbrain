'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{registerSchemaPrograms}=require('../src/db/schema-programs-vscode');
function setup({input,list}={}){
 let changed,provider;const received=[],shown=[],commands=new Map();
 class EventEmitter{event=()=>({dispose(){}});dispose(){}}
 const vscode={EventEmitter,Uri:{parse(text){return{path:text.slice(text.indexOf(':')+1),toString:()=>text};}},workspace:{isTrusted:true,registerTextDocumentContentProvider(_scheme,value){provider=value;return{dispose(){}};},async openTextDocument(uri){return{uri,text:provider.provideTextDocumentContent(uri)};}},window:{async showInputBox(options){return input?.(options,()=>changed?.());},async showTextDocument(doc){shown.push(doc);},async showErrorMessage(){},async showQuickPick(items){return[items[0]];}},commands:{registerCommand(name,callback){commands.set(name,callback);return{dispose(){commands.delete(name);}};}}};
 const api=registerSchemaPrograms({},vscode,{list:async()=>{await list?.();return{programs:[{schema:'app',name:'p',security:'DEFINER',definitionVisible:true,ownedByCurrentUser:true}],connectionEpoch:7};},analyze:async request=>{received.push(structuredClone(request));return{analysisOnly:true,executed:false,dynamicContext:{scope:'explicit-invocation-cases'},routines:request.routines};},onDidChangeDatabase(listener){changed=listener;return{dispose(){}};}});
 return{api,received,shown,commands};
}
test('explicit invocation inputs are privately snapshotted before asynchronous metadata selection',async()=>{
 let unblock;const s=setup({list:()=>new Promise(resolve=>{unblock=resolve;})});
 const request={routines:[{schema:'app',name:'p'}],inputs:[{schema:'app',name:'p',arguments:['people',2]}],sessionVariables:[{name:'@bound',value:3}]};
 try{const pending=s.api.inspect(request);request.inputs[0].arguments[0]='changed';request.sessionVariables[0].value=99;request.routines[0].name='different';unblock();const result=await pending;assert.deepEqual(s.received[0],{routines:[{schema:'app',name:'p'}],inputs:[{schema:'app',name:'p',arguments:['people',2]}],sessionVariables:[{name:'@bound',value:3}],connectionEpoch:7});assert.equal(result.report.dynamicContext.scope,'explicit-invocation-cases');assert.ok(!s.shown[0].text.includes('people'));assert.equal(JSON.parse(s.shown[0].text).executed,false);}finally{s.api.dispose();}
});
test('dynamic input command opens the input-specific readonly report and is disposed with the API',async()=>{
 const context={inputs:[{schema:'app',name:'p',arguments:[1]}],sessionVariables:[{name:'@sql',value:'SELECT id FROM app.people'}]};
 const s=setup({input:options=>{assert.match(options.prompt,/never runs/);assert.equal(options.validateInput(JSON.stringify(context)),null);return JSON.stringify(context);}});
 try{const result=await s.commands.get('rocketbrain.schema.programsWithInputs')({routines:[{schema:'app',name:'p'}]});assert.equal(s.received.length,1);assert.deepEqual(s.received[0].inputs,context.inputs);assert.equal(result.report.executed,false);assert.equal(s.shown.length,1);}finally{s.api.dispose();}assert.equal(s.commands.size,0);
});
test('cancelled inputs and connection changes while entering inputs never reach analysis',async()=>{
 const cancelled=setup();try{assert.equal(await cancelled.api.inspectWithInputs({routines:[{schema:'app',name:'p'}]}),null);assert.equal(cancelled.received.length,0);}finally{cancelled.api.dispose();}
 const stale=setup({input:(_options,change)=>{change();return'{"sessionVariables":[{"name":"@n","value":1}]}';}});
 try{await assert.rejects(stale.api.inspectWithInputs({routines:[{schema:'app',name:'p'}]}),/database changed/i);assert.equal(stale.received.length,0);assert.equal(stale.shown.length,0);}finally{stale.api.dispose();}
});
test('malformed or unrelated JSON input cannot silently become an unscoped program analysis',async()=>{
 for(const text of ['not JSON','[]','{}','{"password":"not-an-invocation"}','{"inputs":[],"execute":true}',' '.repeat(1024*1024+1)]){
  const s=setup({input:options=>{assert.ok(options.validateInput(text));return text;}});
  try{await assert.rejects(s.api.inspectWithInputs({routines:[{schema:'app',name:'p'}]}),/JSON|Only inputs|exceed/);assert.equal(s.received.length,0);assert.equal(s.shown.length,0);}finally{s.api.dispose();}
 }
});
