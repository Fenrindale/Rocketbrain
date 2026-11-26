'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {StringDecoder}=require('node:string_decoder');
const {independentJavaExecutable}=require('./debug-runtime');
const {fail,cancelled}=require('./workbench-model');
const {hashArchive}=require('./jakarta-tomcat');
const {contextPattern,artifactName}=require('./jakarta-war');
const {inspectWar}=require('./jakarta-archive');
const {inspectEar}=require('./jakarta-ear');

const VERSION='42.0.0.Final';
const SHA=/^[a-f0-9]{64}$/u;
const maxLogCharacters=512*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const moduleBase='modules/system/layers/base/org/jboss/as';
const configFiles={
  'standalone.xml':'5a0f05824f834aea9919f9137522d188b301e097a72156d7767b27fd636e6562',
  'logging.properties':'0e872f23eb1761caef0b26620f2f0ebcbab46cc8e579c102de8e40d1070262f6',
  'application-roles.properties':'b62cd8eea5e68f62337e823e41386bcbba9afba7762042e0aabb09a510db1efb',
  'application-users.properties':'ba4931696dae2be81d6c855aff76869888bbb4af4bb99431cf33437fd3726761',
  'mgmt-groups.properties':'8630463dccf8ad9ee6604179e4d75b13a498caf50aac6319df50027dc07a3aea',
  'mgmt-users.properties':'6acae6a222c4b21bde491a27a4d00acc15ea9e528daab69fb301681dee03515e'
};
const launchFiles={
  'jboss-modules.jar':'ea09e6c8410d57a5d3ae641241be6848bd4ab2e4363e0992a6e2b349229888c3',
  'bin/product.conf':'e3dde83ef01aa81dd1e4b41d493959977efc58d10a156f8122cce6ef6f80f6b0',
  [moduleBase+'/server/main/module.xml']:'7568162c8f5ef2bea533ba2f30b6f9355d3eb10a05abe40f083f2a15c18d9cbe',
  [moduleBase+'/server/main/wildfly-server-34.0.0.Final.jar']:'973ed936c2015c7546ddf0bf1bf80f77bd8a901678fcba56b4a6d75399bc8ec7',
  [moduleBase+'/product/main/module.xml']:'603fbf6f3139f919257e691cc258baa0cf8c9b5770c79ee9e9e19dc9153ed17b',
  [moduleBase+'/product/main/wildfly-feature-pack-product-conf-42.0.0.Final.jar']:
    'ef7ceae5aaec1fac6b2c2d3a3ad4da1af7c9726d3b296e9ab865aed1b49fe725'
};
const opens=[
  'java.base/java.lang','java.base/java.lang.invoke','java.base/java.lang.reflect','java.base/java.io',
  'java.base/java.net','java.base/java.security','java.base/java.util','java.base/java.util.concurrent',
  'java.base/sun.reflect.annotation','java.management/javax.management','java.naming/javax.naming'
];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sameLocation=(a,b)=>!path.relative(a,b);
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

async function physical(value,directory=false) {
  const stat=await fs.lstat(value,{bigint:true});
  if (stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile())||
      !sameLocation(value,await fs.realpath(value))) throw fail('Use physical WildFly and Java installation paths.');
  return stat;
}

async function boundedFile(file,maxBytes) {
  const first=await physical(file);
  if (first.size<1n||first.size>BigInt(maxBytes)) throw fail('The WildFly runtime contains an unsupported file size.');
  const handle=await fs.open(file,'r');
  try {
    if (!sameFile(first,await handle.stat({bigint:true}))) throw fail('The WildFly runtime changed during review.');
    const bytes=Buffer.alloc(Number(first.size));
    const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if (bytesRead!==bytes.length||!sameFile(first,await handle.stat({bigint:true}))||
        !sameFile(first,await physical(file))) throw fail('The WildFly runtime changed during review.');
    return bytes;
  } finally {await handle.close();}
}

