'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { javaNavigationFixture,kotlinExtensionSources } = require('./helpers/java-symbol-navigation-fixture');

function at(document,marker,shift=0) {
  const offset = document.getText().indexOf(marker);
  assert.ok(offset >= 0,marker);
  return document.positionAt(offset+shift);
}

async function verifyJdbc() {
  const jdbc = await jdbcReadback();
  assert.ok(jdbc,'Use the owned Spring JDBC fixture for native source navigation verification.');
  return jdbc;
}

async function runJavaSymbolNavigationChecks(api,vscode,checks) {
  const service = api.javaNavigation;
  assert.ok(service?.inspectSymbol && service?.revealSymbol);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.java.navigateSymbol') && commands.includes('rocketbrain.java.goToSuperMethod'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const packageLeaf = 'rbnav'+randomBytes(5).toString('hex');
  const root = path.join(workspace,'src/main/java/fixture/boot',packageLeaf);
  const sources = javaNavigationFixture('fixture.boot.'+packageLeaf);
  const files = new Map(),documents = new Map();
  await fs.mkdir(root);
  try {
    for (const [name,content] of Object.entries(sources)) {
      const file = path.join(root,name+'.java');
      await fs.writeFile(file,content,{flag:'wx'});
      files.set(name,file);
      documents.set(name,await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed','Expected the imported Java fixture to compile.');
    const inspect = (kind,owner,needle,shift) => {
      const document = documents.get(owner);
      return service.inspectSymbol({kind,uri:document.uri,position:at(document,needle,shift)});
    };
    const declaration = await until(async () => {
      const report = await inspect('declaration','Navigator','renderer.render(42)',11);
      return report.targets.length ? report : undefined;
    },50000);
    const [contract] = declaration.targets;
    assert.equal(path.relative(vscode.Uri.parse(contract.uri).fsPath,files.get('Renderer')),'');
    assert.equal(contract.range.start.line,3);
    await service.revealSymbol(declaration,contract.id);
    assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),'render');
    const [type] = (await inspect('type','Navigator','renderer.render(42)',3)).targets;
    assert.equal(type.uri,contract.uri);
    assert.equal(type.range.start.line,2);
    const alternatives = await until(async () => {
      const report = await inspect('implementation','Renderer','render(int value)',2);
      return report.targets.length >= 2 ? report : undefined;
    },50000);
    const names = alternatives.targets.map(target => path.basename(vscode.Uri.parse(target.uri).fsPath,'.java'));
    assert.ok(names.includes('FirstRenderer') && names.includes('SecondRenderer'),JSON.stringify(names));
    assert.ok(alternatives.targets.every(target => target.range.start.line === 3));
    const selected = alternatives.targets[names.indexOf('SecondRenderer')];
    await assert.rejects(service.revealSymbol({...alternatives},selected.id),/current navigation result/);
    await service.revealSymbol(alternatives,selected.id);
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(),selected.uri);
    assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),'render');

    const child = documents.get('FirstRenderer'),position = at(child,'render(int value)',2);
    const editor = await vscode.window.showTextDocument(child,{preview:false});
    editor.selection = new vscode.Selection(position,position);
    const parent = await vscode.commands.executeCommand('rocketbrain.java.goToSuperMethod');
    assert.equal(parent.targets.length,1);
    assert.equal(parent.targets[0].label,'fixture.boot.'+packageLeaf+'.BaseRenderer.render');
    assert.equal(path.relative(vscode.window.activeTextEditor.document.uri.fsPath,files.get('BaseRenderer')),'');
    const stable = await inspect('super','FirstRenderer','render(int value)',2);
    const parentEditor = vscode.window.activeTextEditor;
    assert.equal(await parentEditor.edit(edit => edit.insert(new vscode.Position(0,0),'// owned stale destination\n')),true);
    await assert.rejects(service.revealSymbol(stable,stable.targets[0].id),/destination changed/);
    await vscode.commands.executeCommand('undo');
    await until(() => !parentEditor.document.isDirty,10000);
    assert.deepEqual((await inspect('super','Navigator','String run()',8)).targets,[]);
    const library = await inspect('declaration','Navigator','Integer.toHexString(42)',11);
    const libraryTarget = library.targets.find(target => vscode.Uri.parse(target.uri).scheme === 'jdt');
    assert.ok(libraryTarget);
    await service.revealSymbol(library,libraryTarget.id);
    assert.match(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),/toHexString/);
    const jdbc = await verifyJdbc();
    checks.push('Used native declaration, type, multiple implementation and super-method navigation on an imported Spring Java project, with the correct overload and JDK source target.');
    return {springWorkspace:true,jdbc,declaration:true,typeDeclaration:true,implementationCount:names.length,
      exactOverload:true,multipleNativeTargets:true,nearestSuper:true,noSuperHandled:true,jdkSourceOpened:true,staleTargetRefused:true};
  } finally {
    try {
      for (const document of documents.values()) if(document.isDirty){
        await vscode.window.showTextDocument(document,{preview:false});
        if(vscode.window.activeTextEditor?.document===document)await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } finally {
      await Promise.all([...files.values()].map(file=>fs.rm(file,{force:true})));
      await fs.rmdir(root);
    }
  }
}

