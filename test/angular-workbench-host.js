'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {setTimeout:wait}=require('node:timers/promises');
const {ownedAngularFixture}=require('./helpers/angular-workspace-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');

const source='src/dashboard.component.ts', template='src/dashboard.component.html';
const prefix='rocketbrain.angular.';

async function until(check) {
  const deadline=Date.now()+7000;
  while(Date.now()<deadline) {
    if(await check())return;
    await wait(40);
  }
  throw Error('The Angular fixture editor did not synchronize.');
}

async function exerciseAngular(angular,vscode,root) {
  const typescript=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,source)));
  const html=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,template)));
  const original=html.getText(), beforeBytes=await fs.readFile(html.uri.fsPath);
  const versions=await angular.start({uri:html.uri,allowAnalysis:true});
  assert.deepEqual([versions.state,versions.angularVersion,versions.typescriptVersion],['running','22.3.0','6.0.3']);
  assert.equal(versions.runtimeWritesAllowed,false);

  const location=async (document,where,offset,target,declaration)=>{
    const at=document.getText().indexOf(where)+offset;
    assert.ok(at>=offset,where);
    const result=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,document.positionAt(at));
    const found=result?.find(item=>{
      const uri=item.targetUri||item.uri,range=item.targetSelectionRange||item.range;
      return uri?.scheme==='file'&&!path.relative(uri.fsPath,target.uri.fsPath)&&target.getText(range)===declaration;
    });
    assert.ok(found,'Angular did not locate '+declaration);
  };
  const rich=async(document,where,offset,match)=>{
    const at=document.getText().indexOf(where)+offset;
    assert.ok(at>=offset,where);
    const values=await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,document.positionAt(at));
    // VS Code escapes MarkdownString plain text punctuation and encodes its spaces.
    const text=item=>String(item.value||item).replace(/\\([^\w\s])/gu,'$1').replace(/&nbsp;|\u00a0/gu,' ');
    assert.ok((values||[]).some(value=>value.contents.some(item=>match.test(text(item)))),where);
  };
  const editor=await vscode.window.showTextDocument(html,{preview:false});
  try {
    await location(html,'<rb-count',4,typescript,'CountComponent');
    await location(html,'currentValue',3,typescript,'displayed');
    await location(html,'model.people',2,typescript,'model');
    await location(html,'receive($event)',2,typescript,'receive');
    await location(html,'department.title',3,html,'department');
    await location(typescript,'{{ title }}',5,typescript,'title');
    await rich(html,'currentValue',3,/CountComponent\.displayed: number/u);
    await rich(html,'department.title',3,/department:[\s\S]*title: string/u);
    const check=async()=>vscode.commands.executeCommand(prefix+'check');
    const first=await check();
    assert.equal(first.strictTemplates,true);
    assert.equal(first.clean,false);
    assert.equal(first.omitted,0);
    assert.equal(first.emittedFiles,false);
    assert.deepEqual(first.projectDiagnostics,[]);
    assert.equal(first.diagnostics.length,1);
    assert.equal(first.diagnostics[0].code,2322);
    assert.equal(path.relative(first.diagnostics[0].file,html.uri.fsPath),'');
    const range=first.diagnostics[0].range;
    assert.equal(html.getText(new vscode.Range(range.start.line,range.start.character,range.end.line,range.end.character)),'currentValue');
    const visible=()=>vscode.languages.getDiagnostics(html.uri).filter(item=>item.source==='Rocketbrain Angular');
    assert.deepEqual(visible().map(item=>item.code),[2322]);
    const at=original.indexOf('="wrong"')+2,fixed=original.replace('="wrong"','="model.people"');
    assert.ok(await editor.edit(edit=>edit.replace(new vscode.Range(html.positionAt(at),html.positionAt(at+5)),'model.people')));
    await until(()=>html.isDirty&&html.getText()===fixed&&visible().length===0);
    await assert.rejects(angular.check({allowAnalysis:true}),/Save Angular project changes/u);
    await rich(html,'[currentValue]="model.people"></rb-count>',25,/people: number/u);
    assert.deepEqual(await fs.readFile(html.uri.fsPath),beforeBytes);
    assert.ok(await html.save());
    let checked;
    // File-change notification can arrive just after VS Code reports the save.
    await until(async()=>{
      try {checked=await angular.check({allowAnalysis:true});return checked.clean===true;}
      catch(error){if(!/cancelled|changed while checking/u.test(error.message))throw error;return false;}
    });
    assert.ok(checked.clean);
    assert.deepEqual(checked.diagnostics,[]);
    assert.notEqual(checked.sourceFingerprint,first.sourceFingerprint);
    assert.deepEqual(visible(),[]);
    assert.equal(await fs.stat(path.join(root,'dist')).catch(()=>null),null);
    return {angularVersion:versions.angularVersion,typescriptVersion:versions.typescriptVersion,
      componentSelector:true,aliasedInput:true,componentMember:true,outputHandler:true,controlFlowVariable:true,
      inlineTemplate:true,typedHover:true,currentUnsavedBuffer:true,diagnosticCode:2322,exactTemplateRange:true,
      staleDiagnosticCleared:true,cleanAfterSavedFix:true,emittedFiles:false};
  } finally {
    await angular.stop();
    assert.equal(angular.status().state,'stopped');
    if (html.getText()!==original) {
      assert.ok(await editor.edit(edit=>edit.replace(new vscode.Range(html.positionAt(0),html.positionAt(html.getText().length)),original)));
      await until(()=>html.getText()===original);
      assert.ok(await html.save());
    }
  }
}

async function runAngularWorkbenchChecks(api,vscode,checks) {
  const root=await ownedAngularFixture(process.env.ROCKETBRAIN_ANGULAR_FIXTURE);
  const uri=vscode.Uri.file(path.join(root,template));
  assert.ok(vscode.workspace.getWorkspaceFolder(uri),'Stage Angular inside the native Spring test workspace.');
  const node=process.env.ROCKETBRAIN_ANGULAR_NODE_PATH;
  assert.ok(path.isAbsolute(node||''));
  const settings=vscode.workspace.getConfiguration('rocketbrain.angular',uri);
  const previous=settings.inspect('nodePath')?.workspaceValue;
  try {
    await settings.update('nodePath',node,vscode.ConfigurationTarget.Workspace);
    for(const name of ['start','check','stop']) assert.ok((await vscode.commands.getCommands(true)).includes(prefix+name));
    await assert.rejects(api.angular.start({uri}),/Review and start/u);
    const report=await exerciseAngular(api.angular,vscode,root);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Installed Angular Go to Definition and hover resolved a real alias, component, current binding and control-flow local; the Angular compiler checked a saved snapshot and cleared the exact diagnostic after a saved fix.');
    return {...report,installedNative:true,ownedLanguageServerStopped:true,jdbc};
  } finally {
    await api.angular.stop();
    await settings.update('nodePath',previous,vscode.ConfigurationTarget.Workspace);
  }
}

module.exports={exerciseAngular,runAngularWorkbenchChecks};
