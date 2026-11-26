'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {loadKmpModel}=require('../src/java/kmp-gradle');
const {previewFunctions,previewCandidates,renderComposePreview}=require('../src/java/kmp-compose-preview');
const {execute}=require('../src/java/testing/provision');
const preview=require('./helpers/kmp-compose-preview');
const spring=require('./helpers/kotlin-maven-editor');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleHome=process.env.ROCKETBRAIN_KMP_GRADLE_HOME,gradleUserHome=process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME;
const mavenHome=process.env.ROCKETBRAIN_KOTLIN_MAVEN_HOME;
const dbs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_KOTLIN_MAVEN_'+engine.toUpperCase()+'_CONFIG']]);

test('Compose candidates require real explicit annotation names and a plain top-level zero-argument function',async ()=>{
  const source=await fs.readFile(path.join(preview.fixture,preview.sourceFile),'utf8');
  const names=text=>previewFunctions(text).map(item=>item.qualified);
  assert.deepEqual(names(source),['previewfixture.InventoryPreview']);
  assert.deepEqual(names(source.replace('import androidx.compose.runtime.Composable','import other.Composable')),[]);
  assert.deepEqual(names(source.replace('@Preview','@Preview(widthDp = 200)')),[]);
  assert.deepEqual(names(source.replace('fun InventoryPreview()','private fun InventoryPreview()')),[]);
  assert.deepEqual(names(source.replace('fun InventoryPreview()','fun InventoryPreview(value: String = "x")')),[]);
  assert.deepEqual(names(source.replace('fun InventoryPreview() {','object Member {\nfun InventoryPreview() {')+'\n}'),[]);
  assert.deepEqual(names(source.replace('@Preview','// @Preview')),[]);
  await assert.rejects(renderComposePreview({workspaceTrusted:true}),/Explicitly choose/u);
});

test('official Compose Desktop and Skia render revised saved commonMain pixels in the selected Gradle JVM target',{
  skip:!javaConfig||!gradleHome||!gradleUserHome||!mavenHome||dbs.some(([,file])=>!file),timeout:440000
},async t=>{
  const parent=await fs.realpath(os.tmpdir()),owned=await fs.mkdtemp(path.join(parent,'rb-kmp-compose-test-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(owned),owned);
    assert.equal(path.dirname(owned),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const root=path.join(owned,'Compose Source'),file=path.join(root,preview.sourceFile);
  await fs.cp(preview.fixture,root,{recursive:true});
  const original=await fs.readFile(file,'utf8');
  const {javaHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const tools={javaHome,gradleHome,gradleUserHome};
  const runner={async execute(spec,options) {
    const result=await execute(spec.command,spec.args,{...options,cwd:spec.cwd,env:spec.env,maxOutputBytes:1024*1024});
    if (result.code!==0) t.diagnostic(result.output.slice(-6500));
    return result;
  }};
  const options={root,tools,runner,workspaceTrusted:true,allowProjectExecution:true};
  const model=await loadKmpModel(options);
  const [chosen]=previewCandidates(model,file);
  assert.deepEqual([chosen.qualified,chosen.modulePath,chosen.targetName],['previewfixture.InventoryPreview',':','desktop']);
  const request={...options,model,file,...chosen,width:96,height:72};
  await assert.rejects(renderComposePreview({...request,targetName:'js'}),/commonMain JVM target/u);
  await assert.rejects(renderComposePreview({...request,width:2048}),/32 and 1024/u);
  const first=await renderComposePreview(request);
  const initial=preview.verifyImage(first.png,first.report,'initial');
  assert.equal(first.report.task,':rocketbrainComposePreview');
  assert.equal(await fs.readFile(file,'utf8'),original);
  const changed=preview.updated(original);
  await fs.writeFile(file,changed);
  const next=await renderComposePreview(request);
  const refreshed=preview.verifyImage(next.png,next.report,'updated');
  assert.notEqual(initial.imageSha256,refreshed.imageSha256);
  assert.notEqual(initial.sourceSha256,refreshed.sourceSha256);
  await assert.rejects(renderComposePreview({...request,runner:{async execute() {
    await fs.writeFile(file,original);
    return {code:0};
  }}}),/sources changed during rendering/u);
  const settings=path.join(root,'settings.gradle'),settingsText=await fs.readFile(settings,'utf8');
  await fs.writeFile(settings,settingsText+'\n// changed after review\n');
  await assert.rejects(renderComposePreview(request),/Gradle settings changed/u);
  await fs.writeFile(settings,settingsText);

  const springRoot=path.join(owned,'Spring JDBC');
  await fs.cp(spring.fixture,springRoot,{recursive:true});
  const built=await spring.build(springRoot,{javaHome,mavenHome});
  const jdbc=[];
  for (const [engine,config] of dbs) jdbc.push(await spring.jdbc(springRoot,built,engine,config));
  const receipt=process.env.ROCKETBRAIN_COMPOSE_PREVIEW_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({compiler:'2.4.21',compose:'1.12.2',gradle:path.basename(gradleHome),
    target:chosen.targetName,qualified:chosen.qualified,width:96,height:72,initial,refreshed,jdbc,
    changedDuringExecutionRefused:true,staleBuildModelRefused:true,headless:true},null,2)+'\n');
});
