'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomBytes,randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const mysql=require('mysql2/promise');
const {ObserverClient}=require('../src/jpa/observer-client');
const {buildObserver}=require('../scripts/jpa-observer-build');
const {allocatePort}=require('../src/java/testing-debug');
const {fastJar}=require('../src/java/quarkus-dev');
const {arcProducerSource}=require('../src/java/quarkus-arc-lookups');
const {renderArcLookups}=require('../src/java/quarkus-arc-vscode');
const {jdbcReadback,importedSpring}=require('./java-source-analysis-host');

const output=path.resolve(__dirname,'../test-output');
const fixture=path.join(__dirname,'fixtures/java/quarkus-arc-app');
const producerFile=path.join(fixture,'src/main/java/fixture/arc/Producers.java');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const view='rocketbrain.quarkus.inspectArcLookups';
const open='rocketbrain.quarkus.openArcProducerSource';
const title='Quarkus Arc Lookups';
const packages=['fixture.arc'];

async function database(){
  const config=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const file=await fs.realpath(config.dbConfigPath), folder=path.dirname(file);
  const owner=await read(path.join(folder,'owner.json')), data=await read(file);
  const kind={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'}[config.dbEngine];
  assert.ok(kind);
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.deepEqual([owner.kind,owner.id],[kind,path.basename(folder)]);
  assert.deepEqual([data.host,data.database],['127.0.0.1','rocketbrain_fixture']);
  assert.ok(Number.isSafeInteger(data.port)&&data.port>=1024&&data.port<=65535);
  const db=await mysql.createConnection(data);
  let version;
  try{
    const [[server]]=await db.query('SELECT @@datadir AS datadir, VERSION() AS version');
    assert.equal(path.relative(folder,path.dirname(await fs.realpath(server.datadir))),'');
    version=server.version;
    assert.equal(/mariadb/i.test(version),config.dbEngine==='mariadb');
  }finally{await db.end();}
  const options=config.dbEngine==='mysql'?'allowPublicKeyRetrieval=true&sslMode=DISABLED':'useSsl=false';
  return {engine:config.dbEngine,version,jdbc:await jdbcReadback(),env:{
    RB_QUARKUS_TEST_JDBC_URL:'jdbc:'+config.dbEngine+'://127.0.0.1:'+data.port+'/rocketbrain_fixture?'+options,
    RB_QUARKUS_TEST_DB_USER:data.user,RB_QUARKUS_TEST_DB_PASSWORD:data.password
  }};
}

async function boot(db,gate,enabled,work,{interceptorPackages=[]}={}){
  const javaHome=await fs.realpath(process.env.ROCKETBRAIN_SPRING_JAVA_HOME);
  const app=await fs.realpath(process.env.ROCKETBRAIN_QUARKUS_ARC_APP||fixture);
  assert.equal(path.basename(app),'quarkus-arc-app');
  const launcher=fastJar({root:app,tool:'gradle'});
  await fs.mkdir(output,{recursive:true});
  const owned=await fs.mkdtemp(path.join(output,'quarkus-arc-'));
  const token=randomBytes(32).toString('hex'), tokenFile=path.join(owned,'token');
  const descriptorFile=path.join(owned,'observer.json'), configFile=path.join(owned,'config.json');
  const port=await allocatePort(), url='http://127.0.0.1:'+port;
  let child,exited,log='',ended=false;
  try{
    await fs.writeFile(tokenFile,token,{flag:'wx',mode:0o600});
    await fs.writeFile(configFile,JSON.stringify({tokenFile,descriptorFile,quarkusArcPackages:enabled?packages:[],
      quarkusInterceptorPackages:interceptorPackages}),{flag:'wx',mode:0o600});
    const {jarPath}=await buildObserver({target:path.join(output,'arc-observer'),javaHome});
    const env=Object.fromEntries(Object.entries({...process.env,...db.env})
      .filter(([key])=>!/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key)));
    const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
    child=spawn(java,['--add-modules=jdk.httpserver','-javaagent:'+jarPath+'=config='+pathToFileURL(configFile).href,
      '-Dquarkus.http.host=127.0.0.1','-Dquarkus.http.port='+port,'-Drb.arc.fixture.enabled='+gate,'-jar',launcher],
    {cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    exited=new Promise(resolve=>{
      const done=()=>{ended=true;resolve();};
      child.once('close',done);child.once('error',done);
    });
    for(const channel of [child.stdout,child.stderr])channel.setEncoding('utf8').on('data',chunk=>{log=(log+chunk).slice(-8192);});
    for(let deadline=Date.now()+55000;Date.now()<deadline&&!ended&&!log.includes('Listening on: '+url);)await delay(150);
    assert.ok(log.includes('Listening on: '+url),'Owned Quarkus Arc fixture did not finish startup.');
    const descriptor=await read(descriptorFile);
    assert.equal(descriptor.quarkusArcLookupsEnabled,enabled);
    assert.equal(descriptor.quarkusInterceptorsEnabled,interceptorPackages.length>0);
    assert.equal(descriptor.processId,child.pid);
    assert.match(descriptor.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/u);
    return await work({async http(route){
      const response=await fetch(url+'/fixture-arc'+route,{signal:AbortSignal.timeout(7000),redirect:'error'});
      assert.equal(response.status,200,route);
      return response.text();
    },observer:{url:descriptor.baseUrl,token,timeoutMs:10000},pid:child.pid});
  }catch(error){
    console.error(log.split(/\r?\n/u).filter(line=>!line.includes('ROCKETBRAIN_JPA_OBSERVER ')&&!line.includes('fixture-private-')).slice(-10).join('\n'));
    throw error;
  }finally{
    if(child&&!ended)child.kill();
    if(exited)await exited;
    const real=await fs.realpath(owned);
    assert.deepEqual([path.dirname(real),path.basename(real).startsWith('quarkus-arc-')],[await fs.realpath(output),true]);
    await fs.rm(real,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
}

async function verifyLive(application,gate){
  const {http,observer,pid}=application, client=new ObserverClient(observer);
  const endpoint=observer.url+'/quarkus-arc-lookups', headers={Authorization:'Bearer '+observer.token};
  try{
    assert.equal(await http('/jdbc'),'2');
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint,{method:'POST',headers})).status,405);
    assert.equal((await fetch(endpoint+'?lookup=abc',{headers})).status,400);
    assert.equal((await fetch(endpoint,{headers:{...headers,Origin:'http://localhost'}})).status,403);
    const before=await client.quarkusArcLookups();
    assert.equal(before.processId,pid);
    assert.deepEqual(before.lookups,[]);
    const actions=['left','right','conflict','missing','field','reflected','gated','handle'];
    const values=['21','22','ambiguous','unsatisfied','41','51',gate==='yes'?'33':'unsatisfied','handle'];
    for(const [index,action] of actions.entries())assert.equal(await http('/lookup/'+action),values[index],action);
    const count=await http('/counts');
    const report=await client.quarkusArcLookups();
    assert.equal(report.state,'ready',JSON.stringify({report,warnings:(await client.refresh()).warnings}));
    assert.equal(report.processId,pid);
    assert.deepEqual(report.packages,packages);
    assert.equal(count.split(',')[0],gate==='yes'?'4':'3','getHandle did not instantiate the selected producer');
    assert.ok(Number(count.split(',')[1])>0);
    assert.deepEqual(await client.quarkusArcLookups(),report);
    assert.equal(await http('/counts'),count,'Inspecting observations did not invoke a producer or re-read the conditional configuration source');
    assert.equal(report.lookups.length,actions.length);
    const lookup=Object.fromEntries(actions.map((action,index)=>[action,report.lookups[index]]));
    assert.deepEqual(report.lookups.map(event=>event.eligibleCount),[1,1,2,0,1,1,gate==='yes'?1:0,1]);
    assert.deepEqual(report.lookups.map(event=>event.status),['selected','selected','ambiguous','unsatisfied','selected','selected',
      gate==='yes'?'selected':'unsatisfied','selected']);
    assert.equal(new Set(report.lookups.map(event=>event.scope)).size,1);
    for(const event of report.lookups)assert.equal(event.requiredType,'fixture.arc.ArcService');
    assert.deepEqual(lookup.left.qualifierTypes,['fixture.arc.Choice','jakarta.enterprise.inject.Any']);
    assert.deepEqual(lookup.field.qualifierTypes,['jakarta.enterprise.inject.Any','jakarta.inject.Named']);
    assert.notEqual(lookup.left.candidates[0].id,lookup.right.candidates[0].id);
    assert.equal(lookup.handle.candidates[0].id,lookup.left.candidates[0].id);
    assert.deepEqual(lookup.conflict.candidates.map(candidate=>candidate.target?.member).sort(),['conflictOne','conflictTwo']);
    assert.deepEqual([lookup.reflected.candidates[0].kind,lookup.reflected.candidates[0].target],['opaque',null]);
    assert.deepEqual([lookup.field.candidates[0].kind,lookup.field.candidates[0].target?.member],['field','field']);
    const text=await fs.readFile(producerFile,'utf8');
    const targets=report.lookups.flatMap(event=>event.candidates.filter(candidate=>candidate.target));
    for(const {target} of targets){
      const selected=arcProducerSource({text},target);
      assert.ok(selected,'No exact saved declaration for '+target.kind+' '+target.member);
      assert.equal(text.slice(selected.start,selected.end),target.member);
    }
    const html=renderArcLookups(report);
    assert.match(html,/Quarkus Arc Lookups/u);
    for(const payload of [JSON.stringify(report),html]){
      assert.doesNotMatch(payload,/fixture-private-|fixture\.arc\.gate|SELECT COUNT|rocketbrain_fixture|reflected#/u);
    }
    return {report,summary:{gate,candidateCounts:report.lookups.map(event=>event.eligibleCount),
      exactSourceTargets:targets.length,postFilterEligibility:true,handleReusedObservedBeanIdentity:true,opaqueReflection:true,
      producerAndConditionCountsUnchanged:true,rawValuesRetained:false,jdbcRows:2}};
  }finally{client.dispose();}
}

async function headless(){
  const db=await database();
  const verified=[];
  for(const gate of ['yes','no'])
    verified.push(await boot(db,gate,true,async application=>(await verifyLive(application,gate)).summary));
  await boot(db,'yes',false,async application=>{
    const client=new ObserverClient(application.observer);
    try{
      assert.equal(await application.http('/lookup/left'),'21');
      assert.deepEqual(await client.quarkusArcLookups(),{state:'disabled',processId:application.pid,packages:[],lookups:[],
        inspectionResolvedBeans:false,qualifierValuesRetained:false,beanValuesRetained:false});
    }finally{client.dispose();}
  });
  return {engine:db.engine,databaseVersion:db.version,quarkusVersion:'3.40.1.2',springJdbc:db.jdbc,verified,defaultOff:true,nativeView:false};
}

async function runQuarkusArcChecks(api,vscode,checks){
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const copy=path.join(workspace,'ArcProducers-'+randomUUID()+'.java');
  await fs.copyFile(producerFile,copy,require('node:fs').constants.COPYFILE_EXCL);
  try{
    const db=await database();
    const prepare=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(prepare.quarkusArcLookupsEnabled,false);
    assert.deepEqual((await read(prepare.configFile)).quarkusArcPackages,[]);
    return await boot(db,'yes',true,async application=>{
      const {summary}=await verifyLive(application,'yes');
      await api.jpa.observer.connect(application.observer);
      const result=await vscode.commands.executeCommand(view);
      assert.equal(result?.view,view);
      const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
      const deadline=Date.now()+5000;
      while(!visible()&&Date.now()<deadline)await delay(50);
      assert.ok(visible());
      for(const member of ['left','field']){
        const lookup=result.lookups.find(row=>row.candidates.some(candidate=>candidate.target?.member===member));
        const candidate=lookup.candidates.find(row=>row.target?.member===member);
        const sourceUri=vscode.Uri.file(copy);
        const source=await vscode.commands.executeCommand(open,{lookupId:lookup.id,candidateId:candidate.id,sourceUri});
        assert.equal(source?.member,member);
        assert.equal(vscode.window.activeTextEditor.document.uri.toString(),sourceUri.toString());
        assert.equal(vscode.window.activeTextEditor.document.getText(source.range),member);
      }
      checks.push('Installed Quarkus Arc lookup inspection showed actual selected, ambiguous and conditionally ineligible producers and opened exact saved producer method and field declarations without replaying lookups.');
      return {engine:db.engine,databaseVersion:db.version,summary,nativeView:true,sourceTargets:2,defaultOff:true};
    });
  }finally{
    api.jpa.observer.disconnect();
    if(vscode.window.activeTextEditor?.document.uri.fsPath===copy)await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await fs.unlink(copy);
  }
}

module.exports={runQuarkusArcChecks,database,boot};
if(require.main===module)headless().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