async function inspectWildFlyRuntime(wildflyHome,javaHome) {
  if (!path.isAbsolute(wildflyHome||'')) {
    throw fail('Set rocketbrain.java.jakarta.wildflyHome to the extracted stock WildFly '+VERSION+' distribution.');
  }
  try {
    const home=path.resolve(wildflyHome);
    await physical(home,true);
    const modules=path.join(home,'modules'), moduleStat=await physical(modules,true);
    const config=path.join(home,'standalone/configuration');
    await physical(config,true);
    const configuration={};
    for (const [name,sha256] of Object.entries(configFiles)) {
      const bytes=await boundedFile(path.join(config,name),64*1024);
      if (digest(bytes)!==sha256) throw fail('Stock WildFly configuration has changed.');
      configuration[name]=bytes;
    }
    for (const [name,sha256] of Object.entries(launchFiles)) {
      if (digest(await boundedFile(path.join(home,name),4*1024*1024))!==sha256) {
        throw fail('Stock WildFly launcher files have changed.');
      }
    }
    const executable=javaHome&&path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
    const java=independentJavaExecutable(executable);
    const jdk=path.dirname(path.dirname(java)), javaStat=await physical(java);
    const release=await boundedFile(path.join(jdk,'release'),64*1024);
    if (!/^JAVA_VERSION="25(?:[."])/mu.test(release.toString('utf8'))) {
      throw fail('Use a supported independent JDK 25 for WildFly '+VERSION+'.');
    }
    const stamp=stat=>[stat.dev,stat.ino,stat.mtimeNs,stat.ctimeNs].join(':');
    const fingerprint=digest(JSON.stringify([home,stamp(moduleStat),java,stamp(javaStat),digest(release)]));
    return {home,java,modules,configuration,fingerprint};
  } catch (error) {
    if (error.code==='ROCKETBRAIN_JAVA_WORKBENCH') throw error;
    throw fail('Choose a readable stock WildFly '+VERSION+' distribution and an independent JDK 25.');
  }
}

function stagedConfiguration(bytes) {
  // The configuration input is checked against the exact vendor digest first.
  return bytes.toString('utf8')
    .replace('scan-interval="5000"','scan-interval="750" auto-deploy-zipped="false" auto-deploy-exploded="false" auto-deploy-xml="false"')
    .replace('name="txn-recovery-environment" port="4712"','name="txn-recovery-environment" port="0"')
    .replace('name="txn-status-manager" port="4713"','name="txn-status-manager" port="0"');
}

async function removeBase(session) {
  if (!session.base) return;
  const location=await fs.realpath(session.base), identity=await fs.lstat(location,{bigint:true});
  if (!sameLocation(session.base,location)||!sameLocation(session.parent,path.dirname(location))||
      !path.basename(location).startsWith('rb-wildfly-')||identity.ino!==session.identity.ino||
      identity.dev!==session.identity.dev||!identity.isDirectory()||identity.isSymbolicLink()) {
    throw fail('The WildFly staging directory changed ownership. It was left in place.');
  }
  await fs.rm(location,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  session.base=undefined;
}

function localEnvironment() {
  const allowed=/^(?:path|pathext|systemroot|windir|comspec|systemdrive|tmp|temp|lang|lc_[A-Z_]+)$/iu;
  return Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.test(key)));
}

function spawnWildFly(runtime,base) {
  const location=part=>path.join(base,part);
  const args=[
    ...opens.map(name=>'--add-opens='+name+'=ALL-UNNAMED'),
    '-Xms96m','-Xmx768m','-Djava.awt.headless=true','-Djava.net.preferIPv4Stack=true',
    '-Duser.home='+location('home'),'-Djava.io.tmpdir='+location('tmp'),
    '-Djboss.home.dir='+runtime.home,'-Djboss.server.base.dir='+base,
    '-Djboss.bind.address=127.0.0.1','-Djboss.bind.address.management=127.0.0.1',
    '-Djboss.http.port=0','-Djboss.https.port=0','-Djboss.management.http.port=0','-Djboss.management.https.port=0',
    '-Dorg.jboss.boot.log.file='+location('log/server.log'),
    '-Dlogging.configuration='+pathToFileURL(location('configuration/logging.properties')).href,
    '-jar',path.join(runtime.home,'jboss-modules.jar'),'-mp',runtime.modules,'org.jboss.as.standalone',
    '--read-only-server-config=standalone.xml'
  ];
  return spawn(runtime.java,args,{cwd:base,env:localEnvironment(),windowsHide:true,shell:false,
    stdio:['ignore','pipe','pipe']});
}

