'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeSpring}=require('../src/spring/model');
const {candidateChoices,prepareQualifier,snapshotFingerprint}=require('../src/spring/autowiring-fix');
const {registerAutowiringFix,PREVIEW}=require('../src/spring/autowiring-fix-vscode');

const URI='file:///demo/Consumer.java', BEANS='file:///demo/Bindings.java';
const IMPORTS=`
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;`;
const SUPPLY=`
  @Bean("fastMode") @Qualifier("fast-read") Mode fast(){return null;}
  @Bean(name={"directMode","legacyDirect"}) Mode direct(){return null;}`;

function modelFixture(member='Consumer(Mode mode){}',factories=SUPPLY,options={}){
  const java=[
    {uri:URI,text:`package demo; ${IMPORTS}\n@Component class Consumer { ${member} }\ninterface Mode {}`},
    {uri:BEANS,text:`package demo; ${IMPORTS}\n@Configuration class Bindings { ${factories} }`}
  ];
  const input={java,properties:[],options:{basePackages:['demo'],closedWorld:true,parameterNames:true,...options}};
  const model=analyzeSpring(java,input.properties,input.options);
  return {input,model,injection:model.injections.find(item=>item.name==='mode')};
}

test('quick fix chooses actual qualifier or explicit Bean name and proves exactly one target after editing',()=>{
  const {model,injection,input}=modelFixture();
  assert.equal(injection.resolution.state,'ambiguous');
  const choices=candidateChoices(model,injection);
  assert.deepEqual(choices.map(value=>[value.beanName,value.qualifier,value.qualifierSource]),[
    ['fastMode','fast-read','qualifier'],['directMode','directMode','bean-name']
  ]);
  for(const choice of choices){
    const plan=prepareQualifier(model,input,{uri:URI,injectionId:injection.id,...choice});
    assert.equal(plan.before,input.java[0].text);
    assert.equal(plan.after.slice(0,plan.offset)+plan.after.slice(plan.offset+plan.text.length),plan.before);
    assert.match(plan.after,/@org\.springframework\.beans\.factory\.annotation\.Qualifier\("[-\w]+"\) Mode mode/);
    assert.equal(plan.scope,'configured-local-spring-source-model');
    assert.notEqual(plan.beforeHash,plan.afterHash);
  }
});

test('field, initializer and Bean method edits use their precise Java declaration start',()=>{
  for(const [member,origin,anchor] of [
    ['@Autowired private Mode mode;','field','@Autowired private Mode mode'],
    ['@Autowired void wire(/* keep */ final Mode mode){}','method-parameter','final Mode mode'],
    ['@Bean Consumer view(final Mode mode){return null;}','factory-parameter','final Mode mode']
  ]){
    const {model,injection,input}=modelFixture(member);
    assert.equal(injection.origin,origin);
    const choice=candidateChoices(model,injection)[0];
    assert.ok(choice);
    const plan=prepareQualifier(model,input,{uri:URI,injectionId:injection.id,...choice});
    assert.equal(plan.offset,plan.before.indexOf(anchor));
    assert.equal(plan.after.slice(plan.offset+plan.text.length,plan.offset+plan.text.length+anchor.length),anchor);
    assert.match(plan.text,/^@org\.springframework/);
  }
});

test('potentially conditional, self, already-qualified and runtime-name-sensitive targets offer no quick fix',()=>{
  const conditional=modelFixture('Consumer(Mode mode){}',SUPPLY+' @Bean @Conditional(Switch.class) Mode lazy(){return null;}');
  assert.equal(conditional.injection.resolution.state,'unknown');
  const cases=[
    conditional,
    modelFixture('@Autowired(required=false) Mode mode;'),
    modelFixture('@Autowired static Mode mode;'),
    modelFixture('@Autowired final Mode mode=null;'),
    modelFixture('Consumer(@Qualifier("shared") Mode mode){}',SUPPLY.replace('fast-read','shared').replace('Mode direct','@Qualifier("shared") Mode direct')),
    modelFixture('Consumer(Mode directMode){}',SUPPLY,{parameterNames:false}),
    modelFixture('@Bean Mode produces(Mode mode){return null;}')
  ];
  cases[5].injection=cases[5].model.injections.find(item=>item.name==='directMode');
  assert.ok(cases.every(item=>item.injection));
  for(const {model,injection} of cases)assert.deepEqual(candidateChoices(model,injection),[]);
});

