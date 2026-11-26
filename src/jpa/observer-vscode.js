'use strict';
const crypto = require('node:crypto');
const {ObserverClient,ObserverError,emptySnapshot} = require('./observer-client');
const {validateRuntimeUrl} = require('../spring/runtime-client');
const {summarizePerformance} = require('./fetch-performance');
const { attributeTarget, observedPropertyPaths } = require('./attribute-binding');
const {registerJpaConsole} = require('./console-vscode');
const {registerSecurityTrace} = require('../spring/security-trace-vscode');
const {registerReactiveSecurityTrace} = require('../spring/reactive-security-trace-vscode');
const {registerFeignContracts}=require('../spring/feign-contract-trace-vscode');

function registerObserver(context,vscode,output,{source}) {
  const events = new vscode.EventEmitter(), subscriptions=[events];
  let current=emptySnapshot(), client, generation=0, snapshotRequest=0, validationRequest=0, disposed=false, consoleView,securityView,reactiveSecurityView,feignView;
  const snapshot=()=>structuredClone(current);
  const performance=()=>summarizePerformance(current.performance);
  const emit=()=>{if(!disposed)events.fire(snapshot());};
  function clearViews(){consoleView?.clear();securityView?.close();reactiveSecurityView?.close();feignView?.close();}
  function disconnect(){generation++;snapshotRequest++;client?.dispose();clearViews();client=undefined;current=emptySnapshot();emit();return snapshot();}
  function trusted(){if(disposed)throw new ObserverError('DISPOSED','Observer is closed.');if(!vscode.workspace.isTrusted){disconnect();throw new ObserverError('UNTRUSTED','Trust the workspace before connecting to a provider observer.');}}
  async function inputs(){
    const url=await vscode.window.showInputBox({title:'Connect Local JVM Observer',prompt:'Use the loopback URL from your explicitly enabled Java agent',value:current.baseUrl||'http://127.0.0.1:8081',ignoreFocusOut:true});
    if(url===undefined)return;
    const canonical=validateRuntimeUrl(url).url.toString();
    const workspace=(vscode.workspace.workspaceFolders||[]).map(f=>f.uri.toString()).join('|');
    const secretId='rocketbrain.jpa.observer.'+crypto.createHash('sha256').update(workspace+'\0'+canonical).digest('hex');
    const saved=await context.secrets.get(secretId);
    const token=await vscode.window.showInputBox({title:'Private JPA observer token',prompt:'Stored in VS Code Secret Storage for this workspace and URL',password:true,value:saved||'',ignoreFocusOut:true});
    if(token===undefined)return;
    return {url:canonical,token,secretId};
  }
  async function connect(options){
    trusted();const input=options||await inputs();if(!input)return snapshot();trusted();
    const candidate=new ObserverClient(input),epoch=++generation,request=++snapshotRequest;client?.dispose();clearViews();client=candidate;
    current={...emptySnapshot(),state:'connecting',baseUrl:validateRuntimeUrl(input.url).url.toString()};emit();
    try{
      const observed=await candidate.refresh();if(disposed||epoch!==generation||request!==snapshotRequest)return snapshot();trusted();
      current={...observed,baseUrl:current.baseUrl};emit();
      if(input.secretId)await context.secrets.store(input.secretId,input.token);
      output.appendLine(`JPA observer: ${current.factories.length} live factories, ${current.events.length} observed query events. Runtime and source revisions are not assumed equal.`);
      return snapshot();
    }catch(error){if(epoch===generation){candidate.dispose();client=undefined;current=emptySnapshot();emit();}throw error;}
  }
  async function refresh(){
    trusted();if(!client)throw new ObserverError('NOT_CONNECTED','Connect a JPA observer first.');
    const candidate=client,epoch=generation,request=++snapshotRequest,result=await candidate.refresh();
    if(disposed||epoch!==generation||request!==snapshotRequest)return snapshot();trusted();current={...result,baseUrl:current.baseUrl};emit();return snapshot();
  }
  async function validate(query,factoryId){
    trusted();if(!client)throw new ObserverError('NOT_CONNECTED','Connect a JPA observer first.');
    const candidate=client,epoch=generation,request=++validationRequest,sourceModel=await source(),sourceRevision=sourceModel.revision;
    trusted();if(epoch!==generation||client!==candidate)throw new ObserverError('STALE','The provider connection changed before validation.');
    const result=await candidate.validate(query,factoryId);
    if(disposed||epoch!==generation)throw new ObserverError('STALE','The provider connection changed during validation.');trusted();
    const latest=await source();
    trusted();if(epoch!==generation||client!==candidate)throw new ObserverError('STALE','The provider connection changed during source inspection.');
    if(latest.revision!==sourceRevision)throw new ObserverError('STALE','Source changed during validation. Validate again.');
    const observed={...result,sourceRevision,querySha256:crypto.createHash('sha256').update(query).digest('hex')};
    if(request===validationRequest){current={...current,lastValidation:observed};emit();}return structuredClone(observed);
  }
  async function validateSelection(){
    const model=await source(),editor=vscode.window.activeTextEditor;
    let query=editor&&!editor.selection.isEmpty?editor.document.getText(editor.selection):undefined;
    if(!query){
      const options=model.queries.filter(q=>q.text&&!q.symbolicParameters?.length).map(q=>({label:q.text.slice(0,120),description:q.dynamicResolution?.state||'source',query:q.text}));
      const chosen=await vscode.window.showQuickPick([{label:'Enter a query',query:null},...options],{title:'Validate with running Hibernate · semantic compilation only'});
      if(!chosen)return;query=chosen.query??await vscode.window.showInputBox({title:'Provider query',prompt:'Sent to the running provider compiler. Provider callbacks can run; the observer does not execute SQL.',ignoreFocusOut:true});
    }
    if(query===undefined)return;
    let factoryId;if(current.factories.length>1){const chosen=await vscode.window.showQuickPick(current.factories.map(f=>({label:f.id,description:f.provider+' '+f.version})),{title:'Choose the running persistence factory'});if(!chosen)return;factoryId=chosen.label;}
    const result=await validate(query,factoryId);const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});await vscode.window.showTextDocument(document,{preview:true});return result;
  }
  async function compareSource(){
    trusted();const model=await source(),observed=snapshot();
    const entities=model.entities.map(entity=>({fqn:entity.fqn,sourceTable:entity.table?.physicalName||null,sourceState:entity.status,observations:observed.factories.flatMap(factory=>(factory.entities||[]).filter(e=>e.javaType===entity.fqn).map(e=>({factoryId:factory.id,entity:e})))}));
    return {mode:'source-and-runtime-side-by-side',observedAt:observed.fetchedAt,sourceRevision:model.revision,sameSourceRevisionVerified:false,entities};
  }
  async function inspectAttributeBinding(selection) {
    trusted();
    if (!client) throw new ObserverError('NOT_CONNECTED','Connect a JPA observer first.');
    if (current.capabilities?.attributeBinding !== true) {
      throw new ObserverError('UNSUPPORTED_ATTRIBUTE_BINDING','Start the application with an observer that supports attribute binding inspection.');
    }
    const candidate = client, frame = generation;
    function assertCurrent() {
      trusted();
      if (client !== candidate || generation !== frame) throw new ObserverError('STALE','The observer connection changed during inspection.');
    }
    let target = selection && attributeTarget(selection);
    if (!target) {
      if (!current.factories.length) throw new ObserverError('NO_JPA_FACTORY','Refresh the snapshot after the JPA factory has started.');
      const factory = await vscode.window.showQuickPick(current.factories.map(value => ({
        label: value.factoryName || value.id, description: [value.id, value.provider, value.version].filter(Boolean).join(' · '), value
      })), { title: 'Select a Running JPA Factory' });
      if (!factory) return;
      assertCurrent();
      const entity = await vscode.window.showQuickPick((factory.value.entities || []).filter(value => value.javaType).map(value => ({
        label: value.javaType, description: value.table, value
      })), { title: 'Select a Managed JPA Entity' });
      if (!entity) return;
      assertCurrent();
      const attribute = await vscode.window.showQuickPick(observedPropertyPaths(entity.value).map(([label, description]) => ({
        label, description
      })), { title: 'Inspect JPA Attribute Binding', placeHolder: 'Choose an attribute to inspect its declared type and runtime mapping' });
      if (!attribute) return;
      assertCurrent();
      target = attributeTarget({ factoryId: factory.value.id, entityJavaType: entity.value.javaType, propertyPath: attribute.label });
    }
    const report = await candidate.inspectAttributeBinding(target);
    assertCurrent();
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) + '\n' });
    assertCurrent();
    await vscode.window.showTextDocument(document, { preview: true });
    return report;
  }
  async function inspectPerformance(requestId){
    const frame=generation;
    await refresh();
    if(frame!==generation)throw new ObserverError('STALE_REQUEST','The Hibernate observer connection changed.');
    const report=performance();
    if(!report.requests.length){
      await vscode.window.showInformationMessage(report.state==='disabled'
        ? 'Enable performance in the JPA observer configuration and restart the application.'
        : 'No supported Hibernate request samples have been captured.');
      return report;
    }
    let request=report.requests.find(item=>item.id===requestId);
    if(requestId!==undefined&&!request)throw new ObserverError('STALE_REQUEST','The Hibernate request sample is no longer retained.');
    if(!request){
      const selected=await vscode.window.showQuickPick([...report.requests].reverse().map(item=>({
        label:[item.method,item.route].filter(Boolean).join(' ')||'Hibernate request '+item.id,
        description:item.selectCount+' SELECTs · '+item.suspects.length+' collection fetch finding(s)'+
          (report.bindObservation ? ' · '+item.selects.reduce((count,select)=>count+
            (select.binds?.positions.filter(position=>position.jdbcType).length||0),0)+' typed binds' : ''),
        detail:[item.startedAt,
          item.dispatch==='spring-mvc-callable' ? 'Spring MVC Callable' : item.dispatch==='unattributed' ? 'Unattributed dispatch' : undefined,
          item.coverage==='partial' ? 'Partial observation' : undefined].filter(Boolean).join(' · '),request:item
      })),{title:'Hibernate Fetch Activity'});
      if(!selected)return;
      trusted();
      if(frame!==generation)throw new ObserverError('STALE_REQUEST','The Hibernate observer connection changed.');
      request=performance().requests.find(item=>item.id===selected.request.id&&item.startedAt===selected.request.startedAt);
      if(!request)throw new ObserverError('STALE_REQUEST','The Hibernate request sample is no longer retained.');
    }
    const {requests,...scope}=report;
    const detail={...scope,agentVersion:current.agentVersion,processId:current.processId,request};
    const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(detail,null,2)+'\n'});
    trusted();
    if(frame!==generation)throw new ObserverError('STALE_REQUEST','The Hibernate observer connection changed.');
    await vscode.window.showTextDocument(document,{preview:true});
    return detail;
  }
  function consoleConnection(){
    trusted();
    if(!client)throw new ObserverError('NOT_CONNECTED','Connect to the opted-in Hibernate observer first.');
    if(current.consoleSelectEnabled!==true)throw new ObserverError('CONSOLE_DISABLED','Set consoleSelect to true in the observer configuration, restart the application, and reconnect.');
    if(!current.factories.length)throw new ObserverError('FACTORY_UNAVAILABLE','The observer has no live Hibernate factory yet. Refresh after the application starts.');
    const candidate=client,epoch=generation;
    function assertCurrent(){
      trusted();
      if(epoch!==generation||candidate!==client)throw new ObserverError('STALE','The observer connection changed. Review the query again.');
      if(current.consoleSelectEnabled!==true)throw new ObserverError('CONSOLE_DISABLED','Reconnect to an observer with JPQL console execution enabled.');
    }
    return {client:candidate,factories:structuredClone(current.factories),assertCurrent};
  }
  const command=(name,action)=>subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await action(...args);}catch(error){output.appendLine('JPA observer: '+error.message);await vscode.window.showErrorMessage(error.message);}}));
  consoleView=registerJpaConsole(vscode,{source,target:consoleConnection,command});
  const observerViewOptions={command,target(){
    trusted();if(!client)throw new ObserverError('NOT_CONNECTED','Connect to a local JVM observer first.');
    const candidate=client,epoch=generation;
    return {client:candidate,assertCurrent(){trusted();if(epoch!==generation||client!==candidate)throw new ObserverError('STALE','The observer changed during runtime inspection.');}};
  }};
  securityView=registerSecurityTrace(vscode,observerViewOptions);
  reactiveSecurityView=registerReactiveSecurityTrace(vscode,observerViewOptions);
  feignView=registerFeignContracts(vscode,observerViewOptions);
  command('rocketbrain.jpa.observer.connect',()=>connect());command('rocketbrain.jpa.observer.refresh',refresh);command('rocketbrain.jpa.observer.disconnect',disconnect);command('rocketbrain.jpa.observer.validate',validateSelection);
  command('rocketbrain.jpa.observer.inspect',async()=>{const report={snapshot:snapshot(),comparison:await compareSource()};const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(report,null,2)});await vscode.window.showTextDocument(doc,{preview:true});return report;});
  command('rocketbrain.jpa.observer.inspectPerformance',inspectPerformance);
  command('rocketbrain.jpa.observer.inspectAttributeBinding',inspectAttributeBinding);
  command('rocketbrain.jpa.observer.prepare',async()=>{trusted();const result=await require('./observer-install').prepareObserver(context,vscode);const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});await vscode.window.showTextDocument(doc,{preview:true});return result;});
  return {snapshot,connect,refresh,disconnect,validate,compareSource,performance,inspectAttributeBinding,onDidChange:events.event,dispose(){disposed=true;disconnect();for(const sub of subscriptions)sub.dispose();}};
}
module.exports={registerObserver};
