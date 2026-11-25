'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {InitializrClient,unpack,sha}=require('../src/spring/project-client');
const {SpringProjectTools}=require('../src/spring/project-tools');
const {projectArchiveShape}=require('../src/spring/project-archive-shape');
const F=require('./helpers/spring-project-tools-fixture');

const ids={java:'Java',kotlin:'Kotlin',groovy:'Groovy',jar:'Jar',war:'War',yaml:'YAML',properties:'Properties'};
const rows=list=>list.map(id=>({id,name:ids[id]}));
const rest=(list,defaultId)=>({default:defaultId,values:rows(list)});
const code=value=>error=>error.code==='ROCKETBRAIN_SPRING_PROJECT_'+value;
const warPom=F.pom.replace('<artifactId>demo</artifactId>','<artifactId>demo</artifactId><packaging>war</packaging>');

function fixtureFetch({zipFiles,includeFormat=true}={}){
  const requests=[];
  const fetchImpl=async(url,options)=>{
    requests.push(url.toString());
    assert.equal(options.redirect,'manual');
    if(url.pathname.endsWith('starter.zip')){
      const type=url.searchParams.get('type'),language=url.searchParams.get('language'),packaging=url.searchParams.get('packaging');
      const format=url.searchParams.get('configurationFileFormat');
      const extension={java:'java',kotlin:'kt',groovy:'groovy'}[language];
      const build=type==='maven-project'?'pom.xml':type==='gradle-project-kotlin'?'build.gradle.kts':'build.gradle';
      const text=build==='pom.xml'?(packaging==='war'?warPom:F.pom):
        (build.endsWith('.kts')?F.kotlin:F.gradle).replace('plugins {',packaging==='war'?"plugins {\n war":'plugins {');
      return new Response(F.zip(zipFiles??[{name:build,data:text},
        {name:'src/main/'+language+'/fixture/Demo.'+extension,data:'class Demo {}'},
        ...(format?[{name:'src/main/resources/application.'+format,data:''}]:[])]));
    }
    const body=F.metadata();
    body.language=rest(['java','kotlin','groovy','unknown'],'java');
    body.packaging=rest(['jar','war','aar'],'jar');
    if(includeFormat)body.configurationFileFormat=rest(['properties','yaml','toml'],'properties');
    body.bootVersion.values.push({id:'4.1.3',name:'4.1.3'});
    return new Response(JSON.stringify(url.pathname.endsWith('/dependencies')?F.catalog():body));
  };
  return {requests,fetchImpl};
}

test('supported forms reflect the current metadata/catalog and legacy services omit the format request',async()=>{
  const fixture=fixtureFetch(),client=new InitializrClient('https://example.test/',{fetchImpl:fixture.fetchImpl});
  const metadata=await client.metadata({bootVersion:F.version});
  assert.deepEqual(metadata.languages.map(item=>item.id),['java','kotlin','groovy']);
  assert.deepEqual(metadata.packaging.map(item=>item.id),['jar','war']);
  assert.deepEqual(metadata.configurationFormats.map(item=>item.id),['properties','yaml']);
  for(const type of ['maven-project','gradle-project','gradle-project-kotlin']){
    for(const language of ['java','kotlin','groovy']){
      for(const packaging of ['jar','war']){
        const config=packaging==='war'?'yaml':'properties';
        const result=await client.archive({...F.selection,type,language,packaging,configurationFileFormat:config},metadata);
        const url=new URL(result.requestUrl);
        assert.equal(url.searchParams.get('language'),language);
        assert.equal(url.searchParams.get('packaging'),packaging);
        assert.equal(url.searchParams.get('configurationFileFormat'),config);
        const shape=projectArchiveShape(await unpack(result.bytes),result.selection);
        assert.equal(shape.mainSourceDirectory,'src/main/'+language);
        assert.equal(shape.declaredPackaging,packaging);
        assert.match(shape.configurationFile,new RegExp('application\\.'+config+'$'));
      }
    }
  }
  for(const override of [{language:'unknown'},{packaging:'aar'},{configurationFileFormat:'toml'},{bootVersion:'4.1.3'}])
    await assert.rejects(client.archive({...F.selection,...override},metadata),code('CHOICE'));
  const old=fixtureFetch({includeFormat:false}),legacy=new InitializrClient('https://example.test/',{fetchImpl:old.fetchImpl});
  const oldMetadata=await legacy.metadata();
  const onlyJava=await legacy.archive(F.selection,oldMetadata);
  assert.equal(new URL(onlyJava.requestUrl).searchParams.has('configurationFileFormat'),false);
  assert.equal(projectArchiveShape(await unpack(onlyJava.bytes),onlyJava.selection).configurationFile,null);
  await assert.rejects(legacy.archive({...F.selection,configurationFileFormat:'yaml'},oldMetadata),code('CHOICE'));
});

test('archive shape refuses wrong language, WAR declaration, invalid POM and competing formats before any project exists',async()=>{
  const base=[{name:'pom.xml',data:warPom},{name:'src/main/kotlin/fixture/Demo.kt',data:'class Demo'},
    {name:'src/main/resources/application.yaml',data:''}];
  const invalid=[
    base.map((file,index)=>index===1?{name:'src/main/java/fixture/Demo.java',data:'class Demo{}'}:file),
    base.map((file,index)=>index===0?{name:'pom.xml',data:F.pom}:file),
    base.map((file,index)=>index===0?{name:'pom.xml',data:'<wrong/> '}:file),
    [...base,{name:'src/main/resources/application.properties',data:''}],
    base.filter(file=>!file.name.endsWith('.yaml'))
  ];
  for(const zipFiles of invalid){
    const fixture=fixtureFetch({zipFiles}),temp=F.temporary(),api=new SpringProjectTools({fetchImpl:fixture.fetchImpl});
    try{
      const selection={...F.selection,type:'maven-project',language:'kotlin',packaging:'war',configurationFileFormat:'yaml'};
      await assert.rejects(api.previewCreate({parentUri:temp.uri,selection}),code('ARCHIVE'));
      assert.deepEqual(await fs.readdir(temp.root),['owner.json']);
    }finally{api.dispose();temp.close();}
  }
});

test('review protects the exact generated Kotlin WAR project shape and file hashes',async()=>{
  const fixture=fixtureFetch(),temp=F.temporary(),api=new SpringProjectTools({fetchImpl:fixture.fetchImpl});
  try{
    const selection={...F.selection,type:'gradle-project-kotlin',language:'kotlin',packaging:'war',configurationFileFormat:'yaml'};
    const review=await api.previewCreate({parentUri:temp.uri,selection});
    assert.equal(review.archiveShape.declaredPackaging,'war');
    assert.equal(review.archiveShape.buildFile,'build.gradle.kts');
    assert.equal(review.archiveShape.mainSourceDirectory,'src/main/kotlin');
    review.archiveShape.buildFile='other';
    review.selection.language='groovy';
    const expected=api.getReview(review.reviewId);
    assert.equal(expected.selection.language,'kotlin');
    await assert.rejects(fs.access(path.join(temp.root,'demo')));
    await assert.rejects(api.apply({reviewId:review.reviewId,allowWrite:false}),code('APPROVAL'));
    const saved=await api.apply({reviewId:review.reviewId,allowWrite:true});
    assert.equal(saved.explicitBuildStarted,false);
    for(const file of expected.files)assert.equal(sha(await fs.readFile(path.join(temp.root,'demo',file.path))),file.sha256);
  }finally{api.dispose();temp.close();}
});
