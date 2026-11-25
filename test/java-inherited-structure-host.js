'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {inheritedStructureFixture}=require('./helpers/java-inherited-structure-fixture');
const {until}=require('./helpers/stdio-lsp');

async function runJavaInheritedStructureChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const suffix=randomBytes(5).toString('hex'),baseName='RbOutlineBase'+suffix,childName='RbOutlineChild'+suffix;
  const source=inheritedStructureFixture('fixture.boot',baseName,childName,{spring:true});
  const created=[];
  let base;
  try {
    for (const [name,text] of Object.entries(source)) {
      const file=path.join(workspace,'src/main/java/fixture/boot',name);
      await fs.writeFile(file,text,{flag:'wx'});
      created.push(file);
    }
    base=await vscode.workspace.openTextDocument(vscode.Uri.file(created[0]));
    const child=await vscode.workspace.openTextDocument(vscode.Uri.file(created[1]));
    await vscode.window.showTextDocument(child,{preview:false});
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.fileStructure'));
    const build=await api.java.buildWorkspace();
    assert.ok(build===0||build===1||build?.status==='succeed','JDT project build '+JSON.stringify(build));
    const native=await until(async()=>{
      const symbols=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',child.uri);
      return symbols?.some(symbol=>symbol.name.includes(childName))?symbols:undefined;
    },55000);
    const service=api.java.structure,childText=child.getText();
    const inherited=await service.inspect({document:child,position:child.positionAt(childText.indexOf('int hidden')),group:'inherited'});
    assert.equal(inherited.type,'fixture.boot.'+childName);
    const generic=inherited.members.find(member=>member.label==='inherited'&&member.signature==='(java.lang.String)');
    assert.equal(generic.detail,'java.lang.String');
    assert.ok(inherited.members.some(member=>member.label==='contract'&&member.path.endsWith(baseName+'Contract')));
    assert.ok(!inherited.members.some(member=>['hidden','secret','replaced'].includes(member.label)));
    const binary=inherited.members.find(member=>member.label==='hashCode'&&member.path==='java.lang.Object');
    assert.equal(binary.sourced,false);
    await assert.rejects(service.reveal(inherited,binary.id),/source is unavailable/);
    const baseEditor=await service.reveal(inherited,generic.id);
    assert.equal(path.relative(baseEditor.document.uri.fsPath,base.uri.fsPath),'');
    assert.equal(baseEditor.document.getText(baseEditor.selection),'inherited');
    assert.match(baseEditor.document.lineAt(baseEditor.selection.start.line).text,/\(T value\)/);
    const duplicate=inherited.members.find(member=>member.label==='duplicate');
    const field=await service.reveal(inherited,duplicate.id);
    assert.equal(field.document.getText(field.selection),'duplicate');
    assert.equal(field.document.offsetAt(field.selection.start),field.document.getText().lastIndexOf('duplicate'));
    const nested=await service.inspect({document:child,position:child.positionAt(childText.indexOf('Override public void run')),group:'nested'});
    assert.equal(nested.members.length,5);
    assert.equal(nested.members.find(member=>member.id===nested.currentId).label,'Anonymous Runnable');
    const locals=nested.members.filter(member=>member.origin==='LOCAL');
    assert.equal(locals.length,2);
    assert.notEqual(locals[0].path,locals[1].path);
    const anonymous=nested.members.find(member=>member.label==='Anonymous Consumer');
    const childEditor=await service.reveal(nested,anonymous.id);
    assert.equal(childEditor.document.getText(childEditor.selection),'java.util.function.Consumer<String>');
    const original=base.getText();
    await vscode.window.showTextDocument(base,{preview:false});
    const basePosition=base.positionAt(original.length);
    const edit=new vscode.WorkspaceEdit();
    edit.insert(base.uri,basePosition,'// changed after File Structure');
    assert.equal(await vscode.workspace.applyEdit(edit),true);
    await assert.rejects(service.reveal(inherited,generic.id),/source changed/);
    await vscode.commands.executeCommand('undo');
    await until(()=>!base.isDirty&&base.getText()===original,10000);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The installed Java File Structure resolved inherited generic members to exact superclass and interface bindings, filtered hidden members, and labeled binary sources as unavailable.');
    checks.push('The installed Java File Structure identified named member, local and two anonymous types, opened the exact creation type, and rejected a stale superclass declaration.');
    return {springWorkspace:true,jdbc,nativeSymbols:native.length,genericSignature:generic.signature,
      inheritedSourceJump:true,compoundFieldJump:true,binaryWithoutSource:true,nestedTypes:nested.members.length,
      anonymousTypes:nested.members.filter(member=>member.origin==='ANONYMOUS').length,distinctLocalParents:true,staleSourceRefused:true};
  } finally {
    try {
      if (base?.isDirty) {
        await vscode.window.showTextDocument(base,{preview:false});
        if (vscode.window.activeTextEditor?.document===base) await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } finally {for (const file of created.reverse()) await fs.rm(file,{force:true});}
  }
}

module.exports={runJavaInheritedStructureChecks};
