'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile,spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('../../src/java/workbench-tasks');

const execute=promisify(execFile), fixture=path.join(__dirname,'../fixtures/java/kotlin-coroutines');

async function buildCoroutineFixture(root,{javaHome,gradleHome,gradleUserHome}) {
  await fs.cp(fixture,root,{recursive:true});
  const project={root,uri:pathToFileURL(root).href,name:'Kotlin coroutine fixture',tool:'gradle'};
  const spec=buildSpec(project,{javaHome,gradleHome},['installDist']);
  const env={...spec.env,...(gradleUserHome ? {GRADLE_USER_HOME:gradleUserHome} : {})};
  const built=await execute(spec.command,spec.args,{cwd:spec.cwd,env,windowsHide:true,timeout:150000,maxBuffer:3*1024*1024});
  assert.match(built.stdout,/BUILD SUCCESSFUL/);
  const lib=path.join(root,'build/install/rocketbrain-coroutine-fixture/lib');
  const debugJar=path.join(lib,'kotlinx-coroutines-debug-1.11.0.jar');
  assert.ok((await fs.stat(debugJar)).size>10000);
  return {lib,debugJar,java:spec.command,env,root};
}

function launchCoroutineFixture(fixture,prepared,{mainClass='coroutinesfixture.MainKt',classpath=[],env={}}={}) {
  const child=spawn(fixture.java,[...prepared.vmArgs,'-cp',[path.join(fixture.lib,'*'),...classpath].join(path.delimiter),mainClass],
    {cwd:fixture.root,windowsHide:true,env:{...fixture.env,...env},stdio:['pipe','pipe','pipe']});
  let output='',closed=false,failure;
  const done=new Promise(resolve=>child.once('close',code=>{closed=true;resolve(code);}));
  child.once('error',error=>{failure=error;});
  child.stdin.on('error',()=>{});
  for (const stream of [child.stdout,child.stderr]) stream.setEncoding('utf8').on('data',chunk=>{output=(output+chunk).slice(-10000);});
  async function waitFor(marker,timeout=20000){
    const by=Date.now()+timeout;
    while (Date.now()<by && !closed && !failure) {
      if (output.includes(marker)) return output;
      await new Promise(resolve=>setTimeout(resolve,125));
    }
    throw failure || Error('The Kotlin coroutine fixture did not report '+marker+'. '+output);
  }
  return {pid:child.pid,ready:()=>waitFor('Rocketbrain coroutine fixture ready'),waitFor,
    send(line){assert.ok(!closed && /^[a-z]+$/.test(line));child.stdin.write(line+'\n');},
    output:()=>output,async stop(){
    if (!closed) child.stdin.end('\n');
    const timer=setTimeout(()=>{if (!closed) child.kill();},6500);
    try {return await done;}
    finally {clearTimeout(timer);}
  }};
}

module.exports={buildCoroutineFixture,launchCoroutineFixture};
