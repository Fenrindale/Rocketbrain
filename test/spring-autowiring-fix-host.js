'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {analyzeSpring}=require('../src/spring/model');
const {candidateChoices,prepareQualifier,FIX_CODE}=require('../src/spring/autowiring-fix');
const {PREVIEW}=require('../src/spring/autowiring-fix-vscode');
const {manifestText}=require('../src/java/testing');

const PACKAGE='fixture.autowire', DIRECTORY=['src','main','java','fixture','autowire'];
const CONSUMER='WiringConsumer.java', BEANS='WiringConfiguration.java';
const hash=value=>createHash('sha256').update(value).digest('hex');

async function readConfig(){
  const file=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  const config=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(file),'owner.json'),'utf8')).kind,'RocketbrainSpringProjectFixture-v1');
  const database=JSON.parse(await fs.readFile(config.dbConfigPath,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(config.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  assert.equal(database.host,'127.0.0.1');
  assert.ok(Number.isInteger(database.port)&&database.port>0 && database.port<65536);
  assert.match(database.database,/^[A-Za-z0-9_]+$/);
  return {config,database};
}

async function javaHome(){
  if(process.env.ROCKETBRAIN_SPRING_JAVA_HOME)return process.env.ROCKETBRAIN_SPRING_JAVA_HOME;
  const file=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
  const config=file?JSON.parse(await fs.readFile(file,'utf8')):{};
  return config.javaHome||config.settings?.['rocketbrain.java.javaHome'];
}

async function run(program,args,options){
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{...options,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:AbortSignal.timeout(25000)});
    let out='',err='';
    child.stdout.on('data',value=>{out=(out+value).slice(-12000);});
    child.stderr.on('data',value=>{err=(err+value).slice(-12000);});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve(out):reject(new Error('Owned wiring fixture failed '+code+' '+err)));
  });
}