function observedOutput(session,stream,log) {
  const decoder=new StringDecoder('utf8');
  let pending='';
  stream.on('data',bytes=>{
    const text=decoder.write(bytes);
    const remaining=maxLogCharacters-session.loggedCharacters;
    if (remaining>0) {
      const output=text.slice(0,remaining);
      session.loggedCharacters+=output.length;
      log(output);
      if (session.loggedCharacters===maxLogCharacters) log('\nWildFly session output reached its display limit.\n');
    }
    const lines=(pending+text).split(/\r?\n/u);
    pending=lines.pop().slice(-4000);
    for (const line of lines) {
      const address=/\bWFLYUT0006: Undertow HTTP listener default listening on 127\.0\.0\.1:(\d{1,5})\s*$/u.exec(line);
      const port=Number(address?.[1]);
      if (port>1024&&port<65536) session.httpPort=port;
      if (line.includes('WFLYSRV0025: WildFly '+VERSION+' ')) session.boot=true;
      if (line.includes('WFLYSRV0026: WildFly '+VERSION+' ')) session.bootFailed=true;
      if (line.includes("WFLYUT0021: Registered web context: '/"+session.context+"'")) session.contextRegistered=true;
    }
  });
}

async function waitForProcess(session,milliseconds) {
  let timer;
  try {
    return await Promise.race([session.closed.then(()=>true),new Promise(resolve=>{
      timer=setTimeout(()=>resolve(false),milliseconds);
    })]);
  } finally {clearTimeout(timer);}
}

function canConnect(port) {
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    const settled=value=>{socket.destroy();resolve(value);};
    socket.once('error',()=>settled(false));
    socket.once('connect',()=>settled(true));
    socket.setTimeout(500,()=>settled(false));
  });
}

