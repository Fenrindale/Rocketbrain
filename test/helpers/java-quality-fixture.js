'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const { execFile }=require('node:child_process');
const { promisify }=require('node:util');

const run=promisify(execFile);
const stable='src/main/java/sample/Qualité.java';
const added='src/main/java/sample/NewCheck.java';
const fixed='src/main/java/sample/Completed.java';
const oldSource=`package sample;
public class Qualité {
    int check(boolean feature) {
        if (feature);
        return 1;
    }
}
`;
const committed='// An unrelated line introduced before the class.\n\n'+oldSource;
const introduced=`package sample;
public class NewCheck {
    void run() {
        try { throw new IllegalStateException("temporary"); }
        catch (IllegalStateException problem) { }
    }
}
`;
const resolved=`package sample;
public class Completed {
    int run() {
        try { return 2; }
        finally { }
    }
}
`;

async function createQualityFixture(parent) {
  const root=await fs.mkdtemp(path.join(parent,'rb-quality-'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  env.GIT_CONFIG_NOSYSTEM='1';
  const git=async(...args)=>(await run('git',['-c','user.name=Rocketbrain Fixture','-c','user.email=fixture@example.invalid',
    '-c','core.autocrlf=false','-c','commit.gpgSign=false','-c','core.hooksPath='+path.join(root,'.no-hooks'),...args],
    {cwd:root,env,windowsHide:true,timeout:12000})).stdout.trim();
  const write=(relative,text)=>fs.writeFile(path.join(root,relative),text,'utf8');
  async function cleanup() {
    if (path.relative(parent,path.dirname(root)) || !path.basename(root).startsWith('rb-quality-')) throw Error('Unsafe Java quality fixture path.');
    await fs.rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
  try {
    await git('init','--quiet','--template=');
    await fs.mkdir(path.join(root,'src/main/java/sample'),{recursive:true});
    await write(stable,oldSource);
    await write(fixed,resolved);
    await git('add','--',stable,fixed);
    await git('commit','--quiet','-m','Baseline inspections');
    const baseline=await git('rev-parse','HEAD');
    await write(stable,committed.replaceAll('\n','\r\n'));
    await write(added,introduced);
    await write(fixed,resolved.replace('finally { }','finally { System.nanoTime(); }'));
    await git('add','--',stable,added,fixed);
    await git('commit','--quiet','-m','Add new catch issue and fix old finally');
    const current=await git('rev-parse','HEAD');
    return {root,git,write,baseline,current,stable,added,fixed,committed,introduced,cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function runQualityCli(node,cli,args) {
  try {
    const result=await run(node,[cli,...args],{windowsHide:true,timeout:30000,maxBuffer:9*1024*1024});
    return {exit:0,...result};
  } catch (error) {
    if (![1,2].includes(error.code)) throw error;
    return {exit:error.code,stdout:error.stdout,stderr:error.stderr};
  }
}

module.exports={createQualityFixture,runQualityCli};
