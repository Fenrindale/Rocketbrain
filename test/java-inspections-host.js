'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function removeFixturePath(remove,file) {
  const limit=Date.now()+5000;
  while(true){
    try { await remove(file); return; }
    catch(error){
      if(error.code==='ENOENT')return;
      if(!['EBUSY','EPERM'].includes(error.code)||Date.now()>=limit)throw error;
      await delay(100);
    }
  }
}

function fixtureClass(packageName,name,literal,issues = false) {
  return [
    'package ' + packageName + ';',
    ...(issues ? ['import java.util.List;', 'import java.util.List;'] : []),
    'public final class ' + name + ' {',
    '    public int count(int input) {',
    '        int total = input + ' + literal + ';',
    '        total = total * ' + literal + ';',
    '        total = total - ' + literal + ';',
    '        if (total > ' + literal + ') {',
    '            total += ' + literal + ';',
    '        }',
    '        return total;',
    '    }',
    ...(issues ? [
      '    void inspected(boolean value) {',
      '        if (value); // rocketbrain-ignore: emptyIf',
      '        if (value);',
      '        try { count(3); } catch (RuntimeException ignored) {}',
      '        try { count(3); } catch (RuntimeException ignored) { /* covered by caller */ }',
      '        try { count(3); } finally {}',
      '    }'
    ] : []),
    '}',
    ''
  ].join('\n');
}

async function readbackSpring() {
  if (!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) return null;
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(config.baseUrl + '/probe/testing-state',{signal:AbortSignal.timeout(6500)});
  assert.equal(response.ok,true);
  const value = await response.json();
  assert.deepEqual(value,{people:2,departments:1,rolledBackNames:0});
  return value;
}

async function runJavaInspectionsChecks(api,vscode,checks) {
  const service = api.javaInspections;
  assert.ok(service);
  const folder = vscode.workspace.workspaceFolders[0];
  const id = 'rb_inspect_' + randomBytes(5).toString('hex');
  const directory = path.join(folder.uri.fsPath,'src/main/java/fixture/boot',id);
  const settings = vscode.workspace.getConfiguration('rocketbrain.java',folder.uri);
  const global = vscode.ConfigurationTarget.Global;
  const previous = settings.inspect('inspectionProfiles')?.globalValue;
  const files = new Map();
  const packageName = 'fixture.boot.' + id;
  const source = name => files.get(name);
  const profile = { name:'Inspection proof',include:['**/' + id + '/*.java'],exclude:['**/Excluded.java'],
    rules:{ emptyCatch:'error',duplicateImport:'hint',emptyFinally:'off',emptyIf:'warning' },
    duplicateMode:'exact',minDuplicateTokens:24 };
  const options = { profileName:profile.name,folderUri:folder.uri };
  function ownDiagnostics(name) {
    return vscode.languages.getDiagnostics(source(name).uri).filter(item => item.source === 'Rocketbrain Java Inspections');
  }
  await fs.mkdir(directory);
  try {
    await settings.update('inspectionProfiles',[profile],global);
    for (const [name,literal,issues] of [
      ['Alpha',3,true],['Bravo',3,false],['Literal',8,false],['Excluded',3,true],['Dirty',3,true]
    ]) {
      const file = path.join(directory,name + '.java'), uri = vscode.Uri.file(file);
      await fs.writeFile(file,fixtureClass(packageName,name,literal,issues),{flag:'wx'});
      const document = await vscode.workspace.openTextDocument(uri);
      files.set(name,{ file,uri,document });
    }
    const makeDirty = async name => {
      const { document,uri } = source(name);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri,document.positionAt(document.getText().length),'// outstanding editor change\n');
      assert.equal(await vscode.workspace.applyEdit(edit),true);
      assert.equal(document.isDirty,true);
    };
    await makeDirty('Dirty');
    const exact = await service.scan(options);
    assert.equal(exact.scannedFiles,3);
    assert.equal(exact.skipped.length,1);
    assert.ok(exact.skipped[0].uri.endsWith('/Dirty.java'));
    const { DiagnosticSeverity:SEVERITY } = vscode;
    const observed = ownDiagnostics('Alpha');
    assert.deepEqual(observed.map(d => [d.code,d.severity]).sort((left,right) => left[0].localeCompare(right[0])),[
      ['duplicateImport',SEVERITY.Hint],['emptyCatch',SEVERITY.Error],['emptyIf',SEVERITY.Warning]
    ]);
    assert.ok(observed.some(item => item.code === 'emptyCatch' &&
      source('Alpha').document.getText(item.range) === 'catch (RuntimeException ignored) {}'));
    assert.equal(ownDiagnostics('Dirty').length + ownDiagnostics('Excluded').length,0);
    const exactGroup = exact.duplicateGroups.find(group =>
      group.occurrences.some(location => location.method === 'Alpha.count'));
    assert.deepEqual(exactGroup?.occurrences.map(location => location.method),['Alpha.count','Bravo.count']);
    const chosen = exactGroup.occurrences.at(-1);
    await service.reveal(exact,chosen);
    const opened = vscode.window.activeTextEditor;
    assert.equal(path.relative(opened.document.uri.fsPath,source('Bravo').file),'');
    assert.match(opened.document.getText(opened.selection),/^int total = input \+ 3;[\s\S]*return total;$/);
    const normalized = await service.scan({ ...options,mode:'ignore-literals',publishDiagnostics:false });
    const normalizedGroup = normalized.duplicateGroups.find(group =>
      group.occurrences.some(location => location.method === 'Alpha.count'));
    assert.deepEqual(normalizedGroup?.occurrences.map(location => location.method),['Alpha.count','Bravo.count','Literal.count']);
    assert.equal(ownDiagnostics('Alpha').length,3);
    await makeDirty('Bravo');
    await assert.rejects(service.reveal(exact,chosen),/changed after inspection/);
    await makeDirty('Alpha');
    assert.equal(ownDiagnostics('Alpha').length,0);
    const cancelled = new vscode.CancellationTokenSource();
    cancelled.cancel();
    try { await assert.rejects(service.scan({ ...options,cancellation:cancelled.token }),/cancelled/); }
    finally { cancelled.dispose(); }
    await vscode.commands.executeCommand('rocketbrain.java.clearProjectInspections');
    assert.equal(ownDiagnostics('Alpha').length,0);
    const jdbc = await readbackSpring();
    checks.push('Scoped Java inspection reported rule severities in native Problems, honored comment and profile opt-outs, and deferred dirty/excluded files. Exact and literal-insensitive duplicate groups navigated to native source ranges, and stale sources were refused.');
    return { inspected:exact.scannedFiles, findings:observed.length, dirtySkipped:1, excluded:1,
      exactOccurrences:exactGroup.occurrences.length, literalOccurrences:normalizedGroup.occurrences.length,
      navigation:true, staleRefused:true, cancellation:true, diagnosticsCleared:true,jdbc };
  } finally {
    service.clear();
    for (const { file,document } of files.values()) {
      if (document.isDirty) await document.save();
      await removeFixturePath(fs.unlink,file);
    }
    await removeFixturePath(fs.rmdir,directory);
    await settings.update('inspectionProfiles',previous,global);
  }
}

module.exports = { runJavaInspectionsChecks };