test('naming aliases and eligibility are rechecked before any insertion',()=>{
  const excluded=modelFixture('Consumer(Mode mode){}',SUPPLY.replace('@Bean("fastMode")','@Bean(name="fastMode", autowireCandidate=false)'));
  assert.equal(excluded.injection.resolution.state,'resolved');
  assert.deepEqual(candidateChoices(excluded.model,excluded.injection),[]);
  const scoped=modelFixture('Consumer(Mode mode){}',SUPPLY+' @Bean(name="hidden",defaultCandidate=false) @Qualifier("fast-read") Mode third(){return null;}');
  const choices=candidateChoices(scoped.model,scoped.injection);
  assert.deepEqual(choices.map(item=>item.qualifier),['fastMode','directMode']);
  assert.throws(()=>prepareQualifier(scoped.model,scoped.input,{uri:URI,injectionId:scoped.injection.id,...choices[0],qualifier:'fast-read'}),/no longer uniquely/);
  const alternate={...scoped.input,java:scoped.input.java.map(file=>file.uri===BEANS?{...file,text:file.text+'\n// edited'}:file)};
  assert.notEqual(snapshotFingerprint(scoped.input),snapshotFingerprint(alternate));
});

test('the Quick Fix opens a read-only diff and applies only after explicit review',async()=>{
  const {input,model,injection}=modelFixture();
  const registrations=new Map(),diffs=[];
  let codeProvider,previewProvider,updates=0,accepted;
  const uri=value=>({scheme:value.split(':')[0],path:new URL(value).pathname,toString:()=>value});
  class Range{
    constructor(startLine,startCharacter,endLine,endCharacter){
      this.start={line:startLine,character:startCharacter};this.end={line:endLine,character:endCharacter};
    }
    isEqual(other){return JSON.stringify(this)===JSON.stringify(other);}
    intersection(other){return this.isEqual(other)?this:undefined;}
  }
  const disposable=()=>({dispose(){}});
  const document={uri:uri(URI),version:1,languageId:'java',getText:()=>input.java[0].text,positionAt:offset=>offset};
  const vscode={Range,FileType:{SymbolicLink:64},Uri:{parse:uri,from:item=>uri(item.scheme+':'+item.path)},
    DiagnosticSeverity:{Warning:1},Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},
    CodeActionKind:{QuickFix:'quickfix'},CodeAction:class{constructor(title,kind){Object.assign(this,{title,kind});}},
    WorkspaceEdit:class{insert(file,offset,text){Object.assign(this,{file,offset,text});}},
    workspace:{isTrusted:true,getWorkspaceFolder:()=>({}),fs:{stat:async()=>({type:1})},openTextDocument:async()=>document,
      registerTextDocumentContentProvider(_scheme,provider){previewProvider=provider;return disposable();},
      async applyEdit(edit){
        assert.equal(edit.file,document.uri);
        input.java[0].text=document.getText().slice(0,edit.offset)+edit.text+document.getText().slice(edit.offset);
        document.version++;updates++;return true;
      }},
    languages:{registerCodeActionsProvider(_selector,provider){codeProvider=provider;return disposable();}},
    commands:{registerCommand(name,action){registrations.set(name,action);return disposable();},
      async executeCommand(name,left,right){assert.equal(name,'vscode.diff');diffs.push({left,right});assert.match(previewProvider.provideTextDocumentContent(right),/@org\.springframework/);}},
    window:{async showWarningMessage(){return accepted;},async showErrorMessage(message){throw new Error(message);}}};
  const refresh=async()=>analyzeSpring(input.java,input.properties,input.options);
  const api=registerAutowiringFix(vscode,{analyze:refresh,refresh,enabled:()=>true,inputsFor:()=>input,output:{appendLine(){}}});
  try{
    const range=new Range(injection.range.start.line,injection.range.start.character,injection.range.end.line,injection.range.end.character);
    const actions=await codeProvider.provideCodeActions(document,range,{diagnostics:[{source:'Rocketbrain Spring (local model)',code:'spring.bean.ambiguous',range}]},{});
    assert.equal(actions.length,2);
    assert.ok(actions.every(action=>!action.edit&&action.command.command===PREVIEW));
    const direct=await codeProvider.provideCodeActions(document,range,{diagnostics:[]},{});
    assert.deepEqual(direct.map(action=>action.command),actions.map(action=>action.command));
    assert.ok(direct.every(action=>action.diagnostics[0]?.code==='spring.bean.ambiguous'));
    assert.deepEqual(await codeProvider.provideCodeActions(document,new Range(0,0,0,0),{diagnostics:[]},{}),[]);
    const [request]=actions[0].command.arguments;
    accepted=undefined; await registrations.get(PREVIEW)(request);
    assert.equal(updates,0);
    accepted='Apply Qualifier';const applied=await registrations.get(PREVIEW)(request);
    assert.equal(applied.applied,true);
    assert.equal(updates,1);
    assert.match(document.getText(),/@org\.springframework\.beans\.factory\.annotation\.Qualifier\("fast-read"\) Mode mode/);
    assert.equal(diffs.length,2);
    await assert.rejects(api.apply(applied.id),/expired/);
  }finally{api.dispose();}
});
