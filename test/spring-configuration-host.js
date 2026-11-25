'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const { pathToFileURL }=require('node:url');
const { ActuatorClient }=require('../src/spring/runtime-client');
const { configuration }=require('../src/spring/configuration');
const { metadataProperties,metadataJavaSource }=require('../src/spring/configuration-metadata');
const F=require('./helpers/spring-configuration-fixture');
const key='fixture.catalog.query-limit';
const displayKey='fixture.catalog.display-name';

async function fixtureConfig(){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  return config;
}

async function metadataFile(){
  return fs.readFile(process.env.ROCKETBRAIN_SPRING_CONFIGURATION_METADATA||path.join(F.project,F.metadata));
}

async function sourceModel(){
  const files=await Promise.all([F.yamlSource,F.propsSource].map(async member=>{
    const absolute=path.join(F.project,member);
    return {uri:pathToFileURL(absolute).href,text:await fs.readFile(absolute,'utf8')};
  }));
  const model=configuration(files,{activeProfiles:['local-db']});
  assert.deepEqual(model.issues,[]);
  const selected=model.entries.get(key), sourceLine=files[0].text.split('\n')[selected.range.start.line];
  assert.equal(selected.value,'2');
  assert.equal(selected.document,1);
  assert.equal(sourceLine.slice(selected.range.start.character,selected.range.end.character),'query-limit');
  assert.equal(model.entries.get(displayKey).value,'local catalog');
  assert.equal(model.entries.get('fixture.catalog.labels.team').value,'catalog');
  assert.equal(model.entries.get('fixture.catalog.thresholds[1]').value,'99');
  assert.ok(model.entries.get('fixture.catalog.retries').uri.endsWith('/application-local-db.properties'));
  return {model,selected};
}

