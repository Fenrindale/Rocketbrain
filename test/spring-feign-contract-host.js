'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {setTimeout:delay}=require('node:timers/promises');
const {ObserverClient}=require('../src/jpa/observer-client');
const {endpointContractFile,inheritedFeignContracts}=require('../src/spring/endpoint-contracts');
const {startFeignFixture,project}=require('./helpers/spring-feign-contract-fixture');

const view='rocketbrain.spring.feignContracts',title='OpenFeign Runtime Contracts';
const sourcePaths=['fixture/feign/CatalogClient.java','fixture/shared/IntermediateContract.java',
  'fixture/shared/CatalogContract.java','fixture/feign/CustomClient.java'];
const readSources=()=>Promise.all(sourcePaths.map(async relative=>{
  const source=path.join(project,'src','main','java',relative);
  return {relative,source,text:await fs.readFile(source,'utf8')};
}));

function assertSources(items){
  const routes=items.filter(item=>item.kind==='feign'&&item.inherited);
  assert.deepEqual(routes.map(item=>[item.methods.join('|'),item.path,item.declaringType,item.clientType]).sort(),[
    ['GET','/partner/people/{id}','fixture.shared.CatalogContract','fixture.feign.CatalogClient'],
    ['GET','/partner/status','fixture.shared.CatalogContract','fixture.feign.CatalogClient']
  ]);
  assert.ok(items.some(item=>item.state==='declared'&&item.path==='/partner/new-notice'));
  assert.ok(!items.some(item=>item.path==='/partner/old-notice'||item.path?.includes('rewritten')));
  assert.ok(items.some(item=>item.state==='unresolved'&&item.containerName==='CustomClient'));
  return routes;
}

async function verify(config,showNative,observerJar){
  const sources=await readSources(),files=sources.map(item=>endpointContractFile(item.text,pathToFileURL(item.source).href,true));
  const inheritance=inheritedFeignContracts(files.flatMap(item=>item.interfaces));
  assert.equal(inheritance.replacements.size,1);
  const sourceRoutes=assertSources([...files.flatMap(item=>item.items),...inheritance.inherited]);
  const off=await startFeignFixture(config,{enabled:false,observerJar});
  const disabled=new ObserverClient(off.observer);
  try{assert.deepEqual(await disabled.feignContracts(),{schemaVersion:1,enabled:false,state:'disabled',dropped:0,clients:[]});}
  finally{disabled.dispose();await off.close();}

  const fixture=await startFeignFixture(config,{observerJar});
  const client=new ObserverClient(fixture.observer);
  try {
    const response=await fetch(fixture.baseUrl+'/probe/feign-contracts',{signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{inherited:'person-7',alternate:'status',overridden:'current-notice',
      custom:'custom-9',jdbc:Boolean(config),readback:42});
    assert.deepEqual(fixture.requests.map(item=>[item.method,item.path]),[
      ['GET','/partner/people/7'],['GET','/partner/status'],['GET','/partner/new-notice'],['POST','/effective/rewritten/native/9']
    ]);
    assert.ok(fixture.requests.at(-1).privateQuery&&fixture.requests.at(-1).privateHeader);
    const observed=await client.feignContracts();
    assert.equal(observed.state,'ready',JSON.stringify({observed,warnings:(await client.refresh()).warnings}));
    assert.equal(observed.clients.length,2,JSON.stringify(observed));
    const catalog=observed.clients.find(item=>item.client==='fixture.feign.CatalogClient');
    assert.match(catalog.contract,/SpringMvcContract$/);
    assert.equal(catalog.basePathObserved,true);
    assert.deepEqual(catalog.methods.map(item=>[item.verb,item.path,item.inherited]).sort(),[
      ['GET','/partner/new-notice',false],['GET','/partner/people/{id}',true],['GET','/partner/status',true]
    ]);
    const custom=observed.clients.find(item=>item.client==='fixture.feign.CustomClient');
    assert.equal(custom.contract,'fixture.feign.RewritingFeignContract');
    assert.deepEqual(custom.methods,[{declaration:'fixture.feign.CustomClient',name:'custom',parameters:['int'],inherited:false,
      verb:'POST',template:'/rewritten/native/{id}',path:'/effective/rewritten/native/{id}'}]);
    const endpoint=fixture.observer.url+'/feign-contracts';
    assert.equal((await fetch(endpoint,{signal:AbortSignal.timeout(3000)})).status,401);
    const raw=await (await fetch(endpoint,{headers:{Authorization:'Bearer '+fixture.observer.token},signal:AbortSignal.timeout(3000)})).text();
    for(const value of ['private-query-feign-fixture','private-header-feign-fixture','X-Private-Contract',fixture.upstream,fixture.observer.token])
      assert.ok(!raw.includes(value),'Runtime metadata retained a private value.');
    if(showNative)await showNative(fixture.observer,sources);
    return {engine:config?.dbEngine??null,actualJdbc:Boolean(config),inheritedSourceRanges:sourceRoutes.length,observedProxies:2,
      dispatchedRoutes:fixture.requests.length,overrideSelected:true,customContractObserved:true,dynamicPrefixObserved:true,
      defaultDisabled:true,rawPrivateValuesOmitted:true,nativeFeignContractView:Boolean(showNative)};
  } finally { client.dispose();await fixture.close(); }
}

async function runFeignContractChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const fixture=await fs.mkdtemp(path.join(workspace,'rb-feign-contract-sources-'));
  try {
    const prepared=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(prepared.feignContractTraceEnabled,false);
    const answer=await verify(config,async(observer,sources)=>{
      for(const file of sources){
        const target=path.join(fixture,file.relative);
        await fs.mkdir(path.dirname(target),{recursive:true});
        await fs.writeFile(target,file.text,{flag:'wx'});
      }
      const native=(await api.java.spring.endpoints()).filter(item=>item.uri.includes(path.basename(fixture)));
      for(const item of assertSources(native)){
        const opened=await vscode.commands.executeCommand('rocketbrain.spring.endpoints',item);
        assert.ok(opened?.inherited);
        const active=vscode.window.activeTextEditor;
        assert.ok(active.document.uri.path.endsWith('/CatalogContract.java'));
        assert.match(active.document.getText(active.selection),/^@GetMapping/);
      }
      await api.jpa.observer.connect(observer);
      try{
        const panel=await vscode.commands.executeCommand(view);
        assert.equal(panel?.view,view);
        assert.ok(panel.clients.some(client=>client.contract.endsWith('.RewritingFeignContract')));
        const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
        const deadline=Date.now()+5000;
        while(!visible()&&Date.now()<deadline)await delay(60);
        assert.ok(visible());
      }finally{api.jpa.observer.disconnect();}
    },prepared.jar);
    checks.push('The installed Spring endpoint view opens inherited declarations and reports the actual custom OpenFeign proxy method templates while the owned application performs JDBC readback.');
    return answer;
  } finally {
    const owned=await fs.realpath(fixture);
    assert.equal(path.dirname(owned),workspace);
    assert.match(path.basename(owned),/^rb-feign-contract-sources-/);
    await fs.rm(owned,{recursive:true,maxRetries:3});
  }
}

module.exports={verify,runFeignContractChecks};
if(require.main===module){
  const file=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  (file?fs.readFile(file,'utf8').then(JSON.parse):Promise.resolve(undefined))
    .then(config=>verify(config)).then(report=>console.log(JSON.stringify(report)),error=>{
      console.error(error.stack);process.exitCode=1;
    });
}