function createWildFlyDeployment({log=()=>{},startupMs=100000}={}) {
  let active, disposed=false;
  const status=()=>active?{state:active.state,version:VERSION,context:active.context,artifact:active.artifact,
    sha256:active.sha256,...(active.ear?{kind:'ear',ear:structuredClone(active.ear)}:{}),
    ...(active.url?{url:active.url}:{})}:{state:'stopped'};

  function release(session) {
    if (session.release) return session.release;
    session.state='stopping';
    session.release=(async()=>{
      if (session.child&&!session.exited) {
        session.child.kill('SIGTERM');
        if (!await waitForProcess(session,4000)) {
          session.child.kill('SIGKILL');
          if (!await waitForProcess(session,4000)) throw fail('The owned WildFly JVM did not stop.');
        }
      }
      await removeBase(session);
      if (active===session) active=undefined;
    })();
    void session.release.catch(()=>{session.release=undefined;session.state='cleanup-failed';});
    return session.release;
  }

  function ensureStarting(session,cancellation) {
    if (disposed||session.stopRequested||cancelled(cancellation)) throw fail('WildFly deployment cancelled.');
    if (session.error||session.exited||session.bootFailed) {
      throw fail('The owned WildFly server did not start successfully. See the Jakarta output.');
    }
  }

  async function stageAndStart(session,{artifact,expectedRuntime,javaHome,wildflyHome,cancellation}) {
    const runtime=await inspectWildFlyRuntime(wildflyHome,javaHome);
    if (runtime.fingerprint!==expectedRuntime) throw fail('The WildFly or Java installation changed after review.');
    ensureStarting(session,cancellation);
    session.parent=await fs.realpath(os.tmpdir());
    session.base=await fs.mkdtemp(path.join(session.parent,'rb-wildfly-'));
    session.identity=await fs.lstat(session.base,{bigint:true});
    for (const name of ['configuration','deployments','data','log','tmp','home']) {
      await fs.mkdir(path.join(session.base,name));
    }
    for (const [name,bytes] of Object.entries(runtime.configuration)) {
      await fs.writeFile(path.join(session.base,'configuration',name),
        name==='standalone.xml'?stagedConfiguration(bytes):bytes,{flag:'wx'});
    }
    const staged=path.join(session.base,'deployments',session.ear?artifact.name:session.context+'.war');
    await hashArchive(artifact,{destination:staged,expectedSha256:session.sha256});
    if (session.ear) {
      if(JSON.stringify(await inspectEar(staged))!==JSON.stringify(session.ear)) {
        throw fail('The reviewed EAR module descriptors changed during staging.');
      }
    }else await inspectWar(staged);
    await fs.writeFile(staged+'.dodeploy','',{flag:'wx'});
    if ((await inspectWildFlyRuntime(wildflyHome,javaHome)).fingerprint!==expectedRuntime) {
      throw fail('The WildFly or Java installation changed during staging.');
    }
    ensureStarting(session,cancellation);
    session.child=spawnWildFly(runtime,session.base);
    session.child.once('error',error=>{session.error=error;});
    session.closed=new Promise(resolve=>session.child.once('close',()=>{
      session.exited=true;
      resolve();
      if (session.state==='running') void release(session).catch(error=>log(error.message+'\n'));
    }));
    for (const stream of [session.child.stdout,session.child.stderr]) observedOutput(session,stream,log);
    const deadline=Date.now()+startupMs;
    while (Date.now()<deadline) {
      ensureStarting(session,cancellation);
      if (await marker(staged+'.failed')) throw fail('WildFly rejected the '+session.kind+'. See the Jakarta output.');
      if (session.boot&&session.httpPort&&session.contextRegistered&&await marker(staged+'.deployed')&&
          await canConnect(session.httpPort)) {
        await hashArchive({...artifact,file:staged},{expectedSha256:session.sha256});
        ensureStarting(session,cancellation);
        session.url='http://127.0.0.1:'+session.httpPort+'/'+session.context;
        session.state='running';
        return status();
      }
      await pause(150);
    }
    throw fail('Timed out waiting for the owned WildFly server and reviewed '+session.kind+' to be ready.');
  }

  async function marker(file) {
    try {await physical(file);return true;}
    catch (error) {if(error.code==='ENOENT') return false;throw error;}
  }

  async function deploy(options) {
    const {context,artifact,expectedSha256,expectedRuntime,workspaceTrusted,allowDeploy,ear}=options;
    const kind=ear?'EAR':'WAR';
    if (disposed||!workspaceTrusted||allowDeploy!==true) throw fail('Approve the local WildFly '+kind+' deployment first.');
    if (active) throw fail('Stop the active WildFly deployment before deploying another '+kind+'.');
    if (!contextPattern.test(context||'')||!artifact?.name||!SHA.test(expectedSha256||'')||!SHA.test(expectedRuntime||'')||
        (ear&&(!artifactName.test(artifact.name)||!artifact.name.endsWith('.ear')||ear.context!==context))) {
      throw fail('Review a physical Maven '+kind+', its digest and the selected WildFly runtime before deploying.');
    }
    const session={state:'starting',context,artifact:artifact.name,sha256:expectedSha256,kind,
      ear:ear&&structuredClone(ear),loggedCharacters:0};
    active=session;
    session.operation=stageAndStart(session,options);
    try {return await session.operation;}
    catch (error) {await release(session);throw error;}
  }

  async function stop() {
    const session=active;
    if (session) {
      session.stopRequested=true;
      await session.operation.catch(()=>{});
      await release(session);
    }
    return status();
  }
  return {deploy,stop,status,async dispose(){disposed=true;return stop();}};
}

module.exports={VERSION,inspectWildFlyRuntime,createWildFlyDeployment,inspectWar};
