'use strict';
// Owns two disposable application/database fixtures for mixed-server proof.
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const {startSpringProject}=require('./spring-project');
const root=path.resolve(__dirname,'..');
async function main(){
 const args=process.argv.slice(2),at=args.indexOf('--'),engineAt=args.indexOf('--engine'),engine=engineAt<0?'mysql':args[engineAt+1];
 if(args[0]!=='run'||at<0||!args.slice(at+1).length||!['mysql','mariadb'].includes(engine))throw Error('Use run --engine mysql|mariadb [--observer] [--debug] -- <Node arguments>.');
 const fixtures=[];
 try{
  const primary=await startSpringProject({engine,observer:args.includes('--observer'),debug:args.includes('--debug')});fixtures.push(primary);
  const peerEngine=engine==='mysql'?'mariadb':'mysql',peer=await startSpringProject({engine:peerEngine,observer:false,debug:false});fixtures.push(peer);
  const configPath=path.join(path.dirname(primary.configPath),'coordinator-fixtures.json');
  const participants=fixtures.map((fixture,index)=>({id:index===0?'primary':'peer',engine:index===0?engine:peerEngine,configPath:fixture.db.configPath,springConfigPath:fixture.configPath,baseUrl:fixture.baseUrl,runtimeUrl:fixture.runtimeUrl,crossConfigPath:fixture.db.crossConfigPath}));
  await fs.writeFile(configPath,JSON.stringify({format:'RocketbrainOwnedPairedSpringFixtures',version:1,participants},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'ready',mode:'paired-spring',engine,peerEngine,projectPath:primary.projectPath,configPath:primary.configPath,coordinatorConfigPath:configPath,runtimeUrl:primary.runtimeUrl,debugPort:primary.debugPort}));
  process.exitCode=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,args.slice(at+1),{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,
    ROCKETBRAIN_SPRING_RUNTIME_CONFIG:primary.configPath,ROCKETBRAIN_SPRING_PROJECT_CONFIG:primary.configPath,ROCKETBRAIN_JPA_RUNTIME:'1',
    ROCKETBRAIN_TEST_MYSQL_ENGINE:engine,ROCKETBRAIN_MYSQL_TEST_CONFIG:primary.db.configPath,ROCKETBRAIN_TEST_MYSQL_CONFIG:primary.db.configPath,
    ROCKETBRAIN_COORDINATOR_TEST_CONFIG:configPath,...(primary.db.crossConfigPath?{ROCKETBRAIN_SCHEMA_CROSS_CONFIG:primary.db.crossConfigPath}:{})}});
   child.once('error',reject);child.once('exit',code=>resolve(code??1));
  });
 }finally{
  const errors=[];for(const fixture of fixtures.reverse())try{await fixture.stop();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'An owned paired Spring fixture did not finish cleanup.');
 }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
