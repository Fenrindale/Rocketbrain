'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSqlScripts}=require('../src/db/sql-script-vscode');
function host(){
 let previewCalls=0,runCalls=0,reserveCalls=0,blocked=false,ddl=false,sqlMode=[],previewFailure=false,inputCalls=0;const finished=[],commands=new Map(),closeHandlers=new Set(),prompts=[],parameters=[],errors=[];
 const document={uri:{toString:()=> 'untitled:script.sql'},version:1,languageId:'sql',isClosed:false,text:'SELECT :value; SELECT 2;',getText:()=>document.text};
 const metadata=()=>({sessionId:'console-1',connectionId:17,connectionEpoch:2,documentUri:document.uri.toString(),sqlMode:[...sqlMode],parameterStyle:'named',parameterDefinitions:[{key:'value',name:'value',kind:'named',occurrences:1,valueKind:'text'}],statementCount:2,readOnly:true,autocommit:true,requiresImplicitCommitApproval:ddl,expiresAt:Date.now()+120000});
 const database={source:()=> 'fixture',describeSqlScript:async()=>metadata(),previewSqlScript:async(_sql,options)=>{previewCalls++;parameters.push(structuredClone(options.parameters));if(previewFailure)throw new Error('Backend preview rejected parameter values');return{...metadata(),reviewId:'backend'};},runSqlScript:async()=>{runCalls++;return{state:'completed',sessionId:'console-1',completed:2,failed:0,notRun:0,durationMs:1,stateAfter:{autocommit:true},statements:[{index:0,sql:'SELECT :value;',status:'completed',durationMs:1,result:{columns:['answer'],rows:[[42]],rowCount:1,affectedRows:0}},{index:1,sql:'SELECT 2;',status:'completed',result:{columns:['two'],rows:[[2]],rowCount:1,affectedRows:0}}]};},scriptResultBegin:()=>{reserveCalls++;if(blocked)throw new Error('All results are protected');return reserveCalls;},scriptResultFinish:(...args)=>finished.push(args),showResults:async()=>{}};
 const vscode={workspace:{isTrusted:true,onDidCloseTextDocument(handler){closeHandlers.add(handler);return {dispose(){closeHandlers.delete(handler);}};},registerTextDocumentContentProvider:()=>({dispose(){}})},commands:{registerCommand(name,handler){commands.set(name,handler);return {dispose(){commands.delete(name);}};}},window:{activeTextEditor:{document,selection:{isEmpty:true}},showQuickPick:async(items,options)=>{prompts.push({title:options.title,items});return options.title==='SQL parameters'?'Reuse previous values':items.find(item=>item.kind==='text');},showInputBox:async()=>{inputCalls++;return 'entered-'+inputCalls;},showErrorMessage:async message=>errors.push(message)}};
 const api=registerSqlScripts({},vscode,{database});return{api,document,vscode,database,finished,prompts,parameters,errors,runCommand:()=>commands.get('rocketbrain.sql.runWithParameters')(),closeDocument(){document.isClosed=true;for(const handler of closeHandlers)handler(document);},reopenDocument(){document.isClosed=false;},get counts(){return{previewCalls,runCalls,reserveCalls,inputCalls};},set blocked(v){blocked=v;},set ddl(v){ddl=v;},set sqlMode(v){sqlMode=[...v];},set previewFailure(v){previewFailure=v;}};
}
test('script source edits invalidate preparation and reviewed execution before effects',async()=>{
 const h=host();try{const described=await h.api.describe(h.document);h.document.text+=' SELECT 3;';h.document.version++;await assert.rejects(h.api.preview(described.id,{value:{kind:'text',value:'private'}}),/changed/);assert.equal(h.counts.previewCalls,0);const d=await h.api.describe(h.document),p=await h.api.preview(d.id,{value:{kind:'text',value:'private'}});h.document.version++;await assert.rejects(h.api.run(p.id),/changed/);assert.equal(h.counts.runCalls,0);assert.equal(h.counts.reserveCalls,0);}finally{await h.api.dispose();}
});
test('a protected result history blocks scripts before database execution and retains review',async()=>{
 const h=host();try{const d=await h.api.describe(h.document),p=await h.api.preview(d.id,{value:{kind:'text',value:'secret-value'}});assert.equal(JSON.stringify(p).includes('secret-value'),false);h.blocked=true;await assert.rejects(h.api.run(p.id),/protected/);assert.equal(h.counts.runCalls,0);h.blocked=false;const result=await h.api.run(p.id);assert.equal(result.state,'completed');assert.equal(h.counts.runCalls,1);await assert.rejects(h.api.run(p.id),/consumed/);}finally{await h.api.dispose();}
});
test('retained statement results are displayed without re-executing SQL',async()=>{
 const h=host();try{const d=await h.api.describe(h.document),p=await h.api.preview(d.id,{value:{kind:'integer',value:'42'}}),r=await h.api.run(p.id);assert.equal(h.finished[0][1].rows.length,2);const opened=await h.api.openStatement(r.resultId,0);assert.equal(opened.executedSql,false);assert.equal(h.counts.runCalls,1);assert.deepEqual(h.finished.at(-1)[1].rows,[[42]]);}finally{await h.api.dispose();}
});
test('DDL requires explicit approval and trust is rechecked before execution',async()=>{
 const h=host();h.ddl=true;try{const d=await h.api.describe(h.document),p=await h.api.preview(d.id,{value:{kind:'text',value:'x'}});await assert.rejects(h.api.run(p.id),/acknowledge/);assert.equal(h.counts.runCalls,0);h.vscode.workspace.isTrusted=false;await assert.rejects(h.api.run(p.id,{allowImplicitCommit:true}),/Trust/);assert.equal(h.counts.runCalls,0);}finally{await h.api.dispose();}
});

