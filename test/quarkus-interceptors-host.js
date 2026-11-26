'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {ObserverClient}=require('../src/jpa/observer-client');
const {arcObservedMethodSource}=require('../src/java/quarkus-arc-lookups');
const {renderArcInterceptors}=require('../src/java/quarkus-interceptors-vscode');
const {database,boot}=require('./quarkus-arc-host');
const {importedSpring}=require('./java-source-analysis-host');

const packages=['fixture.interceptor'];
const root=path.join(__dirname,'fixtures/java/quarkus-arc-app/src/main/java/fixture/interceptor');
const view='rocketbrain.quarkus.inspectInterceptors', open='rocketbrain.quarkus.openInterceptorSource';
const title='Quarkus CDI Interceptors';
const around='jakarta.interceptor.AroundInvoke';
const returns='Ljava/lang/String;';
const callback='(Ljakarta/interceptor/InvocationContext;)Ljava/lang/Object;';

async function verify(application) {
  const {http,observer,pid}=application, client=new ObserverClient(observer);
  const endpoint=observer.url+'/quarkus-arc-interceptors', headers={Authorization:'Bearer '+observer.token};
  try {
    assert.equal(await http('/jdbc'),'2');
    assert.equal((await fetch(endpoint,{signal:AbortSignal.timeout(2500)})).status,401);
    assert.equal((await fetch(endpoint,{method:'POST',headers,signal:AbortSignal.timeout(2500)})).status,405);
    assert.equal((await fetch(endpoint+'?replay=1',{headers,signal:AbortSignal.timeout(2500)})).status,400);
    const before=await client.quarkusArcInterceptors();
    assert.equal(before.processId,pid);
    assert.deepEqual(before.packages,packages);
    assert.deepEqual(before.invocations,[]);
    assert.equal(await http('/interceptor/plain'),'plain');
    assert.deepEqual((await client.quarkusArcInterceptors()).invocations,[]);
    for(const [route,body] of [['text','first(second(string:24))'],['number','first(int:7)'],['blocked','stopped'],['failure','caught']])
      assert.equal(await http('/interceptor/'+route),body);
    const report=await client.quarkusArcInterceptors();
    assert.equal(report.state,'ready',JSON.stringify({report,warnings:(await client.refresh()).warnings}));
    assert.equal(report.invocations.length,4);
    const [full,number,stopped,failed]=report.invocations;
    assert.deepEqual(report.invocations.map(event=>event.target),[
      {owner:'fixture.interceptor.TracedService',member:'render',descriptor:'(Ljava/lang/String;)'+returns},
      {owner:'fixture.interceptor.TracedService',member:'render',descriptor:'(I)'+returns},
      {owner:'fixture.interceptor.TracedService',member:'blocked',descriptor:'()'+returns},
      {owner:'fixture.interceptor.TracedService',member:'failure',descriptor:'()'+returns}
    ]);
    assert.deepEqual(report.invocations.map(event=>event.bindingTypes),[
      ['fixture.interceptor.Audited','fixture.interceptor.Detailed'],['fixture.interceptor.Audited'],
      ['fixture.interceptor.Audited','fixture.interceptor.Detailed'],['fixture.interceptor.Audited']
    ]);
    const source=(name,priority)=>({kind:'source',target:{owner:'fixture.interceptor.'+name,member:'around',descriptor:callback},priority});
    const first=source('AuditFirst',100), second=source('AuditSecond',200), stop=source('AuditStop',50), later=source('AuditLater',250);
    assert.deepEqual(report.invocations.map(event=>event.configured),[[first,second],[first],[stop,later],[first]]);
    assert.deepEqual([full.entered,number.entered,stopped.entered,failed.entered],[[0,1],[0],[0],[0]]);
    assert.deepEqual(report.invocations.map(event=>event.outcome),['returned','returned','returned','threw']);
    for(const event of report.invocations){
      const sourceText=await fs.readFile(path.join(root,'TracedService.java'),'utf8');
      const matched=arcObservedMethodSource({text:sourceText},event.target);
      assert.ok(matched);
      assert.equal(sourceText.slice(matched.start,matched.end),event.target.member);
      for(const entry of event.configured){
        const text=await fs.readFile(path.join(root,entry.target.owner.split('.').at(-1)+'.java'),'utf8');
        assert.equal(arcObservedMethodSource({text},entry.target,around)?.name,'around');
        assert.equal(arcObservedMethodSource({text:text.replace('@AroundInvoke','')},entry.target,around),undefined);
      }
    }
    assert.deepEqual(await client.quarkusArcInterceptors(),report);
    assert.equal(await http('/interceptor/foreign'),'foreign(target)');
    const partial=await client.quarkusArcInterceptors(), foreign=partial.invocations.at(-1);
    assert.equal(partial.state,'partial');
    assert.equal(foreign.target.member,'foreign');
    assert.deepEqual(foreign.configured,[{kind:'unresolved'}]);
    assert.deepEqual(foreign.entered,[0]);
    const html=renderArcInterceptors(partial);
    assert.match(html,/Quarkus CDI Interceptors/u);
    assert.match(html,/Source and priority unavailable/u);
    assert.match(html,/AuditSecond#around.*200/u);
    for(const payload of [JSON.stringify(partial),html])assert.doesNotMatch(payload,/fixture-private-|AuditForeign|SELECT COUNT|rocketbrain_fixture/u);
    return {report:partial,verified:{methodTargets:4,annotationBindingsObserved:true,actualArCInvocation:true,
      effectivePriorities:[100,200,50,250],overloadsDistinguished:true,nonbindingValueResolved:true,
      stoppedLaterEntryNotObserved:true,thrownOutcomeObserved:true,outsidePackageUnresolved:true,
      callbackDeclarationsVerified:true,noApplicationValuesRetained:true,httpInspectionDidNotRunApplication:true,jdbcRows:2}};
  }finally{client.dispose();}
}

async function defaultOff(db) {
  await boot(db,'yes',false,async application=>{
    const client=new ObserverClient(application.observer);
    try{
      assert.equal(await application.http('/interceptor/text'),'first(second(string:24))');
      assert.deepEqual(await client.quarkusArcInterceptors(),{state:'disabled',processId:application.pid,packages:[],invocations:[],
        bindingValuesRetained:false,argumentsRetained:false,inspectionInvokedApplication:false});
    }finally{client.dispose();}
  });
}

async function headless() {
  const db=await database();
  const result=await boot(db,'yes',false,verify,{interceptorPackages:packages});
  await defaultOff(db);
  return {engine:db.engine,databaseVersion:db.version,quarkusVersion:'3.40.1.2',springJdbc:db.jdbc,observerVersion:'0.15.0',
    verified:result.verified,defaultOff:true,nativeView:false};
}

async function runQuarkusInterceptorsChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const binaries=['TracedService','AuditFirst'], copies=new Map();
  try {
    for(const binary of binaries){
      const copy=path.join(workspace,'RbArcSource-'+randomUUID()+'.java');
      await fs.copyFile(path.join(root,binary+'.java'),copy,constants.COPYFILE_EXCL);
      copies.set(binary,copy);
    }
    const db=await database();
    const prepared=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(prepared.quarkusInterceptorsEnabled,false);
    assert.deepEqual(JSON.parse(await fs.readFile(prepared.configFile,'utf8')).quarkusInterceptorPackages,[]);
    return await boot(db,'yes',false,async application=>{
      const {verified}=await verify(application);
      await api.jpa.observer.connect(application.observer);
      const shown=await vscode.commands.executeCommand(view);
      assert.equal(shown.view,view);
      const deadline=Date.now()+5000;
      while(Date.now()<deadline&&!vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title)))await delay(50);
      assert.ok(vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title)));
      const first=shown.invocations[0];
      for(const [binary,member,chainIndex] of [['TracedService','render',undefined],['AuditFirst','around',0]]){
        const sourceUri=vscode.Uri.file(copies.get(binary));
        const source=await vscode.commands.executeCommand(open,{eventId:first.id,chainIndex,sourceUri});
        assert.equal(source?.member,member);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),sourceUri.toString());
        assert.equal(vscode.window.activeTextEditor.document.getText(source.range),member);
      }
      checks.push('Installed Quarkus interceptor view displayed the configured and executed chain and opened its exact saved Java method and callback.');
      return {engine:db.engine,databaseVersion:db.version,verified,nativeView:true,sourceTargets:2,defaultOff:true};
    },{interceptorPackages:packages});
  }finally{
    api.jpa.observer.disconnect();
    const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input?.uri?.scheme==='file'&&
      [...copies.values()].includes(tab.input.uri.fsPath));
    if(tabs.length)await vscode.window.tabGroups.close(tabs);
    for(const file of copies.values())await fs.unlink(file);
  }
}

module.exports={runQuarkusInterceptorsChecks};
if(require.main===module)headless().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