async function runWiring(owned,source){
  const {config,database}=owned, home=await javaHome();
  assert.ok(home);
  const suite=path.resolve(__dirname,'../test-output/spring-autowiring-fixture');
  await fs.mkdir(suite,{recursive:true});
  const target=await fs.mkdtemp(path.join(suite,'compile-'));
  const java=name=>path.join(home,'bin',name+(process.platform==='win32'?'.exe':''));
  const classpath=(await fs.readFile(path.join(config.projectPath,'build','runtime-classpath.txt'),'utf8')).split(path.delimiter).filter(syncFs.existsSync);
  const jar=async(entries,name)=>{
    const manifest=path.join(target,name+'.mf'),file=path.join(target,name+'.jar');
    await fs.writeFile(manifest,manifestText(entries));
    await run(java('jar'),['--create','--file',file,'--manifest',manifest],{cwd:target});
    return file;
  };
  try{
    const file=path.join(target,CONSUMER),classes=path.join(target,'classes');
    await fs.writeFile(file,source);await fs.mkdir(classes);
    const compilation=await jar(classpath,'compile');
    await run(java('javac'),['--release','25','-parameters','-encoding','UTF-8','-classpath',compilation,'-d',classes,file],{cwd:target});
    const application=await jar([classes,...classpath],'run');
    const suffix=config.dbEngine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'';
    const result=await run(java('java'),['-cp',application,PACKAGE+'.WiringProbe'],{cwd:target,env:{
      ...process.env,RB_WIRING_DB_URL:'jdbc:'+config.dbEngine+'://127.0.0.1:'+database.port+'/'+database.database+suffix,
      RB_WIRING_DB_USER:database.user,RB_WIRING_DB_PASSWORD:database.password,
      RB_WIRING_DB_DRIVER:config.dbEngine==='mysql'?'com.mysql.cj.jdbc.Driver':'org.mariadb.jdbc.Driver'
    }});
    const line=result.split(/\r?\n/).find(item=>item.startsWith('RB_WIRING '));
    assert.ok(line,'Missing owned Spring wiring receipt');
    const [outcome,candidates,selected]=line.slice('RB_WIRING '.length).split('|');
    assert.deepEqual(candidates.split(','),['directMode','fastMode']);
    return {outcome,selected,sourceHash:hash(source)};
  }finally{
    const relative=path.relative(await fs.realpath(suite),await fs.realpath(target));
    if(!/^compile-[A-Za-z0-9]+$/.test(relative))throw new Error('Owned compiler fixture path changed.');
    await fs.rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}

async function sourceInputs(config){
  const directory=path.join(config.projectPath,...DIRECTORY);
  const java=await Promise.all((await fs.readdir(directory)).filter(name=>name.endsWith('.java')).sort().map(async name=>{
    const file=path.join(directory,name);
    return {uri:pathToFileURL(file).href,text:await fs.readFile(file,'utf8')};
  }));
  return {java,properties:[],options:{basePackages:[PACKAGE],closedWorld:true,parameterNames:true}};
}

function selectedWiring(model){
  const injection=model.injections.find(item=>item.owner===PACKAGE+'.WiringConsumer'&&item.name==='mode');
  assert.equal(injection?.resolution.state,'ambiguous',JSON.stringify(injection?.resolution));
  return injection;
}

async function verifyBackend(owned){
  const inputs=await sourceInputs(owned.config), model=analyzeSpring(inputs.java,[],inputs.options);
  const injection=selectedWiring(model), choices=candidateChoices(model,injection);
  assert.deepEqual(choices.map(item=>[item.beanName,item.qualifier,item.qualifierSource]).sort(),[
    ['directMode','directMode','bean-name'],['fastMode','fast-read','qualifier']
  ]);
  const source=inputs.java.find(file=>file.uri===injection.uri);
  const before=await runWiring(owned,source.text);
  assert.equal(before.outcome,'ambiguous');
  const reports=[];
  for(const choice of choices){
    const plan=prepareQualifier(model,inputs,{uri:source.uri,injectionId:injection.id,beanId:choice.beanId,qualifier:choice.qualifier});
    assert.equal(plan.beforeHash,before.sourceHash);
    const actual=await runWiring(owned,plan.after);
    assert.equal(actual.outcome,'resolved');
    assert.equal(actual.sourceHash,plan.afterHash);
    const [selected,version]=actual.selected.split(':');
    assert.equal(selected,choice.beanName==='directMode'?'direct':'fast');
    assert.match(version,/^\d+\.\d+\.\d+/);
    assert.equal(/mariadb/i.test(version),owned.config.dbEngine==='mariadb');
    reports.push({bean:choice.beanName,qualifier:choice.qualifier,source:choice.qualifierSource,afterHash:plan.afterHash,version});
  }
  const readiness=await fetch(owned.config.baseUrl+'/probe/testing-state',{redirect:'error',signal:AbortSignal.timeout(5000)});
  assert.equal(readiness.status,200);
  assert.deepEqual(await readiness.json(),{people:2,departments:1,rolledBackNames:0});
  return {engine:owned.config.dbEngine,baselineAmbiguous:true,candidates:2,selected:reports,exactJavaRecompiled:true};
}

async function runSpringAutowiringFixChecks(api,vscode,checks){
  const owned=await readConfig(), backend=await verifyBackend(owned);
  const spring=api.java.spring, settings=vscode.workspace.getConfiguration('rocketbrain.spring');
  const originalScope=settings.inspect('basePackages')?.workspaceValue;
  const originalRoots=settings.inspect('configurationRoots')?.workspaceValue;
  const scope=vscode.ConfigurationTarget.Workspace;
  async function copiedDocument(name){
    const original=await fs.realpath(path.join(owned.config.projectPath,...DIRECTORY,name));
    const matches=await vscode.workspace.findFiles('**/fixture/autowire/'+name,'**/{build,target,test-output}/**',8);
    const copies=[];
    for(const uri of matches){
      if(uri.scheme!=='file' || !vscode.workspace.getWorkspaceFolder(uri))continue;
      if(await fs.realpath(uri.fsPath)!==original)copies.push(uri);
    }
    assert.equal(copies.length,1,'The owned VS Code fixture copy must contain one '+name);
    const document=await vscode.workspace.openTextDocument(copies[0]);
    assert.equal(document.getText(),await fs.readFile(original,'utf8'));
    return document;
  }
  const target=await copiedDocument(CONSUMER), counterpart=await copiedDocument(BEANS);
  const original=target.getText(), originalBeans=counterpart.getText();
  const replace=async(document,content)=>{
    const edit=new vscode.WorkspaceEdit();
    edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),content);
    assert.equal(await vscode.workspace.applyEdit(edit),true);
  };
  try{
    await settings.update('basePackages',[PACKAGE],scope);
    const resourceRoot=path.resolve(path.dirname(target.uri.fsPath),'../../../resources');
    await settings.update('configurationRoots',[resourceRoot],scope);
    async function getAction(){
      const model=await spring.refresh(), injection=selectedWiring(model);
      const range=new vscode.Range(injection.range.start.line,injection.range.start.character,injection.range.end.line,injection.range.end.character);
      assert.ok(vscode.languages.getDiagnostics(target.uri).some(item=>item.code===FIX_CODE && item.range.isEqual(range)));
      const deadline=Date.now()+6000;
      let qualified=[];
      while(Date.now()<deadline && !qualified.length){
        const actions=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',target.uri,range,'quickfix');
        qualified=(actions||[]).filter(item=>item.command?.command===PREVIEW);
        if(!qualified.length)await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.equal(qualified.length,2,'Both local ambiguity fixes should be offered. '+JSON.stringify({
        incomplete:model.incomplete,truncated:model.truncated,eligible:candidateChoices(model,injection).length
      }));
      const exact=qualified.find(item=>item.command.arguments[0].qualifier==='directMode');
      assert.ok(exact);
      assert.equal(exact.edit,undefined);
      return exact.command;
    }
    const first=await getAction();
    const stale=await vscode.commands.executeCommand(first.command,...first.arguments,{previewOnly:true});
    assert.equal(target.getText(),original);
    const preview=await vscode.workspace.openTextDocument(vscode.Uri.parse(stale.previewUri));
    assert.equal(hash(preview.getText()),stale.afterHash);
    await replace(counterpart,originalBeans+'\n// review changed\n');
    await assert.rejects(spring.autowiring.apply(stale.id),/changed after review/);
    assert.equal(target.getText(),original);
    await replace(counterpart,originalBeans);

    const second=await getAction();
    const review=await vscode.commands.executeCommand(second.command,...second.arguments,{previewOnly:true});
    const applied=await spring.autowiring.apply(review.id);
    assert.equal(applied.applied,true);
    const actual=await runWiring(owned,target.getText());
    assert.equal(actual.sourceHash,backend.selected.find(item=>item.bean==='directMode').afterHash);
    assert.equal(actual.sourceHash,review.afterHash);
    assert.match(actual.selected,/^direct:/);
    assert.equal((await spring.refresh()).injections.find(item=>item.owner===PACKAGE+'.WiringConsumer').resolution.state,'resolved');
    await assert.rejects(spring.autowiring.apply(review.id),/expired/);
    checks.push('The installed Spring ambiguity Quick Fix previews an exact Qualifier, refuses a stale candidate review, and its applied text selects the intended Bean in the Spring and database fixture.');
    return {...backend,nativeCodeActions:2,nativeDiff:true,staleRejected:true,oneUseReview:true,nativeView:true};
  }finally{
    if(target.getText()!==original)await replace(target,original);
    if(counterpart.getText()!==originalBeans)await replace(counterpart,originalBeans);
    await settings.update('basePackages',originalScope,scope);
    await settings.update('configurationRoots',originalRoots,scope);
    await spring.refresh();
  }
}

module.exports={runSpringAutowiringFixChecks};
if(require.main===module)readConfig().then(verifyBackend).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});