test('parameter commands explicitly offer reuse only after a successful review in the same SQL mode',async()=>{
 const h=host();try{
  assert.equal((await h.runCommand()).state,'completed');assert.equal(h.counts.inputCalls,1);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,0);
  assert.equal((await h.runCommand()).state,'completed');assert.equal(h.counts.inputCalls,1);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,1);assert.deepEqual(h.parameters[1],h.parameters[0]);assert.equal(h.counts.runCalls,2);
 }finally{await h.api.dispose();}
});

test('changing the live SQL mode reprompts values before the command can reuse a new successful review',async()=>{
 const h=host();try{
  await h.runCommand();h.sqlMode=['NO_BACKSLASH_ESCAPES'];await h.runCommand();assert.equal(h.counts.inputCalls,2);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,0);assert.equal(h.parameters[0].value.value,'entered-1');assert.equal(h.parameters[1].value.value,'entered-2');
  await h.runCommand();assert.equal(h.counts.inputCalls,2);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,1);assert.deepEqual(h.parameters[2],h.parameters[1]);
 }finally{await h.api.dispose();}
});

test('closing a SQL document clears its remembered parameter values even when the same URI reopens',async()=>{
 const h=host();try{
  await h.runCommand();h.closeDocument();h.reopenDocument();await h.runCommand();assert.equal(h.counts.inputCalls,2);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,0);assert.equal(h.parameters[1].value.value,'entered-2');
 }finally{await h.api.dispose();}
});

test('a failed backend preview never stores command parameter values for reuse',async()=>{
 const h=host();try{
  h.previewFailure=true;assert.equal(await h.runCommand(),undefined);assert.equal(h.counts.runCalls,0);assert.match(h.errors[0],/Backend preview rejected/);h.previewFailure=false;
  await h.runCommand();assert.equal(h.counts.inputCalls,2);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,0);assert.equal(h.parameters[1].value.value,'entered-2');assert.equal(h.counts.runCalls,1);
  await h.runCommand();assert.equal(h.counts.inputCalls,2);assert.equal(h.prompts.filter(prompt=>prompt.title==='SQL parameters').length,1);assert.deepEqual(h.parameters[2],h.parameters[1]);
 }finally{await h.api.dispose();}
});
