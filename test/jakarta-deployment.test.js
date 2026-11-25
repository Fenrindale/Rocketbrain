'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { pathToFileURL,fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('../src/java/workbench-tasks');
const { mavenWarProject,listWarArtifacts,resolveWarArtifact } = require('../src/java/jakarta-war');
const { createTomcatDeployment } = require('../src/java/jakarta-tomcat');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { resolveDebugBundles } = require('../src/java/debug-runtime');
const { StdioLsp,until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');

const fixture=path.join(__dirname,'fixtures','java','jakarta-war');
const execute=promisify(execFile);
const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome=process.env.ROCKETBRAIN_MAVEN_HOME;
const tomcatHome=process.env.ROCKETBRAIN_JAKARTA_TOMCAT_HOME;

async function ownedProject(context) {
  const parent=await fs.realpath(os.tmpdir());
  const owned=await fs.mkdtemp(path.join(parent,'rb-jakarta-test-'));
  const root=path.join(owned,'war');
  context.after(async () => {
    const resolved=await fs.realpath(owned);
    assert.equal(resolved,owned);
    assert.equal(path.dirname(resolved),parent);
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  });
  await fs.cp(fixture,root,{recursive:true});
  return {name:'Jakarta fixture',uri:pathToFileURL(root).href,root,tool:'maven'};
}

test('discovers only direct regular WAR artifacts of explicit Maven WAR modules',async context => {
  const project=await ownedProject(context);
  assert.equal(mavenWarProject(project).context,'jakarta-war');
  assert.deepEqual(listWarArtifacts(project),[]);
  await fs.mkdir(path.join(project.root,'target','nested'),{recursive:true});
  const direct=path.join(project.root,'target','ready.war'), nested=path.join(project.root,'target','nested','other.war');
  await fs.writeFile(direct,'fake-archive');
  await fs.writeFile(nested,'fake-archive');
  await fs.writeFile(path.join(project.root,'target','archive.jar'),'irrelevant');
  assert.deepEqual(listWarArtifacts(project).map(item => item.name),['ready.war']);
  assert.equal(resolveWarArtifact(project,pathToFileURL(direct).href).file,direct);
  assert.throws(() => resolveWarArtifact(project,pathToFileURL(nested).href),/directly under/);
  assert.throws(() => mavenWarProject({...project,tool:'gradle'}),/Maven WAR/);
  await fs.writeFile(path.join(project.root,'pom.xml'),'<project><dependencies><packaging>war</packaging></dependencies></project>');
  assert.throws(() => listWarArtifacts(project),/explicitly declare WAR/);
});

function handshake(port) {
  return new Promise((resolve,reject) => {
    const socket=net.createConnection({host:'127.0.0.1',port});
    let response='';
    socket.setTimeout(3000,() => socket.destroy(Error('Debug transport did not respond.')));
    socket.once('connect',() => socket.write('JDWP-Handshake'));
    socket.on('data',chunk => {
      response+=chunk.toString('ascii');
      if (response.length>=14) {socket.destroy();resolve(response.slice(0,14));}
    });
    socket.once('error',reject);
    socket.once('end',() => reject(Error('The debug transport closed without a handshake.')));
  });
}

async function http(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(6000)});
  assert.equal(response.status,200);
  return (await response.text()).trim();
}

async function verifyDebugger(runtime,config,project,options) {
  const {javaHome,serverPath}=config;
  if (!serverPath) return null;
  const bundles=resolveDebugBundles(config.debugBundlePath,serverPath);
  if (!bundles.length) return null;
  const uri=project.uri, sourceRoot=path.join(project.root,'src/main/java');
  const source=path.join(sourceRoot,'jakartafixture/PingServlet.java');
  const lsp=new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(path.dirname(project.root),'engine-state')}));
  let dap, request;
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri:uri,workspaceFolders:[{uri,name:'jakarta-war'}],
      capabilities:{workspace:{configuration:true}},initializationOptions:{bundles,workspaceFolders:[uri],
        settings:serverSettings([{name:'JavaSE-25',path:javaHome,default:true}])}},90000);
    lsp.notify('initialized',{});
    const command=(name,...args) => lsp.request('workspace/executeCommand',{command:name,arguments:args});
    await until(async () => (await command('java.project.getAll')).find(value => !path.relative(project.root,fileURLToPath(value))),90000);
    const active=await runtime.deploy({...options,debug:true});
    dap=new DapClient(await command('vscode.java.startDebugSession'));
    await dap.request('initialize',{adapterID:'rocketbrain-java',clientID:'rocketbrain-jakarta',linesStartAt1:true,
      columnsStartAt1:true,pathFormat:'path',supportsRunInTerminalRequest:false});
    const attaching=dap.request('attach',{type:'rocketbrain-java',name:'Rocketbrain Jakarta fixture',hostName:'127.0.0.1',
      port:active.debugPort,sourcePaths:[sourceRoot]});
    attaching.catch(() => {});
    await dap.event('initialized');
    const line=(await fs.readFile(source,'utf8')).split(/\r?\n/).findIndex(text => text.includes('response.getWriter().print('))+1;
    assert.ok(line>0);
    await dap.request('setBreakpoints',{source:{name:'PingServlet.java',path:source},breakpoints:[{line}]});
    await dap.request('setExceptionBreakpoints',{filters:[]});
    await dap.request('configurationDone');
    await attaching;
    request=fetch(active.url+'/ping',{signal:AbortSignal.timeout(50000)});
    request.catch(() => {});
    const stopped=await dap.event('stopped',0,40000);
    assert.equal(stopped.reason,'breakpoint');
    const frame=(await dap.request('stackTrace',{threadId:stopped.threadId})).stackFrames[0];
    assert.equal(frame.line,line);
    assert.match(frame.name,/PingServlet\.doGet/);
    await dap.request('continue',{threadId:stopped.threadId});
    const response=await request;
    assert.equal(response.status,200);
    await response.text();
    await dap.request('disconnect',{terminateDebuggee:false});
    assert.equal(await http(active.url+'/ping'),'jakarta-servlet:/jakarta-probe:6');
    return {name:frame.name,line,detachedAppStillReady:true};
  } finally {
    await dap?.close();
    await runtime.stop();
    if (request) await request.catch(() => {});
    await lsp.close();
  }
}