async function runKotlinExtensionNavigationChecks(api,vscode,checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const config = vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'), target = vscode.ConfigurationTarget.Global;
  const serverHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME, gradleHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(serverHome,'Configure the owned Kotlin compiler language server for navigation.');
  const root = await fs.mkdtemp(path.join(workspace,'rb-nav-kotlin-'));
  const saved = [];
  const setting = async (key,value) => {
    if (!value) return;
    saved.push([key,config.inspect(key)?.globalValue]);
    await config.update(key,value,target);
  };
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    const directory = path.join(root,'src/main/kotlin/editor/fixture');
    for (const [file,text] of Object.entries(kotlinExtensionSources())) await fs.writeFile(path.join(directory,file),text,{flag:'wx'});
    await setting('serverHome',serverHome);
    await setting('gradleUserHome',gradleHome);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory,'ExtensionCaller.kt')));
    assert.equal(document.languageId,'kotlin');
    const results = [];
    for (const [receiver,expected] of [['invoice','InvoiceExtension.kt'],['value','StringExtension.kt']]) {
      const report = await until(async () => {
        const answer = await api.javaNavigation.inspectSymbol({kind:'declaration',uri:document.uri,
          position:at(document,receiver+'.ticketLabel()',receiver.length+3)});
        return answer.targets.length ? answer : undefined;
      },85000);
      assert.equal(report.targets.length,1);
      const [link] = report.targets;
      assert.equal(path.relative(vscode.Uri.parse(link.uri).fsPath,path.join(directory,expected)),'');
      assert.equal(link.range.start.line,2);
      await api.javaNavigation.revealSymbol(report,link.id);
      const jumped = vscode.window.activeTextEditor;
      assert.equal(jumped.document.uri.toString(),link.uri);
      assert.match(jumped.document.lineAt(jumped.selection.start.line).text,/fun (Invoice|String)\.ticketLabel/);
      results.push({receiver,target:expected,line:link.range.start.line+1});
    }
    const {serverVersion,compilerVersion} = api.java.kotlinEditor.getState();
    const jdbc = await verifyJdbc();
    checks.push('Kotlin source navigation opened the distinct extension declaration for each of two receivers sharing the same method name.');
    return {springWorkspace:true,jdbc,serverVersion,compilerVersion,receiverSpecificExtensionDeclarations:results};
  } finally {
    try { await api.java.kotlinEditor.stop(); }
    finally {
      for (const [key,previous] of saved.reverse()) await config.update(key,previous,target);
      const owned = await fs.realpath(root);
      assert.equal(path.relative(path.dirname(owned),workspace),'');
      assert.match(path.basename(owned),/^rb-nav-kotlin-/);
      await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:150});
    }
  }
}

module.exports = { runJavaSymbolNavigationChecks,runKotlinExtensionNavigationChecks };
