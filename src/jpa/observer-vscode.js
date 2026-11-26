'use strict';
const crypto = require('node:crypto');
const { workspaceRoots, workspacePath } = require('../java/workbench-model');
const { sourceParameter, sourceMember, readObservedSource } = require('../spring/observed-injection');
const {ObserverClient,ObserverError,emptySnapshot} = require('./observer-client');
const {validateRuntimeUrl} = require('../spring/runtime-client');
const {summarizePerformance} = require('./fetch-performance');
const { attributeTarget, observedPropertyPaths } = require('./attribute-binding');
const { graphName, registeredGraphApplications } = require('./entity-graphs');
const { comparePersistenceBuild } = require('./persistence-contexts');
const {registerJpaConsole} = require('./console-vscode');
const {registerSecurityTrace} = require('../spring/security-trace-vscode');
const {registerTransactionTrace} = require('./transaction-trace-vscode');
const {registerReactiveSecurityTrace} = require('../spring/reactive-security-trace-vscode');
const {registerFeignContracts}=require('../spring/feign-contract-trace-vscode');
const {registerQuarkusConfigOrigins}=require('../java/quarkus-config-origin-vscode');
const {registerArcLookups}=require('../java/quarkus-arc-vscode');

function registerObserver(context,vscode,output,{source}) {
  const events = new vscode.EventEmitter(), subscriptions=[events];
  let current=emptySnapshot(), client, generation=0, snapshotRequest=0, validationRequest=0, disposed=false, consoleView,securityView,reactiveSecurityView,feignView,transactionView,quarkusView,arcView;
  const snapshot=()=>structuredClone(current);
  const performance=()=>summarizePerformance(current.performance);
  const emit=()=>{if(!disposed)events.fire(snapshot());};
  function clearViews(){consoleView?.clear();securityView?.close();reactiveSecurityView?.close();feignView?.close();transactionView?.close();quarkusView?.close();arcView?.close();}
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
  async function chooseObservedInjection(eventId, members=false) {
    trusted();
    if (!client) throw new ObserverError('NOT_CONNECTED','Connect a local JVM observer first.');
    if (current.capabilities?.springAutowireTrace !== true) {
      throw new ObserverError('UNSUPPORTED_INJECTION','Start an observer that supports Spring injection capture.');
    }
    const candidate = client, epoch = generation;
    function assertCurrent() {
      trusted();
      if (candidate!==client || epoch!==generation) throw new ObserverError('STALE','The observer connection changed during inspection.');
    }
    const fetchTrace=()=>members?candidate.observedMemberInjection():candidate.observedInjection();
    const trace = await fetchTrace();
    assertCurrent();
    if (trace.processId!==current.processId) throw new ObserverError('STALE','The JVM process changed. Reconnect before inspecting.');
    if (!trace.events.length && eventId===undefined) {
      await vscode.window.showInformationMessage(trace.state === 'disabled'
        ? 'Enable springAutowireTrace and its application packages in the agent startup configuration.'
        : members?'No supported Spring field or method parameter resolutions have been captured.':
          'No supported Spring constructor resolutions have been captured.');
      return;
    }
    let event = trace.events.find(value=>value.id===eventId);
    if (eventId!==undefined && !event) throw new ObserverError('STALE','The injection resolution is no longer retained.');
    if (!event) {
      const item = await vscode.window.showQuickPick([...trace.events].reverse().map(value=>({
        label:value.site.owner+' · '+(members?value.site.member+(value.site.kind==='method'?' / '+(value.site.parameterName||
          'parameter '+(value.site.parameterIndex+1)):''):(value.site.parameterName||'parameter '+(value.site.parameterIndex+1))),
        description:[value.state,value.selectedBean||value.selectedBeans?.join(', '),value.context.id,value.context.key].filter(Boolean).join(' · '), value
      })), {title:members?'Observed Spring Field and Method Injection':'Observed Spring Constructor Injection'});
      if (!item) return;
      assertCurrent();
      event=item.value;
    }
    return { fetchTrace,trace,event,assertCurrent };
  }
  async function inspectObservedInjection(eventId,members=false) {
    const selection = await chooseObservedInjection(eventId,members);
    if (!selection) return;
    const {trace,event,assertCurrent}=selection;
    const {events,...metadata}=trace;
    const report={...metadata,event};
    const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(report,null,2)+'\n'});
    assertCurrent();
    await vscode.window.showTextDocument(document,{preview:true});
    return report;
  }
  async function openObservedInjectionSource(options,members=false) {
    const selection=await chooseObservedInjection(options?.eventId,members);
    if (!selection) return;
    const {fetchTrace,trace,event,assertCurrent}=selection;
    const uri=options?.sourceUri??(await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,
      canSelectMany:false,filters:{Java:['java']},openLabel:members?'Choose the Injection Source':'Choose the Constructor Source'}))?.[0];
    if (!uri) return;
    assertCurrent();
    if (uri.scheme!=='file' || !uri.fsPath.endsWith('.java')) throw new ObserverError('INVALID_SOURCE','Choose a local Java source file.');
    const file=workspacePath(uri.toString(),workspaceRoots(vscode.workspace.workspaceFolders||[]),{directory:false});
    const saved=await readObservedSource(file);
    const document=await vscode.workspace.openTextDocument(uri);
    if (document.isDirty||document.isClosed||document.languageId!=='java'||document.getText()!==saved.text) {
      throw new ObserverError('INVALID_SOURCE','Save or reload the Java source before navigating.');
    }
    const locate=members?sourceMember:sourceParameter;
    const matched=locate({uri:uri.toString(),text:saved.text},event.site);
    if (!matched) throw new ObserverError('UNPROVED_SOURCE',members?'The selected file has no unique matching injection declaration.':
      'The selected file has no unique matching constructor and parameter.');
    const version=document.version;
    const latest=await fetchTrace();
    const rechecked=await readObservedSource(file);
    assertCurrent();
    if (latest.processId!==trace.processId||!latest.events.some(value=>value.id===event.id)||
        rechecked.sha256!==saved.sha256||document.isClosed||document.isDirty||document.version!==version||
        workspacePath(uri.toString(),workspaceRoots(vscode.workspace.workspaceFolders||[]),{directory:false})!==file) {
      throw new ObserverError('STALE','The injection evidence or source changed. Inspect it again.');
    }
    const range=new vscode.Range(document.positionAt(matched.start),document.positionAt(matched.end));
    await vscode.window.showTextDocument(document,{selection:range,preview:false});
    return {eventId:event.id,uri,...(event.site.kind==='field'?{field:matched.name}:{parameter:matched.name}),range,sameSourceRevisionVerified:false};
  }
  async function inspectPersistenceContexts(options, compare = false) {
    trusted();
    if (!client) throw new ObserverError('NOT_CONNECTED','Connect a local JPA observer first.');
    if (current.capabilities?.springPersistenceContexts !== true) {
      throw new ObserverError('UNSUPPORTED_CONTEXTS','Start the application with an observer that supports Spring persistence contexts.');
    }
    const candidate = client, frame = generation;
    function assertCurrent() {
      trusted();
      if (client !== candidate || generation !== frame) throw new ObserverError('STALE','The observer connection changed during inspection.');
    }
    let report = await candidate.persistenceContexts();
    assertCurrent();
    if (current.processId !== report.processId) throw new ObserverError('STALE_CONTEXT','The JVM process changed. Reconnect before inspecting.');
    const factories = report.contexts.flatMap(context => context.factories.filter(factory => factory.build.state === 'known').map(factory => ({
      label: factory.persistenceUnit, description: [context.id,context.key,factory.factoryId].filter(Boolean).join(' · '), contextKey:context.key, factory
    })));
    if (compare) {
      if (!factories.length) throw new ObserverError('NO_BUILD_PROOF','No persistence unit has a complete captured build fingerprint.');
      const selected = options ? factories.find(option => option.factory.factoryId === options.factoryId) :
        await vscode.window.showQuickPick(factories,{title:'Select a Spring Persistence Unit to Compare'});
      if (!selected) {
        if (options) throw new ObserverError('UNKNOWN_FACTORY','Select a factory with an observed managed build fingerprint.');
        return;
      }
      assertCurrent();
      const folder = options?.directory ?? (await vscode.window.showOpenDialog({ canSelectFiles:false, canSelectFolders:true,
        canSelectMany:false, openLabel:'Compare Compiled Output Directory' }))?.[0];
      if (!folder) return;
      assertCurrent();
      const comparison = await comparePersistenceBuild(selected.factory.build,folder,vscode.workspace.workspaceFolders);
      assertCurrent();
      const latest = await candidate.persistenceContexts();
      assertCurrent();
      const owner = latest.contexts.find(context => context.key === selected.contextKey);
      const matched = owner?.factories.find(factory => factory.factoryId === selected.factory.factoryId);
      if (latest.processId !== report.processId || matched?.build.fingerprint !== selected.factory.build.fingerprint) {
        throw new ObserverError('STALE_CONTEXT','The selected Spring persistence unit changed during comparison.');
      }
      report = { ...latest, comparison:{ factoryId:selected.factory.factoryId, ...comparison } };
    }
    const doc = await vscode.workspace.openTextDocument({ language:'json',content:JSON.stringify(report,null,2)+'\n' });
    assertCurrent();
    await vscode.window.showTextDocument(doc,{preview:true});
    return report;
  }
  async function inspectEntityGraph(selection) {
    trusted();
    if (!client) throw new ObserverError('NOT_CONNECTED','Connect a JPA observer first.');
    if (current.capabilities?.entityGraphs !== true) {
      throw new ObserverError('UNSUPPORTED_ENTITY_GRAPHS','Start the application with an observer that supports named JPA entity graphs.');
    }
    const candidate = client, frame = generation;
    function assertCurrent() {
      trusted();
      if (client !== candidate || generation !== frame) throw new ObserverError('STALE','The observer connection changed during inspection.');
    }
    let factoryId = selection?.factoryId, name = selection?.name;
    if (!selection) {
      if (!current.factories.length) throw new ObserverError('NO_JPA_FACTORY','Refresh the snapshot after the JPA factory has started.');
      const factory = await vscode.window.showQuickPick(current.factories.map(value => ({
        label: value.factoryName || value.id, description: [value.id, value.provider, value.version].filter(Boolean).join(' · '), value: value.id
      })), { title: 'Select a Running JPA Factory' });
      if (!factory) return;
      assertCurrent();
      factoryId = factory.value;
    } else if (name !== undefined && !graphName(name)) {
      throw new ObserverError('INVALID_ENTITY_GRAPH','Select a named entity graph from this factory.');
    }
    const registry = await candidate.entityGraphs(factoryId);
    assertCurrent();
    if (!name && registry.state !== 'unknown') {
      const options = registry.graphs.map(graph => ({
        label: graph.name, description: graph.rootJavaType, name: graph.name,
        detail: graph.paths.length + ' registered paths' + (graph.complete ? '' : ' · partial')
      }));
      const chosen = await vscode.window.showQuickPick([...options,
        { label: 'Check an Expected Graph Name', detail: 'Show whether it is registered in this running factory' }
      ], { title: 'Inspect JPA Entity Graph' });
      if (!chosen) return;
      assertCurrent();
      name = chosen.name ?? await vscode.window.showInputBox({
        title: 'Check an Expected Graph Name', prompt: 'Enter the exact graph name used by the application',
        validateInput: value => graphName(value) ? undefined : 'Enter a bounded JPA graph name.'
      });
      if (name === undefined) return;
      assertCurrent();
      if (!graphName(name)) throw new ObserverError('INVALID_ENTITY_GRAPH','Select a named entity graph from this factory.');
    }
    const graph = registry.graphs.find(value => value.name === name);
    let registration = 'unavailable';
    if (graph) registration = graph.complete ? 'observed' : 'partial';
    else if (name && registry.state === 'observed') registration = 'absent';
    const report = { factoryId: registry.factoryId, registryState: registry.state, registration,
      ...(name && { name }), ...(registry.reason && { reason: registry.reason }),
      ...(graph && { graph }), observerExecutedSql: false, applicationCallbacksInvoked: false, valuesRetained: false,
      performanceCapture: registry.activity?.state ?? 'unavailable',
      retainedApplications: graph ? registeredGraphApplications(registry, graph) : [] };
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) + '\n' });
    assertCurrent();
    await vscode.window.showTextDocument(doc, { preview: true });
    return report;
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
  transactionView=registerTransactionTrace(vscode,observerViewOptions);
  quarkusView=registerQuarkusConfigOrigins(vscode,{command,target(){
    const connection=observerViewOptions.target(), processId=current.processId;
    return {assertCurrent:connection.assertCurrent,client:{async quarkusConfigOrigins(){
      const report=await connection.client.quarkusConfigOrigins();
      connection.assertCurrent();
      if(report.processId!==processId)throw new ObserverError('STALE','The Quarkus JVM changed. Reconnect before inspecting configuration origins.');
      return report;
    }}};
  }});
  arcView=registerArcLookups(vscode,{command,target(){
    const connection=observerViewOptions.target(), processId=current.processId;
    return {assertCurrent:connection.assertCurrent,client:{async quarkusArcLookups(){
      const report=await connection.client.quarkusArcLookups();
      connection.assertCurrent();
      if(report.processId!==processId)throw new ObserverError('STALE','The Quarkus JVM changed. Reconnect before inspecting Arc lookups.');
      return report;
    }}};
  }});
  command('rocketbrain.jpa.observer.connect',()=>connect());command('rocketbrain.jpa.observer.refresh',refresh);command('rocketbrain.jpa.observer.disconnect',disconnect);command('rocketbrain.jpa.observer.validate',validateSelection);
  command('rocketbrain.jpa.observer.inspect',async()=>{const report={snapshot:snapshot(),comparison:await compareSource()};const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(report,null,2)});await vscode.window.showTextDocument(doc,{preview:true});return report;});
  command('rocketbrain.jpa.observer.inspectPerformance',inspectPerformance);
  command('rocketbrain.jpa.observer.inspectAttributeBinding',inspectAttributeBinding);
  command('rocketbrain.jpa.observer.inspectEntityGraph',inspectEntityGraph);
  command('rocketbrain.jpa.observer.inspectPersistenceContexts',()=>inspectPersistenceContexts());
  command('rocketbrain.jpa.observer.inspectObservedInjection',inspectObservedInjection);
  command('rocketbrain.jpa.observer.openObservedInjectionSource',openObservedInjectionSource);
  command('rocketbrain.jpa.observer.inspectObservedMemberInjection',eventId=>inspectObservedInjection(eventId,true));
  command('rocketbrain.jpa.observer.openObservedMemberSource',options=>openObservedInjectionSource(options,true));
  command('rocketbrain.jpa.observer.comparePersistenceBuild',options=>inspectPersistenceContexts(options,true));
  command('rocketbrain.jpa.observer.prepare',async()=>{trusted();const result=await require('./observer-install').prepareObserver(context,vscode);const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});await vscode.window.showTextDocument(doc,{preview:true});return result;});
  return {snapshot,connect,refresh,disconnect,validate,compareSource,performance,inspectAttributeBinding,inspectEntityGraph,inspectPersistenceContexts,inspectObservedInjection,openObservedInjectionSource,onDidChange:events.event,dispose(){disposed=true;disconnect();for(const sub of subscriptions)sub.dispose();}};
}
module.exports={registerObserver};
