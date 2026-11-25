'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {javaStructureSource,kotlinStructureSource}=require('./helpers/file-structure-fixture');

const flatten=nodes=>(nodes||[]).flatMap(node=>[node,...flatten(node.children)]);

async function nativeOutline(vscode,document,predicate) {
  return until(async()=>{
    const native=flatten(await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',document.uri));
    return predicate(native)?native:undefined;
  },55000);
}

function selectedText(document,range) {
  return document.getText().slice(document.offsetAt(range.start),document.offsetAt(range.end));
}

async function undoSource(vscode,document,source) {
  await vscode.window.showTextDocument(document,{preview:false});
  await vscode.commands.executeCommand('undo');
  await until(()=>document.getText()===source,10000);
  assert.equal(document.isDirty,false);
}

async function runJavaFileStructureChecks(api,vscode,checks) {
  const service=api.java.structure;
  assert.ok(service?.inspect && service?.reveal);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.fileStructure'));
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const className='RbStructure'+randomBytes(5).toString('hex');
  const file=path.join(workspace,'src/main/java/fixture/boot',className+'.java');
  const uri=vscode.Uri.file(file),source=javaStructureSource('fixture.boot',className,{spring:true,bulk:190});
  let document,created=false;
  try{
    await fs.writeFile(file,source,{flag:'wx'});
    created=true;
    document=await vscode.workspace.openTextDocument(uri);
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    await api.java.buildWorkspace();
    const native=await nativeOutline(vscode,document,nodes=>nodes.some(node=>node.name==='modelField189'));
    assert.equal(native.filter(node=>node.name.startsWith('display')).length,2);
    assert.ok(native.find(node=>node.name==='Inner')?.children.some(node=>node.name==='len()'));
    assert.equal(selectedText(document,native.find(node=>node.name==='modelField189').selectionRange),'modelField189');
    const report=await service.inspect({document,position:document.positionAt(source.indexOf('return text.length')),group:'callables'});
    assert.equal(report.members.find(row=>row.id===report.currentId).label,'len()');
    const member=report.members.find(row=>row.label==='display(String)');
    const selected=await service.reveal(report,member.id);
    assert.equal(selected.document.getText(selected.selection),'display');
    assert.ok(document.lineAt(selected.selection.start.line).text.includes('String input'));
    const fields=await service.inspect({document,group:'members'});
    assert.equal(fields.members.filter(item=>item.label.startsWith('modelField')).length,190);
    const at=source.indexOf('display(int input)');
    assert.equal(await editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(at),document.positionAt(at+7)),'updatedDisplay')),true);
    await assert.rejects(service.reveal(report,member.id),/source changed/);
    const updated=await nativeOutline(vscode,document,nodes=>nodes.some(node=>node.name==='updatedDisplay(int)'));
    assert.equal(updated.filter(node=>node.name.startsWith('display')).length,1);
    await undoSource(vscode,document,source);
    assert.equal(await fs.readFile(file,'utf8'),source);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The native Java Outline exposed nested record, interface, overloaded methods and a 190-field imported Spring unit with exact source anchors.');
    checks.push('The File Structure action selected an exact overload and deepest current method, refreshed an unsaved rename, and rejected stale navigation.');
    return {springWorkspace:true,jdbc,nativeSymbols:native.length,largeFields:190,nestedRecord:true,distinctOverloads:2,
      currentMethod:true,exactSelection:true,unsavedRefresh:true,staleJumpRefused:true,nativeUndo:true};
  }finally{
    try {
      if(document?.isDirty){await vscode.window.showTextDocument(document,{preview:false});if(vscode.window.activeTextEditor?.document===document)await vscode.commands.executeCommand('workbench.action.files.revert');}
    }finally{if(created)await fs.rm(file,{force:true});}
  }
}

async function runKotlinFileStructureChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const home=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,gradle=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(home,'Use the owned Kotlin Gradle editor runtime.');
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-structure-'));
  const settings=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'),configurationTarget=vscode.ConfigurationTarget.Global;
  const restore=[];
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    for(const [key,value] of [['serverHome',home],['gradleUserHome',gradle]]){
      if(!value)continue;
      restore.push([key,settings.inspect(key)?.globalValue]);
      await settings.update(key,value,configurationTarget);
    }
    const source=kotlinStructureSource('editor.fixture','NativeOutline'),file=path.join(root,'src/main/kotlin/editor/fixture/NativeOutline.kt');
    await fs.writeFile(file,source,{flag:'wx'});
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await api.java.kotlinEditor.start({document});
    const native=await nativeOutline(vscode,document,nodes=>nodes.some(node=>node.name==='visible'));
    assert.equal(native.filter(node=>node.name==='display').length,2);
    assert.ok(native.find(node=>node.name==='Companion')?.children.some(node=>node.name==='FLAG'));
    assert.equal(selectedText(document,native.find(node=>node.name==='spaced name').selectionRange),'`spaced name`');
    const service=api.java.structure,report=await service.inspect({document,group:'callables'});
    const overloads=report.members.filter(row=>row.label==='display');
    assert.deepEqual(overloads.map(row=>row.signature),['(x: Int)','(x: String)']);
    const selected=await service.reveal(report,overloads[1].id);
    assert.equal(selected.document.getText(selected.selection),'display');
    assert.match(document.lineAt(selected.selection.start.line).text,/x: String/);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The native Kotlin Outline kept constructor, companion members and backtick names, and File Structure opened the selected typed overload.');
    return {springWorkspace:true,jdbc,server:api.java.kotlinEditor.getState().serverVersion,nativeSymbols:native.length,
      companion:true,exactBacktick:true,overloadSignatures:overloads.map(row=>row.signature),exactSelection:true};
  } finally {
    try {await api.java.kotlinEditor.stop();}
    finally {
      for(const [key,value] of restore.reverse())await settings.update(key,value,configurationTarget);
      const real=await fs.realpath(root);
      assert.equal(path.relative(path.dirname(real),workspace),'');
      assert.match(path.basename(real),/^rb-kotlin-structure-/);
      await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runJavaFileStructureChecks,runKotlinFileStructureChecks};
