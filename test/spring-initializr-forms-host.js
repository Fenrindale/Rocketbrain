'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const assert=require('node:assert/strict');
const {SpringProjectTools}=require('../src/spring/project-tools');
const {InitializrClient,unpack,sha}=require('../src/spring/project-client');
const {projectArchiveShape}=require('../src/spring/project-archive-shape');
const {temporary}=require('./helpers/spring-project-tools-fixture');
const F=require('./helpers/spring-initializr-forms-fixture');

const endpoint='https://start.spring.io/';
const applicationLabels={java:'Java',kotlin:'Kotlin',groovy:'Groovy'};
const normalFile=(review,member)=>review.files.find(file=>file.path===member);
const acceptance=(review,language)=>review.files.filter(file=>file.path.startsWith('src/main/'+language+'/'));
const failCode=code=>error=>error.code==='ROCKETBRAIN_SPRING_PROJECT_'+code;

async function verify(api,config,{onReview,styles=F.styles}={}){
  await fs.mkdir(F.output,{recursive:true});
  const runtime=await F.buildRuntime();
  const metadata=await api.metadata({endpoint,bootVersion:F.boot});
  assert.equal(metadata.endpoint,endpoint);
  assert.ok(metadata.bootVersions.some(value=>value.id===F.boot),'Use an advertised Boot release for the official Initializr test.');
  assert.deepEqual(metadata.languages.map(value=>value.id).sort(),['groovy','java','kotlin']);
  assert.deepEqual(metadata.packaging.map(value=>value.id).sort(),['jar','war']);
  assert.deepEqual(metadata.configurationFormats.map(value=>value.id).sort(),['properties','yaml']);
  const forms=[];
  for(const style of styles){
    const selection=F.projectSelection(style),temp=temporary();
    try{
      const review=await api.previewCreate({endpoint,parentUri:temp.uri,selection});
      const folder=fileURLToPath(review.projectUri);
      assert.equal(review.selection.language,style.language);
      assert.equal(review.selection.packaging,style.packaging);
      assert.equal(review.selection.configurationFileFormat,style.configurationFileFormat);
      assert.equal(review.archiveShape.declaredPackaging,style.packaging);
      assert.equal(review.archiveShape.mainSourceDirectory,'src/main/'+style.language);
      assert.equal(review.archiveShape.sourceFileCount,style.packaging==='war'?2:1);
      assert.equal(review.archiveShape.configurationFile,'src/main/resources/application.'+(style.configurationFileFormat==='yaml'?'yaml':'properties'));
      assert.ok(normalFile(review,review.archiveShape.buildFile));
      assert.ok(normalFile(review,review.archiveShape.configurationFile));
      assert.ok(acceptance(review,style.language).length===review.archiveShape.sourceFileCount);
      assert.equal(review.automaticBuildStartedByTool,false);
      assert.equal(review.requiresProjectExecutionApproval,false);
      assert.match(review.archiveSha256,/^[a-f0-9]{64}$/);
      await fs.access(folder).then(()=>assert.fail('Preview created the destination'),error=>assert.equal(error.code,'ENOENT'));
      if(onReview)await onReview(review);
      const original=structuredClone(review.files), shape=structuredClone(review.archiveShape);
      review.files[0].path='unreviewed-ignored.txt';
      review.selection.language='unreviewed-language';
      review.archiveShape.buildFile='unreviewed.gradle';
      await assert.rejects(api.apply({reviewId:review.reviewId,allowWrite:false}),failCode('APPROVAL'));
      const result=await api.apply({reviewId:review.reviewId,allowWrite:true});
      assert.equal(result.state,'created');
      assert.equal(result.explicitBuildStarted,false);
      assert.equal(result.noExistingFilesOverwritten,true);
      assert.equal(result.filesWritten,original.length);
      for(const file of original)assert.equal(sha(await fs.readFile(path.join(folder,file.path))),file.sha256,file.path);
      await assert.rejects(api.apply({reviewId:review.reviewId,allowWrite:true}),failCode('STALE'));
      await F.addProbe(folder,selection);
      const built=await F.build(folder,selection,runtime);
      const observed=await F.bootAndRead(built,runtime,config);
      forms.push({...style,buildDescriptor:shape.buildFile,configurationFile:path.basename(shape.configurationFile),
        archiveSha256:review.archiveSha256,sourceCount:shape.sourceFileCount,actualRows:observed.people,
        serverVersion:observed.version,bootVersion:observed.boot,exactGeneratedBytes:true,explicitBuildOnly:true});
    }finally{temp.close();}
  }
  return {engine:config.dbEngine,officialInitializr:true,standardLanguageMetadata:true,standardPackagingMetadata:true,
    standardConfigFormats:true,forms,oneShotApproval:true,allowedNoAutomaticBuild:true,nativeInitializrForms:false};
}

async function runSpringInitializrFormChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const result=await verify(api.springProjects,config,{onReview:async review=>{
    const uri=file=>vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/'+file);
    const panel=await vscode.workspace.openTextDocument(uri('review.md'));
    assert.match(panel.getText(),new RegExp('Language · packaging: '+review.selection.language+' · '+review.selection.packaging.toUpperCase()));
    assert.match(panel.getText(),/Archive SHA-256/);
    assert.match(panel.getText(),new RegExp('application\\.'+review.selection.configurationFileFormat));
    const build=await vscode.workspace.openTextDocument(uri('file/'+review.archiveShape.buildFile));
    assert.equal(build.getText(),api.springProjects.reviewFile(review.reviewId,review.archiveShape.buildFile));
    const source=acceptance(review,review.selection.language)[0].path;
    const entry=await vscode.workspace.openTextDocument(uri('file/'+source));
    assert.match(entry.getText(),/package fixture\.initializr/);
    await vscode.window.showTextDocument(panel,{preview:true});
  }});
  checks.push('The installed Spring project generator reviews exact official Java WAR, Kotlin JAR and Groovy JAR files, publishes without starting builds, and verifies the generated apps against the owned database.');
  return {...result,nativeInitializrForms:true};
}

async function headless(config,styles){
  const api=new SpringProjectTools();
  try{return await verify(api,config,{styles});}finally{api.dispose();}
}

async function verifyInitializrArchiveGrid(){
  const client=new InitializrClient(endpoint),metadata=await client.metadata({bootVersion:F.boot});
  const forms=[];
  for(const build of metadata.types){
    for(const language of metadata.languages){
      for(const packaging of metadata.packaging){
        const style={type:build.id,language:language.id,packaging:packaging.id,
          configurationFileFormat:packaging.id==='war'?'yaml':'properties'};
        const result=await client.archive(F.projectSelection(style),metadata);
        const shape=projectArchiveShape(await unpack(result.bytes),result.selection);
        assert.equal(shape.declaredPackaging,style.packaging);
        assert.equal(shape.mainSourceDirectory,'src/main/'+style.language);
        assert.ok(shape.configurationFile.endsWith('/application.'+style.configurationFileFormat));
        forms.push({...style,sourceCount:shape.sourceFileCount,configurationFile:shape.configurationFile,archiveSha256:result.sha256});
      }
    }
  }
  assert.equal(forms.length,18);
  return {endpoint,bootVersion:F.boot,verifiedArchiveFormats:forms.length,forms};
}

module.exports={headless,runSpringInitializrFormChecks,verifyInitializrArchiveGrid};
