'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const {resolveTestingProjects,inside}=require('./testing-projects');
const {createTestDebugger}=require('./testing-debug');

function registerJavaTesting(context,vscode,{java,backend}={}) {
  const controller=vscode.tests.createTestController('rocketbrain-java-tests','Rocketbrain Java Tests');
  const channel=vscode.window.createOutputChannel('Rocketbrain Java Tests');
  const subscriptions=[controller,channel],items=new Map(),projects=new Map(),failed=new Set(),coverageDetails=new WeakMap();
  const operations=new Set(),testDebugger=createTestDebugger(vscode,{java});
  let generation=0,dirty=true,disposed=false,busy=false,activeCancellation,lastReport=null;
  const engine=()=>backend||require('./testing');
  const trusted=()=>{if(disposed)throw new Error('Java testing is closed.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before loading or executing Java tests.');};
  const itemId=(project,id)=>JSON.stringify([project.id,id]);
  const snapshot=()=>({state:disposed?'closed':busy?'running':dirty?'stale':'ready',projects:[...projects.values()].map(p=>({id:p.id,label:p.label,workspace:p.workspace,framework:p.framework||'junit'})),tests:[...items.values()].map(({data,item,project})=>({...data,nativeId:item.id,projectId:project.id,framework:project.framework||'junit'})),lastReport:lastReport?structuredClone(lastReport):null});
  function markDirty(){generation++;dirty=true;}
  function upsert(project,data){
    if(!data||typeof data.id!=='string')return;
    const id=itemId(project,data.id),existing=items.get(id);if(existing)return existing.item;
    if(items.size>=15000)throw new Error('The native test tree is limited to 15000 entries. Narrow the project configuration.');
    const uri=data.uri?vscode.Uri.parse(data.uri):undefined;
    const safeUri=uri?.scheme==='file'&&vscode.workspace.getWorkspaceFolder(uri)?uri:undefined;
    const item=controller.createTestItem(id,data.label||data.methodName||data.className||data.id,safeUri);
    if(safeUri&&Number.isInteger(data.line)&&data.line>=0)item.range=new vscode.Range(data.line,0,data.line,0);
    const parent=data.parentId?items.get(itemId(project,data.parentId))?.item:undefined;
    (parent?.children||project.root.children).add(item);
    const record={item,data,project};items.set(id,record);return item;
  }
  async function bounded(action,cancellation,timeout=120000){
    let timer;try{return await Promise.race([action(cancellation.token),new Promise((_,reject)=>{timer=setTimeout(()=>{cancellation.cancel();reject(new Error('Java test preparation timed out. Check project import and build output.'));},timeout);})]);}finally{clearTimeout(timer);}
  }
  function assertSaved(resolved){
    if(vscode.workspace.textDocuments.some(d=>d.languageId==='java'&&d.isDirty&&resolved.some(p=>inside(p.workspace,d.uri.fsPath))))throw new Error('Save the Java source files before discovering or running compiled tests.');
  }
  async function discoverImpl(options={}){
    trusted();if(busy)throw new Error('Wait for the current Java test operation or cancel it.');busy=true;dirty=true;
    const cancellation=new vscode.CancellationTokenSource();activeCancellation=cancellation;
    const external=options.cancellation?.onCancellationRequested(()=>cancellation.cancel());
    const before=generation;
    try{
      const unsaved=vscode.workspace.textDocuments.filter(d=>d.languageId==='java'&&d.isDirty);
      if(unsaved.length)throw new Error('Save Java sources before discovering compiled tests: '+unsaved.slice(0,3).map(d=>path.basename(d.uri.fsPath||d.uri.toString())).join(', '));
      if(options.build!==false&&java?.buildWorkspace)await bounded(token=>java.buildWorkspace(token,{refreshTestSources:true}),cancellation);
      const resolved=await bounded(token=>resolveTestingProjects(context,vscode,java,options.projects,token),cancellation);
      assertSaved(resolved);trusted();
      const results=[];
      for(const project of resolved){trusted();const result=await engine().discoverTests(project,{cancellation:cancellation.token});if(result.state==='cancelled'||cancellation.token.isCancellationRequested)throw new Error('Java test discovery cancelled.');if(result.state!=='completed')throw new Error(result.errors?.[0]?.message||'Java test discovery did not complete. Check the runner output.');results.push({project,result});}
      if(generation!==before||cancellation.token.isCancellationRequested)throw new Error('Java sources or configuration changed during discovery. Discover again.');trusted();
      if(results.reduce((count,value)=>count+(value.result.tests?.length||0),0)>15000)throw new Error('The native test tree is limited to 15000 entries. Narrow the project configuration.');
      controller.items.replace([]);items.clear();projects.clear();
      for(const {project,result} of results){
        const root=controller.createTestItem('project:'+crypto.createHash('sha256').update(project.id).digest('hex'),project.label,vscode.Uri.file(project.workspace));project.root=root;controller.items.add(root);projects.set(project.id,project);
        for(const test of result.tests||[])upsert(project,test);
      }
      dirty=false;return snapshot();
    }finally{external?.dispose();cancellation.dispose();activeCancellation=undefined;busy=false;}
  }
  function track(work){operations.add(work);void work.finally(()=>operations.delete(work)).catch(()=>{});return work;}
  function discover(options={}){return track(discoverImpl(options));}
  function descendants(item){const result=[];item.children.forEach(child=>{result.push(child,...descendants(child));});return result;}
  function selectedProjects(request){
    const selected=new Map(),excludes=request.exclude||[];
    if(Array.isArray(request.include)&&request.include.length===0)return selected;
    for(const project of projects.values()){
      const includes=request.include?.length?request.include.filter(item=>item.id===project.root.id||items.get(item.id)?.project===project):[project.root];
      if(!includes.length)continue;
      if(excludes.some(item=>item.id===project.root.id))continue;
      const excluded=excludes.map(item=>items.get(item.id)).filter(record=>record?.project===project).map(record=>({kind:'uniqueId',value:record.data.id}));
      if(includes.some(item=>item.id===project.root.id)){selected.set(project,{selectors:undefined,excludes:excluded});continue;}
      const selectors=includes.map(item=>items.get(item.id)).filter(record=>record?.project===project).map(record=>({kind:'uniqueId',value:record.data.id}));
      if(selectors.length)selected.set(project,{selectors,excludes:excluded});
    }
    return selected;
  }
  function detailsFor(file){
    const details=(file.details||[]).filter(line=>Number.isInteger(line.line)&&line.line>=0).map(line=>new vscode.StatementCoverage(line.covered,new vscode.Position(line.line,0)));
    if(vscode.DeclarationCoverage)for(const method of file.methodDetails||[])if(Number.isInteger(method.line)&&method.line>=0)details.push(new vscode.DeclarationCoverage(method.name,method.covered,new vscode.Position(method.line,0)));
    return details;
  }
  function publishCoverage(run,value,project,perTest){
    if(value?.state!=='available'&&value?.state!=='partial')return;
    for(const file of value.files||[]){
      const uri=vscode.Uri.parse(file.uri);if(uri.scheme!=='file'||!vscode.workspace.getWorkspaceFolder(uri))continue;
      const tests=new Map();
      if(['available','partial'].includes(perTest?.state)&&!perTest.concurrencyObserved)for(const segment of perTest.tests||[]){
        const item=items.get(itemId(project,segment.testId))?.item,measured=segment.coverage?.files?.find(f=>f.uri===file.uri);
        if(item&&measured&&['available','partial'].includes(segment.coverage?.state))tests.set(item,detailsFor(measured));
      }
      const coverage=new vscode.FileCoverage(uri,file.lines,file.branches,file.methods,[...tests.keys()]);
      coverageDetails.set(coverage,{all:detailsFor(file),tests});run.addCoverage(coverage);
    }
  }
  async function execute(request={},token,options={}){
    trusted();
    if(options.debug&&(options.coverage||options.perTestCoverage))throw new Error('Use separate test debugging and coverage profiles.');
    if(dirty||options.projects)await discover({projects:options.projects,build:options.build,cancellation:token});
    if(busy)throw new Error('Wait for the current Java test operation or cancel it.');
    assertSaved([...projects.values()]);
    const selection=selectedProjects(request);if(!selection.size)throw new Error('No runnable Java tests match this selection. Refresh discovery for test templates or dynamic cases.');
    busy=true;const before=generation,cancellation=new vscode.CancellationTokenSource();activeCancellation=cancellation;
    const external=token?.onCancellationRequested(()=>cancellation.cancel()),run=controller.createTestRun(request,options.debug?'Debug Java tests':options.perTestCoverage?'Java tests with serial per-test coverage':options.coverage?'Java tests with JaCoCo coverage':'Java tests');
    const reports=[],pendingItems=new Map();
    const within=(id,prefix)=>id===prefix||id.startsWith(prefix+'/');
    try{
      for(const [project,{selectors,excludes}] of selection){
        trusted();
        if(cancellation.token.isCancellationRequested)break;
        const finished=new Set();let handlerError;
        const eventHandler=event=>{
          try {
          if(disposed||!vscode.workspace.isTrusted){cancellation.cancel();return;}
          const data=event.test||event.identifier;const item=data?upsert(project,data):undefined;
          if(!item)return;
          if(data.kind==='test'&&!pendingItems.has(item.id)&&!finished.has(item.id)){run.enqueued(item);pendingItems.set(item.id,item);}
          if(event.type==='start'||event.type==='started')run.started(item);
          if(event.type==='skipped'){run.skipped(item);finished.add(item.id);pendingItems.delete(item.id);failed.delete(item.id);}
          if(event.type==='finish'||event.type==='finished'){
            const outcome=event.status||event.state;
            if(outcome==='SUCCESSFUL'||outcome==='passed'||outcome==='succeeded'){run.passed(item,event.durationMs);failed.delete(item.id);}
            else if(outcome==='ABORTED'||outcome==='skipped'||outcome==='aborted'){run.skipped(item);failed.delete(item.id);}
            else{
              const failure=event.error||event.failure||{},text=failure.message||event.message||'Java test failed';
              const message=failure.expected!==undefined&&failure.actual!==undefined&&vscode.TestMessage.diff?vscode.TestMessage.diff(text,String(failure.expected),String(failure.actual)):new vscode.TestMessage(text);
              if(item.uri&&item.range)message.location=new vscode.Location(item.uri,item.range);
              const frame=failure.frames?.find(value=>value.uri&&Number.isInteger(value.line)&&value.line>=0&&vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(value.uri)));
              if(frame)message.location=new vscode.Location(vscode.Uri.parse(frame.uri),new vscode.Range(frame.line,0,frame.line,0));
              run.failed(item,message,event.durationMs);if(failure.stack)run.appendOutput(String(failure.stack).replace(/\r?\n/g,'\r\n')+'\r\n',undefined,item);failed.add(item.id);
            }
            finished.add(item.id);
            pendingItems.delete(item.id);
          }
          }catch(error){handlerError=error;cancellation.cancel();}
        };
        for(const record of items.values())if(record.project===project&&record.data.kind==='test'&&(!selectors||selectors.some(s=>within(record.data.id,s.value)))&&!excludes.some(s=>within(record.data.id,s.value))){run.enqueued(record.item);pendingItems.set(record.item.id,record.item);}
        const config={...project,env:{...project.env,...options.env},jvmArgs:options.jvmArgs||project.jvmArgs};
        const backendOptions={selectors,excludes,coverage:Boolean(options.coverage||options.perTestCoverage),perTestCoverage:Boolean(options.perTestCoverage),cancellation:cancellation.token,onEvent:eventHandler,onOutput:text=>run.appendOutput(String(text).replace(/\r?\n/g,'\r\n'))};
        const result=await(options.debug?testDebugger.runTests(config,backendOptions,engine()):engine().runTests(config,backendOptions));
        trusted();if(handlerError)throw handlerError;if(result.state==='cancelled')cancellation.cancel();
        if(result.state==='errored')throw new Error(result.error?.message||result.errors?.[0]?.message||'Java test runner did not complete.');
        for(const [id,item] of pendingItems){if(items.get(id)?.project!==project)continue;if(result.summary?.containersFailed){run.errored(item,new vscode.TestMessage('A test container failed before this test could complete.'));failed.add(id);}else run.skipped(item);pendingItems.delete(id);}
        reports.push({projectId:project.id,framework:project.framework||'junit',state:result.state,summary:result.summary,runDirectory:result.runDirectory,coverage:result.coverage,perTestCoverage:result.perTestCoverage,debug:result.debug});
        if(generation===before&&!cancellation.token.isCancellationRequested)publishCoverage(run,result.coverage,project,result.perTestCoverage);
        else run.appendOutput('Source changed or run was cancelled; coverage was not applied to editor lines.\r\n');
      }
      lastReport={state:cancellation.token.isCancellationRequested?'cancelled':'completed',sourceChanged:generation!==before,coverageScope:options.perTestCoverage?'test-execution-interval':'run',perTestCoverage:!cancellation.token.isCancellationRequested&&generation===before&&reports.some(report=>['available','partial'].includes(report.perTestCoverage?.state)&&!report.perTestCoverage.concurrencyObserved),perTestCoverageRequested:Boolean(options.perTestCoverage),projects:reports};return structuredClone(lastReport);
    }catch(error){if(!disposed&&vscode.workspace.isTrusted){run.appendOutput(error.message+'\r\n');for(const project of selection.keys())run.errored(project.root,new vscode.TestMessage(error.message));for(const item of pendingItems.values())run.errored(item,new vscode.TestMessage(error.message));}throw error;}
    finally{run.end();external?.dispose();cancellation.dispose();activeCancellation=undefined;busy=false;}
  }
  function run(options={}){const request=options.request||new vscode.TestRunRequest(options.includeIds?.map(id=>items.get(id)?.item).filter(Boolean),options.excludeIds?.map(id=>items.get(id)?.item).filter(Boolean),options.debug?debugProfile:options.perTestCoverage?perTestProfile:options.coverage?coverageProfile:runProfile);return track(execute(request,options.cancellation,options));}
  const profileHandler=options=>async(request,token)=>{try{await run({request,cancellation:token,...options});}catch(error){channel.appendLine(error.message);}};
  const runProfile=controller.createRunProfile('Run Java tests',vscode.TestRunProfileKind.Run,profileHandler({}),true);
  const debugProfile=controller.createRunProfile('Debug Java tests',vscode.TestRunProfileKind.Debug,profileHandler({debug:true}),true);
  const coverageProfile=controller.createRunProfile('Run Java tests with coverage',vscode.TestRunProfileKind.Coverage,profileHandler({coverage:true}),true);
  const perTestProfile=controller.createRunProfile('Coverage by Test (Serial)',vscode.TestRunProfileKind.Coverage,profileHandler({coverage:true,perTestCoverage:true}),false);
  for(const profile of [coverageProfile,perTestProfile]){
    profile.loadDetailedCoverage=async(testRun,file)=>coverageDetails.get(file)?.all||[];
    profile.loadDetailedCoverageForTest=async(testRun,file,item)=>coverageDetails.get(file)?.tests.get(item)||[];
  }
  subscriptions.push(runProfile,debugProfile,coverageProfile,perTestProfile);
  controller.resolveHandler=async()=>{if(dirty&&!busy)await discover();};controller.refreshHandler=async token=>{await discover({cancellation:token});};
  const command=(name,action)=>subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await action(...args);}catch(error){channel.appendLine(error.message);await vscode.window.showErrorMessage('Rocketbrain Java Tests: '+error.message);}}));
  command('rocketbrain.java.testing.install',async()=>{trusted();const javaHome=vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');return engine().provisionTestingRuntime({target:path.join(context.globalStorageUri.fsPath,'java-testing'),javaHome});});
  command('rocketbrain.java.testing.discover',()=>discover());command('rocketbrain.java.testing.run',()=>run());command('rocketbrain.java.testing.coverage',()=>run({coverage:true}));
  command('rocketbrain.java.testing.debug',()=>run({debug:true}));command('rocketbrain.java.testing.coverageByTest',()=>run({coverage:true,perTestCoverage:true}));
  command('rocketbrain.java.testing.rerunFailed',()=>{const includeIds=[...failed].filter(id=>items.has(id));return includeIds.length?run({includeIds}):{state:'no-failures'};});
  command('rocketbrain.java.testing.cancel',()=>activeCancellation?.cancel());
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(event.document.languageId==='java')markDirty();}),vscode.workspace.onDidCreateFiles(markDirty),vscode.workspace.onDidDeleteFiles(markDirty),vscode.workspace.onDidRenameFiles(markDirty),vscode.workspace.onDidChangeWorkspaceFolders(markDirty),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('rocketbrain.java'))markDirty();}));
  const sourceWatcher=vscode.workspace.createFileSystemWatcher?.('**/*.java');
  if(sourceWatcher){
    const changed=uri=>{if(disposed||uri.scheme!=='file')return;const roots=[...projects.values()].flatMap(project=>project.sourceRoots||[]);if(roots.length?roots.some(root=>inside(root,uri.fsPath)):vscode.workspace.getWorkspaceFolder(uri)&&/[\\/]src[\\/](?:main|test)[\\/]/.test(uri.fsPath))markDirty();};
    subscriptions.push(sourceWatcher,sourceWatcher.onDidChange(changed),sourceWatcher.onDidCreate(changed),sourceWatcher.onDidDelete(changed));
  }
  let disposing;
  return {controller,discover,run,snapshot,cancel:()=>activeCancellation?.cancel(),rerunFailed:options=>failed.size?run({...options,includeIds:[...failed]}):Promise.resolve({state:'no-failures'}),dispose(){if(!disposing){disposed=true;generation++;activeCancellation?.cancel();disposing=Promise.allSettled([...operations]).then(()=>testDebugger.dispose()).finally(()=>{for(const item of subscriptions)item.dispose();});}return disposing;}};
}
module.exports={registerJavaTesting};
