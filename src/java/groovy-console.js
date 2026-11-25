'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { independentJavaExecutable } = require('./debug-runtime');
const source = require('./groovy-console-source.json');

const GROOVY_VERSION = '4.0.28';
const GROOVY_SIZE = 7712577;
const GROOVY_SHA256 = 'd77164a44ab994837e61eecead64721bdb1794fa2bc6704ac6fe70cd32ef9dd3';
const GROOVY_JAR = 'groovy-'+GROOVY_VERSION+'.jar';
const toBase64 = value => Buffer.from(value,'utf8').toString('base64');
const decode = value => Buffer.from(value,'base64').toString('utf8');
const fail = message => Object.assign(Error(message),{code:'ROCKETBRAIN_GROOVY'});

async function verifiedGroovyJar({groovyJar,gradleHome} = {}) {
  const candidate = groovyJar || (gradleHome ? path.join(gradleHome,'lib',GROOVY_JAR) : '');
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !/\.jar$/i.test(candidate)) {
    throw fail('Configure an absolute path to the official Groovy '+GROOVY_VERSION+' JAR or Gradle 9.1 home.');
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== GROOVY_SIZE) {
    throw fail('Choose the official unmodified Groovy '+GROOVY_VERSION+' core JAR.');
  }
  const bytes = await fs.readFile(candidate);
  if (bytes.length !== GROOVY_SIZE || createHash('sha256').update(bytes).digest('hex') !== GROOVY_SHA256) {
    throw fail('The configured Groovy core JAR does not match the pinned Apache Groovy checksum.');
  }
  return bytes;
}

async function removeOwned(parent,root) {
  const resolved = await fs.realpath(root);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('groovy-console-')) {
    throw fail('The Groovy console ownership path changed.');
  }
  await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}

class GroovyConsole {
  constructor(child,cleanup) {
    this.child=child;
    this.closed=false;
    this.sequence=0;
    this.data='';
    this.stderr='';
    this.active=null;
    this.pending=null;
    this.ready=new Promise((resolve,reject) => { this.readyWait={resolve,reject}; });
    void this.ready.catch(() => {});
    this.exited=new Promise(resolve => child.once('close',resolve));
    this.terminated=this.exited.then(cleanup);
    void this.terminated.catch(() => {});
    this.startup=setTimeout(() => this.fail('Groovy console startup timed out.'),15000);
    child.stdout.setEncoding('utf8').on('data',chunk => this.read(chunk));
    child.stderr.setEncoding('utf8').on('data',chunk => { this.stderr=(this.stderr+chunk).slice(-1500); });
    child.on('error',error => this.fail('Groovy console process failed: '+error.message));
    child.stdin.on('error',() => this.fail('The Groovy console input pipe closed.'));
    child.once('close',() => this.fail('The Groovy console process exited.'+(this.stderr ? '\n'+this.stderr : '')));
  }

  fail(message) {
    if (this.closed) return;
    this.closed=true;
    this.failure=fail(message);
    clearTimeout(this.startup);
    this.readyWait?.reject(this.failure);
    this.pending?.reject(this.failure);
    this.readyWait=null;
    this.pending=null;
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  read(chunk) {
    if (this.closed) return;
    this.data+=chunk;
    if (this.data.length > 1024*1024) return this.fail('The Groovy console response exceeded its byte limit.');
    for (let newline; (newline=this.data.indexOf('\n')) >= 0;) {
      const row=this.data.slice(0,newline).replace(/\r$/,'').split('\t');
      this.data=this.data.slice(newline+1);
      if (this.readyWait && row.length === 2 && row[0] === 'READY' && row[1] === GROOVY_VERSION) {
        clearTimeout(this.startup);
        this.readyWait.resolve();
        this.readyWait=null;
        continue;
      }
      const pending=this.pending;
      if (!pending || row.length !== 10 || row[0] !== 'RESULT' || row[1] !== pending.id ||
          !['ok','error'].includes(row[2]) || !/^\d{1,5}$/.test(row[3]) || !/^\d{1,5}$/.test(row[4]) ||
          !['true','false'].includes(row[5]) || row.slice(6).some(value => !/^[A-Za-z0-9+/]*={0,2}$/.test(value))) {
        return this.fail('The Groovy console returned an invalid response.');
      }
      this.pending=null;
      pending.resolve({state:row[2],line:Number(row[3]),column:Number(row[4]),truncated:row[5]==='true',
        stdout:decode(row[6]),stderr:decode(row[7]),value:decode(row[8]),error:decode(row[9])});
    }
  }

  async evaluate(code,name='Console.groovy',{cancellation} = {}) {
    if (this.closed) throw fail('Open a new Groovy console session.');
    if (this.active) throw fail('Wait for the current Groovy evaluation to finish.');
    if (this.sequence >= 60) throw fail('Reset the Groovy console before running more evaluations.');
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code)>64*1024 || code.includes('\0') ||
        typeof name !== 'string' || !/^[\p{L}\p{N}_. -]{1,160}\.groovy$/u.test(name)) {
      throw fail('Use a named nonempty Groovy source selection no larger than 64 KiB.');
    }
    if (cancellation?.isCancellationRequested) throw fail('Groovy evaluation cancelled.');
    const id=String(++this.sequence);
    this.active=id;
    const subscription=cancellation?.onCancellationRequested?.(() => this.fail('Groovy evaluation cancelled.'));
    let timeout;
    try {
      await this.ready;
      if (this.closed) throw this.failure;
      return await new Promise((resolve,reject) => {
        timeout=setTimeout(() => this.fail('Groovy evaluation timed out. The console JVM was stopped.'),15000);
        this.pending={resolve,reject,id};
        this.child.stdin.write('EVAL\t'+id+'\t'+toBase64(code)+'\t'+toBase64(name)+'\n');
      });
    } finally {
      this.active=null;
      clearTimeout(timeout);
      subscription?.dispose();
    }
  }

  dispose() {
    this.fail('The Groovy console session was closed.');
    return this.terminated;
  }
}

async function startGroovyConsole({workspacePath,javaHome,gradleHome,groovyJar,workspaceTrusted} = {}) {
  if (workspaceTrusted !== true) throw fail('Trust the workspace before executing Groovy code.');
  if (!path.isAbsolute(workspacePath || '') || !path.isAbsolute(javaHome || '')) {
    throw fail('Choose a local trusted workspace and configured independent Java runtime.');
  }
  const binary=independentJavaExecutable(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const bytes=await verifiedGroovyJar({groovyJar,gradleHome});
  const parent=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(parent,'groovy-console-'));
  try {
    const worker=path.join(root,'GroovyConsoleWorker.java'), runtime=path.join(root,GROOVY_JAR);
    await fs.writeFile(worker,source,{flag:'wx'});
    await fs.writeFile(runtime,bytes,{flag:'wx'});
    const env={...process.env};
    for (const key of Object.keys(env)) if (['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS','CLASSPATH'].includes(key.toUpperCase())) delete env[key];
    const child=spawn(binary,['-Xmx192m','-cp',runtime,'--source','25',worker],{
      cwd:workspacePath,env,windowsHide:true,stdio:['pipe','pipe','pipe']
    });
    return new GroovyConsole(child,() => removeOwned(parent,root));
  } catch (error) {
    await removeOwned(parent,root);
    throw error;
  }
}

module.exports = { startGroovyConsole,verifiedGroovyJar,GROOVY_VERSION,GROOVY_SHA256 };
