'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function javaHome(){
  if(process.env.ROCKETBRAIN_SPRING_JAVA_HOME)return process.env.ROCKETBRAIN_SPRING_JAVA_HOME;
  const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
  if(config&&fs.existsSync(config)){const runtime=JSON.parse(fs.readFileSync(config,'utf8'));return runtime.javaHome||runtime.settings?.['rocketbrain.java.javaHome'];}
  return path.join(root,'research/implementation/runtimes/temurin25/extracted/jdk-25.0.5+8');
}
const home=javaHome(),javac=path.join(home||'','bin',process.platform==='win32'?'javac.exe':'javac');
test('public-reflection Hibernate adapter reads bounded metadata and semantic types without opening a session',{skip:!fs.existsSync(javac)&&'Provision the pinned JDK25 or configure ROCKETBRAIN_JAVA_TEST_CONFIG.',timeout:30000},()=>{
  const base=path.join(root,'test-output/observer-adapter-unit');fs.mkdirSync(base,{recursive:true});const output=fs.mkdtempSync(path.join(base,'classes-'));
  try{
    const compile=spawnSync(javac,['--release','25','-d',output,path.join(root,'runtime/jpa-observer/src/rocketbrain/observer/HibernateAccess.java'),path.join(root,'runtime/jpa-observer/test/rocketbrain/observer/HibernateAccessTest.java')],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(compile.status,0,compile.stderr||compile.stdout);
    const run=spawnSync(path.join(home,'bin',process.platform==='win32'?'java.exe':'java'),['-cp',output,'rocketbrain.observer.HibernateAccessTest'],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(run.status,0,run.stderr||run.stdout);assert.match(run.stdout,/23 checks passed/);
  }finally{const resolved=path.resolve(output);assert.ok(resolved.startsWith(path.resolve(base)+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
});
