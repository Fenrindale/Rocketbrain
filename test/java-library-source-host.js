'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {prepareLibraryFixture}=require('./helpers/library-source-fixture');
const {until}=require('./helpers/stdio-lsp');
const {normalized}=require('../src/java/library-source');

async function removeOwned(parent,root,prefix) {
  const physical=await fs.realpath(root);
  assert.equal(path.relative(path.dirname(physical),parent),'');
  assert.ok(path.basename(physical).startsWith(prefix));
  await fs.rm(physical,{recursive:true,force:true,maxRetries:10,retryDelay:250});
}

async function runJavaLibrarySourceChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const parent=await fs.realpath(os.tmpdir()),scratch=await fs.mkdtemp(path.join(parent,'rb-libsrc-host-')),
    project=await fs.mkdtemp(path.join(workspace,'rb-library-host-'));
  const projectUri=pathToFileURL(project).href,name='LibraryFixture'+path.basename(project).split('-').at(-1);
  const service=api.java.librarySources;
  let virtual,session,breakpoint,terminated=false;
  const events=[];
  const sessionName='Rocketbrain library sources '+name;
  const tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{
    createDebugAdapterTracker(active){
      if(active.configuration.name!==sessionName)return;
      session=active;
      return {onDidSendMessage(message){if(message.type==='event')events.push(message);}};
    }
  });
  try {
    const fixture=await prepareLibraryFixture({project,scratch,javaHome:api.java.getState().javaHome,name});
    await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    const source=await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.file));
    const position=source.positionAt(source.getText().indexOf('convert(8)')+2);
    const target=await until(async()=>{
      const found=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',source.uri,position);
      return found?.map(item=>item.targetUri??item.uri).find(uri=>uri?.scheme==='jdt');
    },45000);
    virtual=await vscode.workspace.openTextDocument(target);
    const editor=await vscode.window.showTextDocument(virtual,{preview:false});
    const original=virtual.getText();
    const inspected=await service.inspect(target);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.manageLibrarySources'));
    assert.equal(inspected.mode,'decompiled');
    assert.equal(normalized(inspected.text),normalized(original));
    assert.match(original,/\* 3/);
    assert.match(original,/> 20/);
    assert.doesNotMatch(original,/exact comment/);
    assert.equal(vscode.window.activeTextEditor,editor);
    editor.selection=new vscode.Selection(0,0,0,0);
    await vscode.commands.executeCommand('type',{text:'probe'});
    assert.equal(virtual.getText(),original);
    assert.equal(virtual.isDirty,false);
    const reviewed=await service.reviewSource(inspected,fixture.sources);
    assert.equal(reviewed.entry,fixture.entry);
    const attached=await service.setAttachment(inspected,reviewed);
    assert.equal(attached.mode,'source');
    await until(()=>normalized(virtual.getText())===fixture.original,15000);
    await assert.rejects(service.setAttachment(inspected,reviewed),/changed/);
    const removed=await service.setAttachment(await service.inspect(target));
    assert.equal(removed.mode,'decompiled');
    await until(()=>virtual.getText()===original,15000);
    assert.equal(virtual.isDirty,false);

    const decompiledLine=original.split(/\r?\n/).findIndex(line=>/\* 3/.test(line))+1;
    breakpoint=new vscode.SourceBreakpoint(new vscode.Location(target,new vscode.Position(decompiledLine-1,0)),true);
    vscode.debug.addBreakpoints([breakpoint]);
    let startupResult,startupError;
    const started=vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(source.uri),{
      type:'rocketbrain-java',request:'launch',name:sessionName,mainClass:'consumer.Sample',projectName:name,
      cwd:project,console:'internalConsole'
    });
    void Promise.resolve(started).then(result=>{startupResult=result;},error=>{startupError=error;});
    await until(()=>{
      if(startupError)throw startupError;
      if(startupResult===false)throw Error('VS Code declined to start the Java library fixture.');
      return startupResult===true;
    },50000);
    const stopped=(await until(()=>events.find(item=>item.event==='stopped'),30000)).body;
    assert.equal(stopped.reason,'breakpoint');
    const {stackFrames}=await session.customRequest('stackTrace',{threadId:stopped.threadId,startFrame:0,levels:1});
    const frame=stackFrames[0];
    assert.match(frame.name,/Meter.convert/);
    assert.equal(frame.line,decompiledLine);
    assert.ok(frame.source.path?.startsWith('jdt:'));
    vscode.debug.removeBreakpoints([breakpoint]);
    await session.customRequest('continue',{threadId:stopped.threadId});
    await until(()=>events.find(item=>item.event==='terminated'),18000);
    terminated=true;
    const observed=events.filter(item=>item.event==='output').map(item=>item.body.output).join('');
    assert.match(observed,/20:10/);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('Opened real decompiled JAR code in VS Code, switched the same read-only editor to and from an exact local source attachment, and stopped a Java debugger at the corresponding decompiled statement.');
    return {springWorkspace:true,jdbc,decompiledBody:true,attachedExactText:true,detachedToSameDecompile:true,
      staleReviewRefused:true,readOnly:true,decompiledLine,debugStopMapped:true,runtimeOutput:'20:10'};
  }finally {
    if(breakpoint)vscode.debug.removeBreakpoints([breakpoint]);
    if(session&&!terminated)void Promise.resolve(vscode.debug.stopDebugging(session)).catch(()=>{});
    tracker.dispose();
    if(virtual&&vscode.window.activeTextEditor?.document.uri.toString()===virtual.uri.toString()) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(()=>{});
    await removeOwned(workspace,project,'rb-library-host-');
    await removeOwned(parent,scratch,'rb-libsrc-host-');
  }
}

module.exports={runJavaLibrarySourceChecks};