test('Maven creates an actual WAR deployed with Servlet, JSP and local JDWP in owned Apache Tomcat',{
  skip:!javaConfig || !mavenHome || !tomcatHome,timeout:210000
},async context => {
  const project=await ownedProject(context);
  const config=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const {javaHome}=config;
  if (process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO) {
    const repo=path.resolve(process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO);
    await fs.mkdir(path.join(project.root,'.mvn'));
    await fs.writeFile(path.join(project.root,'.mvn','maven.config'),'-Dmaven.repo.local='+repo+'\n');
  }
  const spec=buildSpec(project,{javaHome,mavenHome},['package']);
  const built=await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:110000,maxBuffer:3*1024*1024});
  assert.match(built.stdout,/BUILD SUCCESS/);
  const [artifact]=listWarArtifacts(project);
  const sha256=createHash('sha256').update(await fs.readFile(artifact.file)).digest('hex');
  const runtime=createTomcatDeployment();
  const options={artifact,context:'jakarta-probe',javaHome,tomcatHome,workspaceTrusted:true,allowDeploy:true};
  await assert.rejects(runtime.deploy({...options,allowDeploy:false}),/trusted workspace/);
  await assert.rejects(runtime.deploy({...options,context:'../another'}),/context name/);
  await assert.rejects(runtime.deploy({...options,expectedSha256:'0'.repeat(64)}),/artifact changed/);
  assert.equal(runtime.getState().state,'stopped');
  let ready, debug, proof;
  try {
    ready=await runtime.deploy({...options,expectedSha256:sha256});
    assert.match(ready.version,/^11\.0\./);
    assert.match(ready.url,/^http:\/\/127\.0\.0\.1:\d+\/jakarta-probe$/);
    assert.equal(ready.sha256,sha256);
    assert.equal(ready.debugPort,undefined);
    await assert.rejects(runtime.deploy(options),/owned Tomcat deployment/);
    const servlet=await http(ready.url+'/ping'), jsp=await http(ready.url+'/page.jsp');
    assert.equal(servlet,'jakarta-servlet:/jakarta-probe:6');
    assert.equal(jsp,'jakarta-page:/jakarta-probe');
    assert.equal((await runtime.stop()).state,'stopped');
    await assert.rejects(fetch(ready.url+'/ping',{signal:AbortSignal.timeout(1000)}));
    debug=await runtime.deploy({...options,debug:true});
    await runtime.stop(ready.deploymentId);
    assert.equal(runtime.getState().deploymentId,debug.deploymentId);
    const jdwp=await handshake(debug.debugPort);
    assert.equal(jdwp,'JDWP-Handshake');
    assert.equal(await http(debug.url+'/ping'),servlet);
    assert.equal((await runtime.stop()).state,'stopped');
    await assert.rejects(fetch(debug.url+'/ping',{signal:AbortSignal.timeout(1000)}));
    await assert.rejects(handshake(debug.debugPort));
    const debugFrame=await verifyDebugger(runtime,config,project,options);
    proof={tomcat:ready.version,artifact:ready.artifact,sha256,servlet,jsp,jdwp,debugFrame,ownedShutdown:true};
  } finally {await runtime.dispose();}
  if (process.env.ROCKETBRAIN_JAKARTA_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_JAKARTA_RECEIPT,JSON.stringify(proof,null,2)+'\n');
  }
});
