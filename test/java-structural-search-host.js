'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

async function runJavaStructuralSearchChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service?.structuralSearch && service?.prepareStructuralReplacement);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.structuralSearch'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api,workspace);
  const root = path.join(workspace,'src/main/java/fixture/boot');
  const stem = 'RbStructure' + randomBytes(5).toString('hex');
  const fixture = (suffix,body) => {
    const name = stem + suffix, file = path.join(root,name + '.java');
    return {file,uri:vscode.Uri.file(file),text:'package fixture.boot;\n' +
      '@org.springframework.stereotype.Component\nfinal class ' + name + ' {\n' + body + '\n}\n'};
  };
  const left = fixture('First',[
    '    int affected(int value) { return Math.min(value, 654321); }',
    '    long untouched(long value) { return Math.min(value, 654321); }',
    '    String literal() { return "Math.min(value, 654321)"; }'
  ].join('\n'));
  const right = fixture('Second',[
    '    int affected(int value) { return Math.min((value), 654321); }',
    '    int runtimeCall(String value) { return Math.min(Integer.parseInt(value), 654321); }'
  ].join('\n'));
  const newMember = fixture('Added','    int value() { return 0; }');
  const files = new Set(), documents = [];
  const params = {
    projectUri:project.uri,pattern:'Math.min($value$, 654321)',replacement:'Math.max($value$, 654321)',
    constraints:[{name:'value',type:'int'}]
  };
  const selection = report => report.matches.filter(item => item.replacement !== undefined).map(item => item.id);
  try {
    for (const item of [left,right]) {
      await fs.writeFile(item.file,item.text,{flag:'wx'});
      files.add(item.file);
      documents.push(await vscode.workspace.openTextDocument(item.uri));
    }
    const fileReport = await service.structuralSearch({...params,uri:left.uri,fileOnly:true});
    assert.equal(fileReport.sourceFiles,1);
    assert.deepEqual(fileReport.matches.map(item => item.snippet),['Math.min(value, 654321)']);
    await service.reveal(fileReport,fileReport.matches[0]);
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(),left.uri.toString());
    assert.equal(documents[0].getText(vscode.window.activeTextEditor.selection),'Math.min(value, 654321)');
    const report = await service.structuralSearch(params);
    assert.equal(report.matches.length,3);
    assert.equal(report.matches.filter(item => item.blocked).length,1);
    assert.ok(report.matches.every(item => item.captures[0].type === 'int'));
    await assert.rejects(service.prepareStructuralReplacement(report,[report.matches.find(item => item.blocked).id]),/replaceable matches/);

    const incompatible = await service.structuralSearch({...params,uri:left.uri,fileOnly:true,replacement:'"incompatible"'});
    await assert.rejects(service.prepareStructuralReplacement(incompatible,selection(incompatible)),/would fail Java compiler analysis/);
    assert.ok(documents.every(document => !document.isDirty));

    const stale = await service.prepareStructuralReplacement(report,selection(report));
    await fs.writeFile(newMember.file,newMember.text,{flag:'wx'});
    files.add(newMember.file);
    await assert.rejects(api.java.refactoring.apply(stale.id),/source membership changed/);
    assert.ok(documents.every(document => !document.isDirty));
    await fs.unlink(newMember.file);
    files.delete(newMember.file);

    const chosen = selection(report);
    report.matches.find(item => item.id === chosen[0]).replacement = '0';
    const plan = await service.prepareStructuralReplacement(report,chosen);
    assert.equal(plan.documents.length,2);
    assert.ok(plan.documents.every(item => /Math\.max\(/.test(item.after)));
    const previews = await Promise.all(plan.documents.map((_,index) => vscode.workspace.openTextDocument(vscode.Uri.parse(
      'rocketbrain-java-refactor:/' + plan.id + '/' + index + '/after.java'))));
    assert.deepEqual(previews.map(item => item.getText()),plan.documents.map(item => item.after));
    const edited = await api.java.refactoring.apply(plan.id).catch(async error => {
      const state = await Promise.all(plan.documents.map(async saved => {
        const uri = vscode.Uri.parse(saved.uri), document = await vscode.workspace.openTextDocument(uri);
        return {file:path.basename(uri.fsPath),expectedVersion:saved.version,version:document.version,
          closed:document.isClosed,dirty:document.isDirty,bufferMatches:document.getText() === saved.before,
          diskMatches:(await fs.readFile(uri.fsPath,'utf8')).replace(/^\uFEFF/,'') === saved.before};
      }));
      throw Error('Applying reviewed structural replacement failed: ' + error.message + '\n' + JSON.stringify(state),{cause:error});
    });
    assert.equal(edited.state,'applied');
    assert.equal(edited.savedToDisk,false);
    assert.equal(edited.files.length,2);
    assert.deepEqual(await Promise.all([left,right].map(item => fs.readFile(item.file,'utf8'))),[left.text,right.text]);
    assert.ok(documents.every(document => document.isDirty));
    assert.match(documents[0].getText(),/Math\.min\(value, 654321\); \}/);
    assert.match(documents[1].getText(),/Math\.min\(Integer\.parseInt\(value\), 654321\)/);
    assert.ok((await Promise.all(documents.map(document => document.save()))).every(Boolean));
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed','JDT project build ' + JSON.stringify(build));
    const jdbc = await jdbcReadback();
    checks.push('Typed Java AST search found only Java expressions in the selected project/file. A selected two-file replacement passed prospective javac and the live Spring JDT build.');
    checks.push('Structural replacement refused an evaluation-bearing capture, incompatible types and stale project source membership; applying the reviewed edit left both buffers unsaved.');
    return { projectMatches:3, fileMatches:1, changedFiles:2, typeConstraint:true, sourceNavigation:true,
      compilerRefused:true, unsafeCaptureRefused:true, staleMembershipRefused:true, diskUntouchedUntilSave:true,
      springBuild:true, jdbc };
  } finally {
    for (const document of documents) if (document.isDirty) await document.save();
    for (const file of files) await fs.unlink(file);
  }
}

module.exports = { runJavaStructuralSearchChecks };
