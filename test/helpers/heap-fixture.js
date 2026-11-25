'use strict';

const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {until}=require('./stdio-lsp');

const exec=promisify(execFile);
const homeTool=(home,name)=>path.join(home,'bin',name+(process.platform==='win32'?'.exe':''));

async function ownedHeapFixture(javaHome) {
  const parent=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(parent,'rb-hprof-'));
  const output=path.join(root,'fixture.hprof');
  let child,exit,stderr='',stdout='',failure;
  const close=async()=>{
    if(child?.exitCode===null&&child.signalCode===null){
      child.stdin.end('\n',()=>{});
      const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
      try {await exit;}finally{clearTimeout(timer);}
    }
    const physical=await fs.realpath(root);
    if(path.relative(path.dirname(physical),parent)||!path.basename(physical).startsWith('rb-hprof-'))throw Error('Invalid heap fixture cleanup root.');
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  };
  try {
    const source=path.join(__dirname,'../fixtures/jvm-diagnostics/HeapFixture.java');
    await exec(homeTool(javaHome,'javac'),['-proc:none','-d',root,source],{timeout:20000,windowsHide:true});
    child=spawn(homeTool(javaHome,'java'),['-Xms16m','-Xmx48m','-cp',root,'HeapFixture'],{cwd:root,windowsHide:true});
    child.stdin.on('error',()=>{});
    exit=new Promise(resolve=>{child.once('exit',resolve);child.once('error',error=>{failure=error;resolve();});});
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-4096);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    await until(()=>{
      if(failure||child.exitCode!==null)throw Error('The owned heap JVM exited: '+stderr,{cause:failure});
      return stdout.includes('HEAP_READY');
    },12000);
    const dump=async(all=false)=>{
      const args=[String(child.pid),'GC.heap_dump',...(all?['-all']:[]),path.basename(output)];
      const result=await exec(homeTool(javaHome,'jcmd'),args,{timeout:30000,windowsHide:true});
      const stat=await fs.stat(output).catch(error=>{throw Error(result.stdout,{cause:error});});
      return {stdout:result.stdout,bytes:stat.size};
    };
    return {root,output,pid:child.pid,dump,close};
  }catch(error){await close();throw error;}
}

module.exports={ownedHeapFixture};
