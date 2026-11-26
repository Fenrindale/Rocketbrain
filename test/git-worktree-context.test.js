'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const {pathToFileURL}=require('node:url');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {test}=require('node:test');
const {gitWorktreeFixture}=require('./helpers/git-worktree-fixture');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {collectProjects}=require('../src/java/workbench-model');
const {parseWorktrees,inspectWorktree,contextSettings,createWorktreeContextStore}=require('../src/vcs/worktree-context');
const {registerWorktreeContexts}=require('../src/vcs/worktree-context-vscode');
const {auditProfile}=require('../src/keyboard-profile');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,run=promisify(execFile);
const uri=file=>({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
const disposable={dispose(){}};

test('porcelain parser rejects incomplete worktree state and settings use local data only',()=>{
  const root=path.resolve('root with spaces'),hash='a'.repeat(40);
  const encoded=Buffer.from(`worktree ${root}\0HEAD ${hash}\0branch refs/heads/current\0locked\0\0`);
  assert.deepEqual(parseWorktrees(encoded),[{root,head:hash,branch:'current',locked:true}]);
  assert.throws(()=>parseWorktrees(encoded.subarray(0,-1)),/incomplete/);
  assert.throws(()=>contextSettings({project:'../../other'}),/within/);
  assert.throws(()=>contextSettings({spring:'http://example.invalid/actuator'}),/loopback/);
  assert.throws(()=>contextSettings({spring:'http://secret@127.0.0.1/actuator'}),/without credentials/);
  assert.throws(()=>contextSettings({database:{id:'setting',revision:1,password:'internal'}}),/profile revision/);
});

test('real Git/JDT project contexts use separate worktree settings and exact service bindings',{
  skip:!config,timeout:160000
},async()=>{
  const {javaHome,serverPath}=JSON.parse(await fs.readFile(config,'utf8'));
  const fixture=await gitWorktreeFixture(await fs.realpath(os.tmpdir()));
  const state=new Map(),globalState={get:(key,fallback)=>state.get(key)??fallback,async update(key,value){state.set(key,structuredClone(value));}};
  const calls=[],server=http.createServer((request,response)=>{
    calls.push(request.url);
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify({status:request.url.startsWith('/main')?'UP':'OUT_OF_SERVICE'}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const rootUri=uri(fixture.folder).toString(),commands=[];
  const folders=[fixture.main,fixture.linked].map(file=>({uri:uri(file),name:path.basename(file)}));
  const lsp=new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(fixture.folder,'engine')}));
  const profiles=[{id:'primary',revision:2,profile:{name:'Primary'}},{id:'linked',revision:1,profile:{name:'Linked'}}],opened=[];
  let snapshots;
  const java={workbench:{refresh:()=>collectProjects({folders,request:(command,args)=>lsp.request('workspace/executeCommand',{command,arguments:args},25000)})}};
  const registered=new Map(),pickers=[];
  const vscode={Uri:{file:uri},workspace:{isTrusted:true,getWorkspaceFolder:()=>({uri:uri(fixture.folder)})},
    window:{activeTextEditor:{document:{uri:uri(path.join(fixture.main,fixture.source))}},
      async showQuickPick(items,options){pickers.push(options.title);return items.find(item=>item.key==='spring');},
      showErrorMessage(message){throw Error(message);},showInformationMessage(){}},
    commands:{registerCommand(name,run){registered.set(name,run);return disposable;},
      async executeCommand(name,...args){if(registered.has(name))return registered.get(name)(...args);commands.push([name,...args]);}}};
  const dbConnections={list:()=>structuredClone(profiles),async openDedicatedConsole(value){opened.push(value);return {profile:value.id};}};
  const service=registerWorktreeContexts({globalState},vscode,{java,dbConnections});
  try {
    const roots=folders.map(item=>item.uri.toString());
    await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:folders.map(({uri,name})=>({uri:uri.toString(),name})),
      capabilities:{workspace:{workspaceFolders:true,configuration:true}},initializationOptions:{workspaceFolders:roots,settings}},75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    snapshots=await until(async()=>{const snapshot=await java.workbench.refresh();return snapshot.projects.length===2?snapshot:undefined;},50000);
    assert.ok(snapshots.projects.every(item=>item.sourceRoots.length&&item.compliance==='25'));
    const before=await service.review(fixture.main);
    assert.equal(before.worktrees.length,2);
    assert.equal(before.branch,'rb-main');
    const base='http://127.0.0.1:'+server.address().port;
    const main=await service.save(before,{project:'.',spring:base+'/main/actuator',database:{id:'primary',revision:2}});
    const linked=await service.save(await service.review(fixture.linked),{project:'.',spring:base+'/linked/actuator',
      database:{id:'linked',revision:1}});
    assert.notEqual(main.head,linked.head);
    assert.equal((await service.project(main)).root,fixture.main);
    assert.equal((await service.project(linked)).root,fixture.linked);
    const received=await Promise.all([service.spring(main),service.spring(linked)]);
    assert.deepEqual(received.map(row=>row.health.status),['UP','OUT_OF_SERVICE']);
    assert.deepEqual(calls.sort(),['/linked/actuator/health','/main/actuator/health']);
    const keyboard=auditProfile('win32',{commands:registered.keys()}).routes.find(rule=>rule.command==='rocketbrain.gitWorktree.context');
    assert.ok(keyboard.available);
    assert.equal((await vscode.commands.executeCommand(keyboard.command)).health.status,'UP');
    assert.deepEqual(pickers,['Git Worktree Context · rb-main']);
    assert.equal(calls.at(-1),'/main/actuator/health');
    await service.openDatabase(main);
    await service.openDatabase(linked);
    assert.deepEqual(opened.map(row=>[row.id,row.revision]),[['primary',2],['linked',1]]);
    profiles[1].revision++;
    await assert.rejects(service.openDatabase(linked),/profile changed/);
    await assert.rejects(service.save(before,{project:'.'}),/changed after review/);
    const separate=createWorktreeContextStore(globalState);
    const id1=await inspectWorktree(fixture.main,fixture.folder),id2=await inspectWorktree(fixture.linked,fixture.folder);
    assert.equal(id1.group,id2.group);assert.notEqual(id1.id,id2.id);
    assert.notEqual(separate.get(id1.id).settings.spring,separate.get(id2.id).settings.spring);
    await service.openSibling(main,fixture.linked);
    assert.equal(commands[0][0],'vscode.openFolder');
    assert.equal(commands[0][1].fsPath,fixture.linked);
    assert.deepEqual(commands[0][2],{forceNewWindow:true});
    await fixture.git(fixture.linked,'commit','--allow-empty','-m','Change the sibling after review');
    await assert.rejects(service.openSibling(main,fixture.linked),/sibling worktree changed/);
    await fixture.git(fixture.main,'switch','-c','another-local-branch');
    await assert.rejects(service.project(main),/worktree or saved context changed/);
    assert.equal((await service.review(fixture.main)).settings.database.id,'primary');
    const outputs=[];
    for(const [root,label] of [[fixture.main,'primary'],[fixture.linked,'linked']]){
      const output=path.join(fixture.folder,label+'-classes');
      await fs.mkdir(output);
      const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
      await run(tool('javac'),['-proc:none','-d',output,path.join(root,fixture.source)],{timeout:20000,windowsHide:true});
      outputs.push((await run(tool('java'),['-cp',output,'sample.Main'],{timeout:20000,windowsHide:true})).stdout);
    }
    assert.deepEqual(outputs,['primary','linked']);
    await service.clear(await service.review(fixture.main));
    assert.equal((await service.review(fixture.main)).revision,0);
    assert.equal((await service.review(fixture.linked)).settings.database.id,'linked');
    const proof=process.env.ROCKETBRAIN_WORKTREE_CONTEXT_RECEIPT;
    if(proof)await fs.writeFile(proof,JSON.stringify({jdt:'1.63.0',worktrees:2,independentJdtProjects:true,outputs,
      loopbackRoutes:calls,databaseBindingRevisionsChecked:true,staleWorktreeRefused:true,staleProfileRefused:true,
      localPersistence:true,isolatedClear:true,openNewWindowBoundToSibling:true,
      keyboardRouteObservedExactGitWorktree:true},null,2)+'\n');
  }finally{
    service.dispose();
    try{await lsp.close();}finally{
      await new Promise(resolve=>server.close(resolve));
      await fixture.close();
    }
  }
});
