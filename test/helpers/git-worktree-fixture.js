'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomBytes}=require('node:crypto');

const run=promisify(execFile);
const pom=name=>`<project xmlns="http://maven.apache.org/POM/4.0.0">
<modelVersion>4.0.0</modelVersion><groupId>fixture.worktrees</groupId><artifactId>${name}</artifactId><version>1.0.0</version>
<properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
</project>\n`;

async function gitWorktreeFixture(workspace) {
  const parent=await fs.realpath(workspace),folder=await fs.mkdtemp(path.join(parent,'rb-linked-projects-'));
  const main=path.join(folder,'Main Project'),linked=path.join(folder,'Linked Project'),hooks=path.join(folder,'empty-hooks');
  const source='src/main/java/sample/Main.java',suffix=randomBytes(4).toString('hex');
  const git=(cwd,...args)=>run('git',['-c','core.hooksPath='+hooks,'-c','commit.gpgsign=false',
    '-c','user.name=Rocketbrain fixture','-c','user.email=fixture@example.invalid',...args],{
    cwd,timeout:15000,windowsHide:true,
    env:Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)))
  });
  const close=async()=>{
    const verified=await fs.realpath(folder);
    if(path.relative(path.dirname(verified),parent)||!path.basename(verified).startsWith('rb-linked-projects-'))throw Error('Invalid worktree fixture ownership.');
    await fs.rm(verified,{recursive:true,force:true,maxRetries:10,retryDelay:250});
  };
  async function inputs(where,variant){
    await fs.writeFile(path.join(where,'pom.xml'),pom('rb-'+variant+'-'+suffix));
    const target=path.join(where,source);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,`package sample; public class Main { public static void main(String[] args) { System.out.print("${variant}"); } }\n`);
  }
  try {
    await fs.mkdir(main);await fs.mkdir(hooks);
    await git(main,'init','--initial-branch=rb-main');
    await inputs(main,'primary');
    await git(main,'add','--','pom.xml',source);
    await git(main,'commit','-m','Prepare primary fixture');
    await git(main,'worktree','add','-b','rb-linked',linked);
    await inputs(linked,'linked');
    await git(linked,'add','--','pom.xml',source);
    await git(linked,'commit','-m','Prepare linked fixture');
    return {main,linked,source,folder,git,close};
  }catch(error){await close();throw error;}
}

module.exports={gitWorktreeFixture};