async function live(config, model, external){
  const app=await F.startConfigurationFixture(config,external);
  const client=new ActuatorClient({url:app.url+'/actuator'});
  try{
    const response=await fetch(app.url+'/config-probe',{signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);
    const sample=await response.json();
    const keyReport=await client.property(key);
    const display=await client.property(displayKey);
    const retries=await client.property('fixture.catalog.retries');
    assert.equal(sample.queryLimit,Number(model.entries.get(key).value));
    assert.equal(sample.displayName,external?F.probeValue:model.entries.get(displayKey).value);
    assert.equal(sample.retries,6);
    assert.equal(sample.timeoutMillis,2000);
    assert.deepEqual(sample.thresholds,[13]);
    assert.equal(sample.shadowIndex,99);
    assert.deepEqual(sample.labels,{team:'catalog',tier:'local'});
    assert.equal(sample.people.length,2);
    assert.ok(sample.people.every(Number.isSafeInteger));
    assert.equal(/mariadb/i.test(sample.serverVersion),config.dbEngine==='mariadb');
    assert.match(keyReport.source,/application\.yml[\s\S]*document #1/);
    assert.match(keyReport.origin,/application\.yml/);
    assert.match(retries.source,/application-local-db\.properties/);
    assert.match(retries.origin,/application-local-db\.properties/);
    assert.equal(display.display.state,'redacted');
    if(external){
      assert.equal(display.source,'commandLineArgs');
      assert.ok(display.sources.some(source=>!source.effective&&source.origin?.includes('application.yml')));
    }else{
      assert.match(display.source,/application\.yml[\s\S]*document #1/);
      assert.match(display.origin,/application\.yml/);
    }
    return {serverVersion:sample.serverVersion,displayOrigin:external?'commandLineArgs':'application.yml document #1'};
  }finally{client.dispose();await app.close();}
}

async function verify(config){
  const {model}=await sourceModel(), generated=JSON.parse((await metadataFile()).toString('utf8'));
  const properties=metadataProperties(generated,'compiler output');
  const query=properties.find(item=>item.name===key);
  assert.equal(query.type,'java.lang.Integer');
  assert.equal(query.sourceType,'fixture.configuration.CatalogSettings');
  assert.match(query.description,/Maximum rows/);
  const sourcePath=path.join(F.project,F.javaSource);
  const target=metadataJavaSource({uri:pathToFileURL(sourcePath).href,text:await fs.readFile(sourcePath,'utf8')},query);
  assert.ok(target);
  const local=await live(config,model,false), external=await live(config,model,true);
  assert.equal(local.serverVersion,external.serverVersion);
  return {engine:config.dbEngine,serverVersion:local.serverVersion,annotationProcessorGenerated:true,metadataPropertyType:query.type,
    activeYamlDocument:1,localFileOrigin:local.displayOrigin,externalRuntimeOrigin:external.displayOrigin,actualJdbcRows:2,typedSpringBinding:true,
    boundListReplaced:true,lowerEnvironmentIndexVisible:true,foldedScalar:true,aliasMapMergedByBinder:true,profilePropertiesPrecedence:true,
    actuatorRedactionPreserved:true,nativeConfigurationMetadata:false};
}

async function runSpringConfigurationChecks(api,vscode,checks){
  const config=await fixtureConfig(), report=await verify(config);
  const workspace=vscode.workspace.workspaceFolders?.find(folder=>path.resolve(folder.uri.fsPath)===path.resolve(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE||''));
  assert.ok(workspace,'The owned code workspace must be open for configuration metadata checks.');
  const root=await fs.mkdtemp(path.join(workspace.uri.fsPath,'rb-spring-configuration-'));
  const sources=[F.yamlSource,F.javaSource,F.propsSource], copied=[...sources,F.metadata];
  const finish=async()=>{
    for(const relative of copied)await fs.rm(path.join(root,relative),{force:true});
    await fs.rm(path.join(root,'src','main','resources','application-completion.yml'),{force:true});
    for(const relative of ['src/main/java/fixture/configuration','src/main/java/fixture','src/main/java','src/main/resources',
      'src/main','src','build/classes/java/main/META-INF','build/classes/java/main','build/classes/java','build/classes','build',''])await fs.rmdir(path.join(root,relative)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  };
  try{
    for(const relative of copied)await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});
    await Promise.all(sources.map(relative=>fs.copyFile(path.join(F.project,relative),path.join(root,relative))));
    await fs.writeFile(path.join(root,F.metadata),await metadataFile(),{flag:'wx'});
    const yaml=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,F.yamlSource)));
    const text=yaml.getText(), start=text.indexOf('query-limit: 2');
    assert.ok(start>=0);
    const targets=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',yaml.uri,yaml.positionAt(start+4));
    const definition=targets.find(item=>(item.uri||item.targetUri).fsPath===path.join(root,F.javaSource));
    assert.ok(definition,'The YAML setting did not navigate to the generated Java source');
    const java=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,F.javaSource)));
    assert.equal(java.getText(definition.range||definition.targetSelectionRange),'queryLimit');

    const incomplete=path.join(root,'src','main','resources','application-completion.yml');
    await fs.writeFile(incomplete,'test:\n  marker: before\n---\nfixture:\n  catalog:\n    query-li\n',{flag:'wx'});
    const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(incomplete));
    const suggestions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',doc.uri,new vscode.Position(5,12));
    const item=suggestions.items.find(value=>(typeof value.label==='string'?value.label:value.label.label)==='query-limit');
    assert.ok(item,'The active YAML subtree did not receive its compiler-generated Spring property completion');
    assert.match(item.detail,/java\.lang\.Integer[\s\S]*spring-configuration-metadata\.json/);
    assert.match(typeof item.documentation==='string'?item.documentation:item.documentation.value,/Maximum rows/);
    checks.push('The installed Spring YAML provider navigates to the exact Java field, scopes compiler-generated completions to the owning module and verifies live profile and external origins.');
    return {...report,nativeConfigurationMetadata:true,generatedCompletion:true,exactJavaDefinition:true};
  }finally{await finish();}
}

module.exports={verify,runSpringConfigurationChecks};
if(require.main===module)fixtureConfig().then(verify).then(result=>console.log(JSON.stringify(result)),error=>{
  console.error(error.stack);process.exitCode=1;
});
