'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {importedSpring,jdbcReadback} = require('./java-source-analysis-host');
const {until} = require('./helpers/stdio-lsp');
const {innerMoveFixture,innerMoveRuntime} = require('./helpers/java-inner-class-move-fixture');

async function runJavaInnerClassMoveChecks(api,vscode,checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api,workspace);
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const directory = path.join(workspace,'src/main/java/fixture/boot');
  const fixture = innerMoveFixture('fixture.boot','RbInner' + randomBytes(5).toString('hex'));
  const [old,caller,next] = [fixture.owner,fixture.caller,fixture.inner].map(name => path.join(directory,name+'.java'));
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent,'rb-native-inner-move-'));
  const files = new Set();
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const exists = file => fs.stat(file).then(() => true,error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const normalized = text => text.replace(/\r\n/g,'\n');
  const compileAndRun = files => innerMoveRuntime({
    javaHome:project.jdk || api.java.getState().javaHome,
    classpathFile:path.join(runtime.projectPath,'build/runtime-classpath.txt'),configFile:runtime.dbConfigPath,
    engine:runtime.dbEngine,files,fixture,workspace:owned
  });

  try {
    for (const [file,text] of [[old,fixture.ownerText],[caller,fixture.callerText]]) {
      await fs.writeFile(file,text,{flag:'wx'});
      files.add(file);
      await vscode.window.showTextDocument(await open(file),{preview:false,preserveFocus:false});
    }
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed','JDT build result ' + JSON.stringify(build));
    const baseline = await compileAndRun([old,caller]);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.moveInnerClass'));
    const document = await open(old);
    await vscode.window.showTextDocument(document,{preview:false,preserveFocus:false});
    const move = api.javaSourceAnalysis.prepareInnerClassMove;
    const at = name => document.positionAt(document.getText().indexOf('class '+name)+'class '.length);
    await assert.rejects(move({document,position:at(fixture.owner.replace(/Owner$/u,'Static'))}),/regular non-static/);
    const plan = await move({document,position:at(fixture.inner)});
    assert.equal(plan.qualifiedCallers,1);
    assert.equal(plan.constructorCallers,2);
    assert.equal(plan.resourceOperations.length,1);
    assert.equal(plan.documents.length,3);
    const preview = plan.documents.find(value => value.created);
    assert.match(preview.after,new RegExp('private final ' + fixture.owner));
    const changedCaller = plan.documents.find(value => value.uri === vscode.Uri.file(caller).toString());
    assert.match(changedCaller.after,/java\.util\.Objects\.requireNonNull\(owner\(selected\)\), value\(input\)/);
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse(
      'rocketbrain-java-refactor:/'+plan.id+'/'+plan.documents.indexOf(preview)+'/after.java'));
    assert.equal(normalized(diff.getText()),normalized(preview.after));
    assert.equal(await exists(next),false);
    const result = await api.java.refactoring.apply(plan.id);
    if (await exists(next)) files.add(next);
    assert.equal(result.state,'applied');
    await until(async () => await exists(next) && normalized((await open(old)).getText()) !== fixture.ownerText,10000);
    await vscode.window.showTextDocument(await open(old),{preview:false,preserveFocus:false});
    await vscode.commands.executeCommand('undo');
    await until(async () => !await exists(next) &&
      normalized((await open(old)).getText()) === fixture.ownerText &&
      normalized((await open(caller)).getText()) === fixture.callerText,10000);
    await vscode.commands.executeCommand('redo');
    await until(async () => await exists(next) &&
      !normalized((await open(old)).getText()).includes('class '+fixture.inner),10000);
    for (const file of [old,caller,next]) assert.equal(await (await open(file)).save(),true);
    const after = await compileAndRun([old,caller,next]);
    assert.deepEqual(after,baseline);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('An inner class retains its original Spring-owned enclosing object after moving to a top-level file.');
    checks.push('Native Undo and Redo span the new file and both sources. Actual JVM evaluation and JDBC results match before and after.');
    return {qualifiedCallers:plan.qualifiedCallers,constructorCallers:plan.constructorCallers,files:3,
      nativePreview:true,nativeUndo:true,nativeRedo:true,springRuntime:after,jdbc};
  } finally {
    for (const file of files) {
      if (!await exists(file)) continue;
      const document = vscode.workspace.textDocuments.find(value => value.uri.toString() === vscode.Uri.file(file).toString());
      if (document?.isDirty) {
        await vscode.window.showTextDocument(document,{preview:false,preserveFocus:false});
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      await fs.unlink(file);
    }
    assert.equal(path.dirname(await fs.realpath(owned)),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports = {runJavaInnerClassMoveChecks};
