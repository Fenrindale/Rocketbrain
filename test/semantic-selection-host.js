'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

const expand='rocketbrain.editor.expandSelection',shrink='rocketbrain.editor.shrinkSelection';

async function runSemanticSelectionChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name='RbSelect'+randomBytes(5).toString('hex');
  const java='package fixture.boot;\npublic class '+name+
    ' { void example() { int orderHTTP2Value = 2; System.out.println(orderHTTP2Value); } }\n';
  const sql='SELECT 1;\nSELECT UPPER(person.display_name) AS heading FROM people person WHERE person.id > 1;\n';
  const created=[];
  const advance=async id=>assert.equal(await vscode.commands.executeCommand(id),true,id);
  const value=editor=>editor.selections.map(selection=>editor.document.getText(selection));
  const cursor=(editor,point)=>{
    const position=editor.document.positionAt(point);
    return new vscode.Selection(position,position);
  };
  async function show(file,text) {
    await fs.writeFile(file,text,{flag:'wx'});created.push(file);
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)),{preview:false});
  }
  try {
    const editor=await show(path.join(workspace,'src/main/java/fixture/boot',name+'.java'),java);
    await api.java.buildWorkspace();
    const first=java.indexOf('HTTP')+1,second=java.lastIndexOf('HTTP')+1;
    editor.selections=[cursor(editor,first),cursor(editor,second)];
    await advance(expand);assert.deepEqual(value(editor),['HTTP','HTTP']);
    await advance(expand);assert.deepEqual(value(editor),['orderHTTP2Value','orderHTTP2Value']);
    await advance(shrink);assert.deepEqual(value(editor),['HTTP','HTTP']);
    await advance(shrink);assert.deepEqual(editor.selections.map(selection=>editor.document.offsetAt(selection.active)),[first,second]);
    editor.selections=[cursor(editor,second)];
    await advance(expand);await advance(expand);await advance(expand);
    assert.match(value(editor)[0],/System\.out\.println\(orderHTTP2Value\)/);
    editor.selections=[cursor(editor,first)];
    assert.equal(await vscode.commands.executeCommand(shrink),false);

    const query=await show(path.join(workspace,name+'.sql'),sql);
    const point=sql.indexOf('display_name')+9;
    query.selections=[cursor(query,point)];
    const steps=[];
    for(let depth=0;depth<18&&await vscode.commands.executeCommand(expand);depth++)steps.push(value(query)[0]);
    assert.deepEqual(steps.slice(0,4),['name','display_name','person.display_name','(person.display_name)']);
    assert.ok(steps.includes('UPPER(person.display_name)'));
    assert.ok(steps.includes('SELECT UPPER(person.display_name) AS heading'));
    assert.ok(steps.every(item=>!item.includes('SELECT 1')));
    for(const expected of steps.slice(0,-1).reverse()) {
      await advance(shrink);assert.equal(value(query)[0],expected);
    }
    await advance(shrink);
    assert.equal(query.document.offsetAt(query.selection.active),point);
    assert.equal(await fs.readFile(created[0],'utf8'),java);
    assert.equal(await fs.readFile(created[1],'utf8'),sql);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('Native Rocketbrain keyboard commands expanded Java acronym and identifier ranges through the real JDT statement and restored two cursor positions.');
    checks.push('SQL selection expanded through the qualified column, function and SELECT clause, stayed within the statement and shrank exactly.');
    return {springWorkspace:true,jdbc,javaProvider:'JDT selectionRange',nativeCommands:true,acronym:true,restoredCursors:2,
      manualSelectionInvalidated:true,sqlSteps:steps.length,sqlStatementBoundary:true,exactShrink:true,diskUnchanged:true};
  }finally{for(const file of created.reverse())await fs.rm(file,{force:true});}
}

async function runKotlinSemanticSelectionChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const home=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,gradle=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(home,'Use the independent configured Kotlin runtime.');
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-selection-'));
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'),target=vscode.ConfigurationTarget.Global,originals=[];
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    for(const [key,value] of [['serverHome',home],['gradleUserHome',gradle]]) {
      if(!value)continue;
      originals.push([key,config.inspect(key)?.globalValue]);
      await config.update(key,value,target);
    }
    const text='package editor.fixture\nfun selection() { val orderHTTP2Value = 1; println(orderHTTP2Value) }\n';
    const file=path.join(root,'src/main/kotlin/editor/fixture/SelectionWords.kt');
    await fs.writeFile(file,text,{flag:'wx'});
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    await api.java.kotlinEditor.start({document});
    const at=document.positionAt(text.lastIndexOf('HTTP')+1);
    editor.selection=new vscode.Selection(at,at);
    assert.equal(await vscode.commands.executeCommand(expand),true);
    assert.equal(document.getText(editor.selection),'HTTP');
    assert.equal(await vscode.commands.executeCommand(expand),true);
    assert.equal(document.getText(editor.selection),'orderHTTP2Value');
    let declaration=false,depth=2;
    for(;depth<10&&await vscode.commands.executeCommand(expand);depth++) {
      if(document.getText(editor.selection).startsWith('fun selection()')) {declaration=true;depth++;break;}
    }
    assert.equal(declaration,true);
    for(let step=0;step<depth;step++)assert.equal(await vscode.commands.executeCommand(shrink),true);
    assert.equal(document.offsetAt(editor.selection.active),document.offsetAt(at));
    checks.push('The installed Kotlin selection used the real Gradle language provider, expanded the identifier through the function declaration, and restored the cursor.');
    return {kotlinProvider:true,exactDeclaration:true,restoredCursor:true,steps:depth};
  } finally {
    try {await api.java.kotlinEditor.stop();}
    finally {
      for(const [key,value] of originals.reverse())await config.update(key,value,target);
      const verified=await fs.realpath(root);
      assert.equal(path.relative(path.dirname(verified),workspace),'');assert.match(path.basename(verified),/^rb-kotlin-selection-/);
      await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runSemanticSelectionChecks,runKotlinSemanticSelectionChecks};
