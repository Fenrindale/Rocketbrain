'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentJavaExecutable } = require('../src/java/debug-runtime');
const { version } = require('../src/java/scala-editor-runtime');

const coursierSha256 = 'd3135830850eddfb9998be66ab4c79478ee6cff56012bb5a177532b1df47c7cc';
const execute = promisify(execFile);

async function provision({javaHome,coursier,target}) {
  if (![javaHome,coursier,target].every(value=>path.isAbsolute(value || ''))) {
    throw Error('Pass the absolute JDK home, Coursier 2.1.26 JAR and installation directory.');
  }
  const jar = await fs.realpath(coursier);
  if (path.relative(jar,coursier) || (await fs.stat(jar)).size > 64*1024*1024 ||
      createHash('sha256').update(await fs.readFile(jar)).digest('hex') !== coursierSha256) {
    throw Error('Use the official Coursier 2.1.26 standalone JAR.');
  }
  const command = independentJavaExecutable(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  await fs.mkdir(target,{recursive:true});
  const root = await fs.realpath(target);
  const env = {...process.env,COURSIER_CACHE:path.join(root,'cache'),COURSIER_REPOSITORIES:'https://repo.maven.apache.org/maven2'};
  for (const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','JAVA_OPTS']) delete env[key];
  const args = ['-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-jar',jar,'fetch','--classpath','org.scalameta:metals_2.13:'+version];
  const {stdout} = await execute(command,args,{cwd:root,env,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  const entries = stdout.trim().split(path.delimiter);
  if (entries.length < 4 || !entries.every(entry=>path.isAbsolute(entry)&&entry.endsWith('.jar'))) {
    throw Error('Coursier did not return the Scala runtime classpath.');
  }
  const file = path.join(root,'classpath.txt');
  try {
    await fs.writeFile(file,stdout.trim()+'\n',{flag:'wx'});
  } catch (error) {
    if (error.code !== 'EEXIST' || (await fs.readFile(file,'utf8')).trim() !== stdout.trim()) throw error;
  }
  console.log(JSON.stringify({version,classpathFile:file,jars:entries.length}));
}

const [javaHome,coursier,target] = process.argv.slice(2);
provision({javaHome,coursier,target}).catch(error=>{
  console.error(error.message);
  process.exitCode = 1;
});
