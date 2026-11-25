'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

const fixture=path.join(__dirname,'fixtures','java','jakarta-war');

async function waitFor(action,timeout) {
  const end=Date.now()+timeout;
  while (Date.now()<end) {
    const value=action();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve,150));
  }
  throw Error('The owned Tomcat debugger did not report its servlet breakpoint.');
}

async function get(url,timeout=6000) {
  const response=await fetch(url,{signal:AbortSignal.timeout(timeout)});
  assert.equal(response.status,200);
  return (await response.text()).trim();
}

async function runJakartaChecks(api,vscode,checks) {
  const service=api.java.jakarta;
  assert.ok(service?.buildWar && service?.deploy && service?.debug && service?.getState && service?.stop);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands=await vscode.commands.getCommands(true);
  for (const command of ['buildWar','deploy','debug','status','stop']) assert.ok(commands.includes('rocketbrain.jakarta.'+command));
  const root=await fs.mkdtemp(path.join(workspace,'rb-jakarta-'));
  const projectUri=vscode.Uri.file(root).toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.java'), target=vscode.ConfigurationTarget.Global;
  const changed=[];
  async function setting(name,value) {
    if (!value) return;
    const previous=config.inspect(name)?.globalValue;
    await config.update(name,value,target);
    changed.push({name,previous});
  }
  const source=vscode.Uri.file(path.join(root,'src/main/java/jakartafixture/PingServlet.java'));
  let tracker, breakpoint, request;
  try {
    await fs.cp(fixture,root,{recursive:true});
    await setting('mavenHome',process.env.ROCKETBRAIN_MAVEN_HOME);
    await setting('jakarta.tomcatHome',process.env.ROCKETBRAIN_JAKARTA_TOMCAT_HOME);
    assert.ok(config.get('mavenHome'),'Set ROCKETBRAIN_MAVEN_HOME for the release profile.');
    assert.ok(config.get('jakarta.tomcatHome'),'Set ROCKETBRAIN_JAKARTA_TOMCAT_HOME for the release profile.');
    if (process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO) {
      await fs.mkdir(path.join(root,'.mvn'));
      await fs.writeFile(path.join(root,'.mvn','maven.config'),'-Dmaven.repo.local='+path.resolve(process.env.ROCKETBRAIN_JAKARTA_MAVEN_REPO)+'\n');
    }
    const imported=await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    assert.ok(imported.projects.some(item => !path.relative(item.root,root) && item.tool==='maven'));
    assert.deepEqual(await service.artifacts({projectUri}),[]);
    await assert.rejects(service.buildWar({projectUri}),/Explicitly build/);
    const built=await service.buildWar({projectUri,allowProjectExecution:true});
    assert.equal(built.state,'succeeded');
    assert.deepEqual(built.artifacts.map(item => item.name),['jakarta-war-1.0.0.war']);
    const input={projectUri,warUri:built.artifacts[0].uri,context:'rocket-app'};
    await assert.rejects(service.deploy(input),/Explicitly deploy/);
    const managed=await service.deploy({...input,allowDeploy:true});
    assert.match(managed.url,/^http:\/\/127\.0\.0\.1:\d+\/rocket-app$/);
    assert.equal(service.getState().deploymentId,managed.deploymentId);
    const servlet=await get(managed.url+'/ping'), jsp=await get(managed.url+'/page.jsp');
    assert.equal(servlet,'jakarta-servlet:/rocket-app:6');
    assert.equal(jsp,'jakarta-page:/rocket-app');
    assert.equal((await vscode.commands.executeCommand('rocketbrain.jakarta.stop')).state,'stopped');
    await assert.rejects(fetch(managed.url+'/ping',{signal:AbortSignal.timeout(1000)}));

    const document=await vscode.workspace.openTextDocument(source);
    await vscode.window.showTextDocument(document,{preview:false});
    const line=document.getText().split(/\r?\n/).findIndex(text => text.includes('response.getWriter().print('));
    assert.ok(line>=0);
    breakpoint=new vscode.SourceBreakpoint(new vscode.Location(source,new vscode.Position(line,0)),true);
    vscode.debug.addBreakpoints([breakpoint]);
    const sessions=new Map(), events=[];
    tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(session){
      sessions.set(session.id,session);
      return {onDidSendMessage(message) {
        if (message.type==='event' && message.event==='stopped') events.push({id:session.id,...message.body});
      }};
    }});
    const debug=await service.debug({...input,expectedSha256:managed.sha256,allowDeploy:true});
    const session=sessions.get(debug.sessionId);
    assert.ok(session);
    request=get(debug.url+'/ping',60000);
    request.catch(() => {});
    const stopped=await waitFor(() => events.find(event => event.id===session.id && event.reason==='breakpoint'),50000);
    const stack=await session.customRequest('stackTrace',{threadId:stopped.threadId});
    const frame=stack.stackFrames[0];
    assert.match(frame.name,/PingServlet\.doGet/);
    assert.equal(frame.line,line+1);
    assert.ok(frame.source?.path?.endsWith('PingServlet.java'));
    vscode.debug.removeBreakpoints([breakpoint]);
    await session.customRequest('continue',{threadId:stopped.threadId});
    assert.equal(await request,servlet);
    await vscode.debug.stopDebugging(session);
    assert.equal(await get(debug.url+'/ping'),servlet);
    await service.stop();
    await assert.rejects(fetch(debug.url+'/ping',{signal:AbortSignal.timeout(1000)}));
    const jdbc=await jdbcReadback();
    checks.push('Built a Maven WAR, deployed Servlet and JSP on portable Tomcat, hit a real servlet source breakpoint, detached, and verified owned service shutdown.');
    return {tomcat:managed.version,artifact:managed.artifact,sha256:managed.sha256,context:managed.context,
      servlet,jsp,debugFrame:{name:frame.name,line:frame.line},detachedAppStillReady:true,ownedShutdown:true,springWorkspace:true,jdbc};
  } finally {
    if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
    tracker?.dispose();
    await service.stop();
    if (request) await request.catch(() => {});
    for (const editor of vscode.window.visibleTextEditors.filter(item => item.document.uri.fsPath===source.fsPath)) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const entry of changed.reverse()) await config.update(entry.name,entry.previous,target);
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(() => {});
    const verified=await fs.realpath(root);
    if (path.relative(path.dirname(verified),workspace) || !path.basename(verified).startsWith('rb-jakarta-')) {
      throw Error('Jakarta fixture ownership changed before cleanup.');
    }
    await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

module.exports = { runJakartaChecks };
