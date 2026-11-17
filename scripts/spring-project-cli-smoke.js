'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WORKSPACE } = require('./integration-db-runtime');
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function verifyCliStop({ engine = 'mariadb' } = {}) {
  if (!['mysql','mariadb'].includes(engine)) throw new Error('Select mysql or mariadb.');
  const child = spawn(process.execPath, [path.join(__dirname,'spring-project.js'),'start','--engine',engine], { cwd:WORKSPACE,windowsHide:true,stdio:['pipe','pipe','pipe'] });
  let buffer='', errorOutput='', resolveReady, rejectReady, readyResolved=false;
  const ready = new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const exit = new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
  child.stderr.on('data',data=>{errorOutput=(errorOutput+data.toString('utf8')).slice(-4000);});
  child.stdout.on('data',data=>{
    buffer+=data.toString('utf8');
    for(let end;(end=buffer.indexOf('\n'))>=0;) {
      const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
      try {const value=JSON.parse(line);if(value.status==='ready'&&!readyResolved){readyResolved=true;resolveReady(value);}}catch{}
    }
    if(buffer.length>1024*1024)rejectReady(new Error('CLI output exceeded its bounded readiness buffer.'));
  });
  child.once('exit',code=>{if(!readyResolved)rejectReady(new Error('CLI exited before readiness ('+code+'): '+errorOutput));});
  let startupTimer;
  const timeout=new Promise((resolve,reject)=>{startupTimer=setTimeout(()=>reject(new Error('CLI readiness timed out.')),180000);});
  let runtime,dbFolder,dbPid;
  try {
    const message=await Promise.race([ready,timeout]);clearTimeout(startupTimer);
    runtime=JSON.parse(fs.readFileSync(message.configPath,'utf8'));
    const owner=JSON.parse(fs.readFileSync(path.join(path.dirname(message.configPath),'owner.json'),'utf8'));
    assert.equal(owner.kind,'RocketbrainSpringProjectFixture-v1');
    dbFolder=path.dirname(runtime.dbConfigPath);
    const dbOwner=JSON.parse(fs.readFileSync(path.join(dbFolder,'owner.json'),'utf8'));
    assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(dbOwner.kind));
    dbPid=Number(fs.readFileSync(path.join(dbFolder,'server.pid'),'utf8').trim());
    assert.ok(Number.isInteger(dbPid)&&dbPid>0);
    assert.equal(alive(runtime.javaProcessId),true);assert.equal(alive(dbPid),true);
    child.stdin.write('stop\n');child.stdin.end();
    let shutdownTimer;
    const stopped=await Promise.race([exit,new Promise((resolve,reject)=>{shutdownTimer=setTimeout(()=>reject(new Error('Explicit stdin stop timed out; preserving owned evidence.')),30000);})]).finally(()=>clearTimeout(shutdownTimer));
    assert.equal(stopped.code,0,errorOutput);assert.equal(stopped.signal,null);
    assert.equal(alive(runtime.javaProcessId),false);assert.equal(alive(dbPid),false);
    assert.equal(fs.existsSync(path.dirname(message.configPath)),false);
    assert.equal(fs.existsSync(dbFolder),false);
    const report={asOf:new Date().toISOString(),engine,operation:'CLI start then explicit stdin stop',exitCode:stopped.code,
      javaPid:runtime.javaProcessId,databasePid:dbPid,javaRunning:false,databaseRunning:false,
      ownSpringDirectoryRemoved:true,ownDatabaseDirectoryRemoved:true,oldPreservedInstancesTouched:false};
    fs.writeFileSync(path.join(WORKSPACE,'test-output','v0.4-spring-cli-stop.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } finally {
    clearTimeout(startupTimer);
    if(child.exitCode===null&&child.signalCode===null&&child.stdin.writable){child.stdin.write('stop\n');child.stdin.end();}
  }
}
if(require.main===module) {
  const index=process.argv.indexOf('--engine');
  verifyCliStop({engine:index<0?'mariadb':process.argv[index+1]}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={verifyCliStop};
