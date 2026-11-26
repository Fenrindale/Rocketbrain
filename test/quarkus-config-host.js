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
const {inspectQuarkusProject}=require('../src/java/quarkus-model');
const {renderQuarkusConfigOrigins}=require('../src/java/quarkus-config-origin-vscode');
const {jdbcReadback,importedSpring}=require('./java-source-analysis-host');

const root=path.resolve(__dirname,'..'), output=path.join(root,'test-output');
const fixture=path.join(__dirname,'fixtures/java/quarkus-config-app');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const name='rocketbrain.quarkus.inspectConfigOrigins', title='Quarkus Configuration Origins';
const watched=['sample.listener.tcp-port','sample.listener.tls','sample.listener.timeout','sample.retry-count',
  'sample.credentials.password','sample.custom-label','sample.missing'];
const password='fixture-private-environment-secret';
const values=['fixture-private-baseline-secret','fixture-private-unapproved-value','fixture-private-custom-source-name',
  'fixture-private-custom-source-value',password,'PT9S'];
const portableFile=file=>path.basename(new URL(file).pathname);

async function database(){
  const config=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const file=await fs.realpath(config.dbConfigPath), folder=path.dirname(file);
  const owner=await read(path.join(folder,'owner.json')), data=await read(file);
  const kind={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'}[config.dbEngine];
  assert.ok(kind);
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
  return {engine:config.dbEngine,version,jdbc:await jdbcReadback(),env:{
    RB_QUARKUS_TEST_JDBC_URL:'jdbc:'+config.dbEngine+'://127.0.0.1:'+data.port+'/rocketbrain_fixture?'+
      (config.dbEngine==='mysql'?'allowPublicKeyRetrieval=true&sslMode=DISABLED':'useSsl=false'),
    RB_QUARKUS_TEST_DB_USER:data.user,RB_QUARKUS_TEST_DB_PASSWORD:data.password
  }};
}

async function boot(db,profile,keys,work){
  const javaHome=await fs.realpath(process.env.ROCKETBRAIN_SPRING_JAVA_HOME);
  const app=await fs.realpath(process.env.ROCKETBRAIN_QUARKUS_CONFIG_APP||fixture);
  assert.equal(path.basename(app),'quarkus-config-app');
  const launcher=fastJar({root:app,tool:'gradle'});
  await fs.mkdir(output,{recursive:true});
  const owned=await fs.mkdtemp(path.join(output,'quarkus-origin-'));
  const token=randomBytes(32).toString('hex'), tokenFile=path.join(owned,'token');
  const descriptorFile=path.join(owned,'observer.json'), configFile=path.join(owned,'config.json');
  const port=await allocatePort(), url='http://127.0.0.1:'+port;
  let child, exited, log='', ended=false;
  try{
    await fs.writeFile(tokenFile,token,{flag:'wx',mode:0o600});
    await fs.writeFile(configFile,JSON.stringify({tokenFile,descriptorFile,quarkusConfigOriginKeys:keys}),{flag:'wx',mode:0o600});
    const {jarPath}=await buildObserver({target:path.join(output,'quarkus-config-observer'),javaHome});
    const env=Object.fromEntries(Object.entries({...process.env,...db.env,SAMPLE_CREDENTIALS_PASSWORD:password})
      .filter(([key])=>!/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key)));
    const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
    child=spawn(java,['--add-modules=jdk.httpserver','-javaagent:'+jarPath+'=config='+pathToFileURL(configFile).href,
      '-Dquarkus.http.host=127.0.0.1','-Dquarkus.http.port='+port,'-Dquarkus.profile='+profile,
      '-Dsample.retry-count=7','-jar',launcher],{cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    exited=new Promise(resolve=>{
      const finish=()=>{ended=true;resolve();};
      child.once('close',finish);
      child.once('error',finish);
    });
    for(const channel of [child.stdout,child.stderr])channel.setEncoding('utf8').on('data',chunk=>{log=(log+chunk).slice(-8192);});
    async function http(route){
      const response=await fetch(url+route,{signal:AbortSignal.timeout(7000),redirect:'error'});
      assert.equal(response.status,200,route);
      return response.text();
    }
    const end=Date.now()+55000;
    while(Date.now()<end&&!ended){
      if(log.includes('Listening on: '+url))break;
      await delay(150);
    }
    assert.ok(log.includes('Listening on: '+url),'Owned Quarkus fixtures could not finish startup.');
    const descriptor=await read(descriptorFile);
    assert.equal(descriptor.quarkusConfigOriginsEnabled,keys.length>0);
    assert.equal(descriptor.processId,child.pid);
    assert.match(descriptor.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/u);
    return await work({http,observer:{url:descriptor.baseUrl,token,timeoutMs:10000},pid:child.pid});
  }catch(error){
    console.error(log.split(/\r?\n/u).filter(line=>!line.includes('ROCKETBRAIN_JPA_OBSERVER ')).slice(-12).join('\n'));
    throw error;
  }finally{
    if(child&&!ended)child.kill();
    if(exited)await exited;
    const real=await fs.realpath(owned);
    assert.deepEqual([path.dirname(real),path.basename(real).startsWith('quarkus-origin-')],[await fs.realpath(output),true]);
    await fs.rm(real,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
}

function verifyModel(report){
  const byKey=new Map(report.configuration.map(item=>[item.key,item]));
  assert.deepEqual([...byKey.keys()],[
    'sample.credentials.password','sample.credentials.private-other','sample.custom-label','sample.listener.tcp-port',
    'sample.listener.timeout','sample.listener.tls','sample.retry-count'
  ]);
  const port=byKey.get('sample.listener.tcp-port'), retry=byKey.get('sample.retry-count');
  assert.deepEqual([port.type,port.groups,port.declaringType],['int',['listener'],'quarkusconfigfixture.ServiceSettings.Listener']);
  assert.deepEqual([retry.type,retry.groups,retry.declaringType],['int',['tuning'],'quarkusconfigfixture.ClientTuning']);
  assert.equal(byKey.get('sample.listener.timeout').type,'Optional<Duration>');
  assert.equal(byKey.get('sample.listener.tls').hasDefault,true);
  assert.equal(portableFile(port.source.uri),'ServiceSettings.java');
  assert.equal(portableFile(retry.source.uri),'ClientTuning.java');
  const selected=report.configured.filter(row=>row.key===port.key&&row.profile==='review');
  assert.deepEqual(selected.map(row=>portableFile(row.uri)).sort(),['application-review.properties','application.properties']);
  for(const secret of values)assert.ok(!JSON.stringify(report).includes(secret));
  return {configuredTargets:selected.length,typedLeaves:byKey.size,crossFileGroup:true};
}

async function verifyLive(fixture,profile){
  const {http,observer,pid}=fixture;
  const client=new ObserverClient(observer);
  const endpoint=observer.url+'/quarkus-config-origins';
  const headers={Authorization:'Bearer '+observer.token};
  try{
    assert.equal(await http('/fixture-config'),profile==='review'?'18103,false,9,7,true':'18101,false,0,7,true');
    assert.equal(await http('/fixture-config/jdbc'),'2');
    const count=Number(await http('/fixture-config/lookup-count'));
    assert.ok(count>0);
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint,{method:'POST',headers})).status,405);
    assert.equal((await fetch(endpoint+'?lookup=sample.listener.tls',{headers})).status,400);
    const report=await client.quarkusConfigOrigins();
    assert.equal(report.processId,pid);
    assert.equal(report.state,'ready',JSON.stringify({report,warnings:(await client.refresh()).warnings}));
    assert.deepEqual(report.keys,[...watched].sort());
    const known=report.contexts.filter(context=>context.activeProfiles.includes(profile)&&
      context.origins.some(value=>value.key==='sample.listener.tcp-port'&&value.file!==null));
    assert.ok(known.length>0,JSON.stringify(report));
    const context=known.find(context=>watched.filter(key=>key!=='sample.missing').every(key=>context.origins.some(value=>value.key===key)));
    assert.ok(context,JSON.stringify(report));
    const origin=Object.fromEntries(context.origins.map(row=>[row.key,row]));
    const port=origin['sample.listener.tcp-port'];
    assert.deepEqual([port.kind,port.file,port.line],profile==='review'
      ?['classpath-properties','application-review.properties',2]:['classpath-properties','application.properties',3]);
    assert.equal(origin['sample.listener.tls'].kind,'default');
    assert.equal(origin['sample.retry-count'].kind,'system');
    assert.equal(origin['sample.credentials.password'].kind,'environment');
    assert.deepEqual([origin['sample.custom-label'].kind,origin['sample.custom-label'].ordinal],['other',280]);
    if(profile==='review')assert.equal(origin['sample.listener.timeout'].file,'application-review.properties');
    const raw=await (await fetch(endpoint,{headers})).text(), html=renderQuarkusConfigOrigins(report);
    for(const secret of [...values,observer.token,'sample.credentials.private-other','jar:file:','jdbc:']) {
      assert.ok(!raw.includes(secret));
      assert.ok(!html.includes(secret));
    }
    assert.deepEqual(await client.quarkusConfigOrigins(),report);
    assert.equal(Number(await http('/fixture-config/lookup-count')),count);
    return {profile,context:context.id,originKinds:Object.fromEntries(Object.entries(origin).map(([key,value])=>[key,value.kind])),
      selectedFile:port.file,sourceLine:port.line,
      activeProfiles:context.activeProfiles,jdbc:true,observerReadDidNotReplayConfigSource:true,rawValuesAndSourceNamesOmitted:true};
  }finally{client.dispose();}
}

async function headless(){
  const model=inspectQuarkusProject({tool:'gradle',root:fixture,uri:pathToFileURL(fixture).href});
  const db=await database();
  const observed=[];
  for(const profile of ['review','fallback'])
    observed.push(await boot(db,profile,watched,current=>verifyLive(current,profile)));
  return {engine:db.engine,databaseVersion:db.version,quarkusVersion:model.version,smallrye:'3.17.2',
    springJdbc:db.jdbc,source:verifyModel(model),observed,nativeView:false};
}

async function runQuarkusConfigChecks(api,vscode,checks){
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const id='rb-quarkus-config-'+randomUUID().slice(0,8), app=path.join(workspace,id);
  const uri=vscode.Uri.file(app).toString();
  await fs.mkdir(app);
  let editor;
  try{
    await fs.cp(fixture,app,{recursive:true,filter:source=>!['build','bin','.gradle','.project','.classpath','.settings'].includes(path.basename(source))});
    const result=await api.java.workbench.resyncProject({projectUri:uri,allowProjectExecution:true});
    assert.ok(result.projects.some(project=>project.tool==='gradle'&&!path.relative(project.root,app)));
    const source=verifyModel(await api.java.quarkus.inspect({projectUri:uri}));
    const props=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(app,'src/main/resources/application-review.properties')));
    editor=await vscode.window.showTextDocument(props,{preview:false});
    const key='sample.listener.tcp-port', position=props.positionAt(props.getText().indexOf(key)+key.length);
    const completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',props.uri,position);
    assert.ok(completions.items.some(item=>item.label===key&&item.detail==='Quarkus · int'));
    const targets=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',props.uri,position);
    const location=targets.find(item=>path.basename((item.uri||item.targetUri)?.fsPath||'')==='ServiceSettings.java');
    assert.ok(location);
    const range=location.range||location.targetSelectionRange;
    const declaration=await vscode.workspace.openTextDocument(location.uri||location.targetUri);
    assert.equal(declaration.getText(range),'port');
    const db=await database();
    return await boot(db,'review',watched,async current=>{
      const observed=await verifyLive(current,'review');
      const prepare=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
      assert.equal(prepare.quarkusConfigOriginsEnabled,false);
      assert.deepEqual((await read(prepare.configFile)).quarkusConfigOriginKeys,[]);
      await api.jpa.observer.connect(current.observer);
      const show=await vscode.commands.executeCommand(name);
      assert.equal(show?.view,name);
      assert.ok(show.contexts.some(context=>context.activeProfiles.includes('review')));
      const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
      async function wait(expected){
        const end=Date.now()+5000;
        while(visible()!==expected&&Date.now()<end)await delay(50);
        assert.equal(visible(),expected);
      }
      await wait(true);
      api.jpa.observer.disconnect();
      await wait(false);
      checks.push('Installed Quarkus configuration origins identified actual active-profile SmallRye sources and navigated a typed nested declaration without exposing configuration values or replaying a source lookup.');
      return {engine:db.engine,databaseVersion:db.version,source,observed,nativeView:true,completionAndDefinition:true,defaultOff:true};
    });
  }finally{
    api.jpa.observer.disconnect();
    if(editor&&vscode.window.activeTextEditor===editor)await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[uri]).catch(()=>{});
    const real=await fs.realpath(app);
    assert.deepEqual([path.dirname(real),path.basename(real)],[workspace,id]);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

module.exports={runQuarkusConfigChecks};
if(require.main===module) headless().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
