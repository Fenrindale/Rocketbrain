'use strict';
const crypto = require('node:crypto');
const {ObserverClient,ObserverError,emptySnapshot} = require('./observer-client');
const {validateRuntimeUrl} = require('../spring/runtime-client');

function registerObserver(context,vscode,output,{source}) {
  const events = new vscode.EventEmitter(), subscriptions=[events];
  let current=emptySnapshot(), client, generation=0, snapshotRequest=0, validationRequest=0, disposed=false;
  const snapshot=()=>structuredClone(current);
  const emit=()=>{if(!disposed)events.fire(snapshot());};
  function disconnect(){generation++;snapshotRequest++;client?.dispose();client=undefined;current=emptySnapshot();emit();return snapshot();}
  function trusted(){if(disposed)throw new ObserverError('DISPOSED','Observer is closed.');if(!vscode.workspace.isTrusted){disconnect();throw new ObserverError('UNTRUSTED','Trust the workspace before connecting to a provider observer.');}}
  async function inputs(){
    const url=await vscode.window.showInputBox({title:'Connect JPA provider observer',prompt:'Use the loopback URL from your explicitly enabled Java agent',value:current.baseUrl||'http://127.0.0.1:8081',ignoreFocusOut:true});
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
    const candidate=new ObserverClient(input),epoch=++generation,request=++snapshotRequest;client?.dispose();client=candidate;
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
  const command=(name,action)=>subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await action(...args);}catch(error){output.appendLine('JPA observer: '+error.message);await vscode.window.showErrorMessage(error.message);}}));
  command('rocketbrain.jpa.observer.connect',()=>connect());command('rocketbrain.jpa.observer.refresh',refresh);command('rocketbrain.jpa.observer.disconnect',disconnect);command('rocketbrain.jpa.observer.validate',validateSelection);
  command('rocketbrain.jpa.observer.inspect',async()=>{const report={snapshot:snapshot(),comparison:await compareSource()};const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(report,null,2)});await vscode.window.showTextDocument(doc,{preview:true});return report;});
  command('rocketbrain.jpa.observer.prepare',async()=>{trusted();const result=await require('./observer-install').prepareObserver(context,vscode);const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});await vscode.window.showTextDocument(doc,{preview:true});return result;});
  return {snapshot,connect,refresh,disconnect,validate,compareSource,onDidChange:events.event,dispose(){disposed=true;disconnect();for(const sub of subscriptions)sub.dispose();}};
}
module.exports={registerObserver};
