'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');
const project=path.join(root,'test/fixtures/refactoring-v24-package');
const assets=path.join(project,'src/package-assets/fixture/packagev24');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function imageInputs() {
 const {images,expected}=require('../test/package-resource-v24-data');
 assert.deepEqual(Object.keys(images).sort(),['nested/pixel.jpg','pixel.png']);
 return Object.entries(images).map(([relative,encoded])=>{
  const bytes=Buffer.from(encoded,'base64');
  const sha=sha256(bytes);
  assert.equal(sha,relative.endsWith('.png')?expected.png:expected.jpeg);
  const source=path.join(assets,'payload',relative),destination=path.join(assets,'relocated',relative);
  for(const file of [source,destination]){
   const directory=path.dirname(file);
   assert.equal(path.relative(fs.realpathSync(directory),directory),'');
  }
  return {source,destination,bytes,sha};
 });
}

function prepareImages() {
 const inputs=imageInputs();
 for(const {source,destination} of inputs){assert.equal(fs.existsSync(source),false);assert.equal(fs.existsSync(destination),false);}
 const created=[];
 try{
  for(const item of inputs){fs.writeFileSync(item.source,item.bytes,{flag:'wx'});created.push(item);}
 }catch(error){
  for(const item of created){if(fs.readFileSync(item.source).equals(item.bytes))fs.unlinkSync(item.source);}
  throw error;
 }
 return inputs.map(({source,destination,bytes,sha})=>({source,destination,bytes:bytes.length,sha256:sha}));
}

function cleanupImages() {
 const inputs=imageInputs();
 for(const {source,destination,bytes} of inputs){
  assert.equal(fs.existsSync(destination),false);
  assert.deepEqual(fs.readFileSync(source),bytes);
 }
 for(const {source} of inputs)fs.unlinkSync(source);
}

function buildPackageV24(java) {
 const gradle=process.env.ROCKETBRAIN_GRADLE_HOME||java.gradleHome;
 const launcher=path.join(gradle,'lib/gradle-launcher-9.1.0.jar');
 const result=spawnSync(path.join(java.javaHome,'bin',process.platform==='win32'?'java.exe':'java'),[
  '-Dorg.gradle.java.home='+java.javaHome,'-cp',launcher,'org.gradle.launcher.GradleMain',
  '--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',path.join(root,'test-output/java-gradle-user-home'),
  'clean','classes','writeClasspath'
 ],{cwd:project,windowsHide:true,encoding:'utf8',timeout:240000});
 if(result.error||result.status!==0)throw Error(`Owned package Gradle build failed. ${result.error||''}\n${result.stderr}\n${result.stdout}`);
 return {project,classpathFile:path.join(project,'build/runtime-classpath.txt'),cleanBuild:true};
}

async function main() {
 const separator=process.argv.indexOf('--');
 if(separator<0||!process.argv[separator+1])throw Error('Pass the owned child Node script after --.');
 const parent=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
 const java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
 const generatedImages=prepareImages();
 let app;
 try{
  const built=buildPackageV24(java);
  const config={...parent,projectPath:project,refactoringProjectPath:project,
   mainClass:'fixture.packagev24.PackageRefactoringApplication',refactoringClassPathFile:built.classpathFile,generatedImages};
  app=await require('./refactoring-spring').startRefactoringApp(config);
  config.baseUrl=app.baseUrl;
  const file=path.join(root,'test-output','v0.24-package-runtime-'+randomUUID()+'.json');
  fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  process.exitCode=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,process.argv.slice(separator+1),{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,ROCKETBRAIN_MOVE_V24_PACKAGE_CONFIG:file}});
   child.once('error',reject);
   child.once('exit',code=>resolve(code??1));
  });
 }finally{
  try{if(app)await app.stop();}finally{cleanupImages();}
 }
}

if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={buildPackageV24,prepareImages,cleanupImages};
