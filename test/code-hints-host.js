'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {javaHintsFixture,kotlinHintsFixture}=require('./helpers/code-hints-fixture');

async function verifyHostHints(api,vscode,document) {
  const config=vscode.workspace.getConfiguration('rocketbrain.editor',document.uri),key=document.languageId+'Hints';
  const target=vscode.ConfigurationTarget.Global,old=config.inspect(key)?.globalValue,source=document.getText();
  const range=new vscode.Range(document.positionAt(0),document.positionAt(source.length));
  const settings=async(parameters,types)=>{
    await config.update(key,{parameters,types},target);
    return async()=>await vscode.commands.executeCommand('vscode.executeInlayHintProvider',document.uri,range)||[];
  };
  const labels=hints=>hints.map(hint=>typeof hint.label==='string'?hint.label:hint.label.map(part=>part.value).join(''));
  const relevant=hints=>labels(hints).filter(label=>/^(?:caption|count):\s*$/.test(label));
  try {
    const get=await settings('all',true);
    const all=await until(async()=>{const hints=await get();return relevant(hints).length===4?hints:undefined;},50000);
    assert.ok(all.some(hint=>hint.kind===vscode.InlayHintKind.Type&&labels([hint])[0].includes('String')));
    assert.ok(all.every(hint=>!hint.textEdits?.length));
    const literals=await settings('literals',false);
    const filtered=await until(async()=>{const hints=await literals();return relevant(hints).length===2?hints:undefined;},25000);
    assert.equal(filtered.length,2);
    const types=await settings('none',true);
    const typeOnly=await until(async()=>{const hints=await types();return hints.length&&!relevant(hints).length?hints:undefined;},25000);
    assert.ok(typeOnly.every(hint=>hint.kind===vscode.InlayHintKind.Type));
    const off=await settings('none',false);
    assert.deepEqual(await off(),[]);
    const position=document.positionAt(source.indexOf('renderHint("literal"')+2);
    const token=await until(()=>api.java.codeHints.inspect({document,position}),50000);
    assert.equal(token.text,'renderHint');
    assert.match(token.type,/method|function/);
    assert.equal(document.isDirty,false);
    assert.equal(document.getText(),source);
    return {allParameters:4,literalParameters:2,inferredTypes:typeOnly.length,hidden:true,semanticToken:token.type,unchangedBuffer:true};
  }finally{await config.update(key,old,target);}
}

async function runJavaCodeHintsChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name='RbInlay'+randomBytes(5).toString('hex'),file=path.join(workspace,'src/main/java/fixture/boot',name+'.java');
  const content=javaHintsFixture('fixture.boot',name,{spring:true});
  await fs.writeFile(file,content,{flag:'wx'});
  try {
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document,{preview:false});
    await api.java.buildWorkspace();
    const commands=await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.editor.configureCodeHints')&&commands.includes('rocketbrain.editor.inspectSemanticToken'));
    const observed=await verifyHostHints(api,vscode,document),jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    assert.equal(await fs.readFile(file,'utf8'),content);
    checks.push('The installed Java editor used real JDT inlays for inferred variable and lambda types, filtered parameter names live and inspected the exact compiler-classified call token.');
    return {springWorkspace:true,jdbc,...observed};
  }finally{await fs.rm(file,{force:true});}
}

async function runKotlinCodeHintsChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const home=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,gradle=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(home,'Use the independent Kotlin editor provider.');
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-hints-'));
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'),target=vscode.ConfigurationTarget.Global,restore=[];
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    for(const [key,value] of [['serverHome',home],['gradleUserHome',gradle]]) {
      if(!value)continue;
      restore.push([key,config.inspect(key)?.globalValue]);
      await config.update(key,value,target);
    }
    const file=path.join(root,'src/main/kotlin/editor/fixture/KotlinHints.kt');
    await fs.writeFile(file,kotlinHintsFixture,{flag:'wx'});
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document,{preview:false});
    await api.java.kotlinEditor.start({document});
    const observed=await verifyHostHints(api,vscode,document);
    checks.push('The installed Kotlin Gradle editor preserved the runtime function token and inferred types while changing parameter hint visibility in place.');
    return {kotlinProvider:true,...observed};
  }finally{
    try {await api.java.kotlinEditor.stop();}
    finally {
      for(const [key,value] of restore.reverse())await config.update(key,value,target);
      const physical=await fs.realpath(root);
      assert.equal(path.relative(path.dirname(physical),workspace),'');assert.match(path.basename(physical),/^rb-kotlin-hints-/);
      await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runJavaCodeHintsChecks,runKotlinCodeHintsChecks};
