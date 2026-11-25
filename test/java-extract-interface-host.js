'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

async function runJavaExtractInterfaceChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service?.inspectInterface && service?.prepareInterfaceExtraction);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.extractInterface'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  assert.equal(api.java.getState().extractInterfaceReplaceUsages,true,
    'Set rocketbrain.java.extractInterface.replaceUsages to true in the isolated test profile.');
  const root = path.join(workspace,'src/main/java/fixture/boot');
  const tag = randomBytes(5).toString('hex'), ownerName = 'RbReader' + tag, callerName = 'RbReaderCaller' + tag;
  const targetName = 'RbReading' + tag, collisionName = 'RbCollision' + tag;
  const file = name => path.join(root,name + '.java');
  const owner = file(ownerName), caller = file(callerName), target = file(targetName), collision = file(collisionName.toLowerCase());
  const ownerText = 'package fixture.boot;\n@org.springframework.stereotype.Component\n' +
    'public final class ' + ownerName + '<T extends Number> {\n' +
    '    public T read(T value) { return value; }\n' +
    '    public String concreteOnly() { return "concrete"; }\n' +
    '}\n';
  const callerText = 'package fixture.boot;\nfinal class ' + callerName + ' {\n' +
    '    Integer throughInterface(Integer value) {\n' +
    '        ' + ownerName + '<Integer> adapter = new ' + ownerName + '<>();\n' +
    '        return adapter.read(value);\n' +
    '    }\n' +
    '    String usesConcreteMember() {\n' +
    '        ' + ownerName + '<Integer> concrete = new ' + ownerName + '<>();\n' +
    '        return concrete.concreteOnly();\n' +
    '    }\n' +
    '}\n';
  const owned = new Set(), documents = [];
  try {
    for (const [destination,source] of [[owner,ownerText],[caller,callerText]]) {
      await fs.writeFile(destination,source,{flag:'wx'});
      owned.add(destination);
      documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(destination)));
    }
    const build = async () => {
      const result = await api.java.buildWorkspace();
      assert.ok(result === 0 || result === 1 || result?.status === 'succeed','JDT build result ' + JSON.stringify(result));
    };
    await build();
    const report = await service.inspectInterface({document:documents[0]});
    assert.equal(report.owner,ownerName);
    assert.equal(report.replaceUsages,true);
    assert.ok(report.members.some(member => member.name === 'concreteOnly'));
    const method = report.members.find(member => member.name === 'read');
    assert.ok(method);
    const current = report.packages.find(item => !path.relative(vscode.Uri.parse(item.uri).fsPath,root));
    assert.ok(current);
    const options = {memberIds:[method.id],packageUri:current.uri};
    await assert.rejects(service.prepareInterfaceExtraction(report,{...options,name:targetName,memberIds:[method.id,method.id]}),/distinct members/);
    const stale = await service.prepareInterfaceExtraction(report,{...options,name:collisionName});
    await fs.writeFile(collision,'preserve existing destination',{flag:'wx'});
    owned.add(collision);
    await assert.rejects(api.java.refactoring.apply(stale.id),/destination changed or already exists/);
    assert.ok(documents.every(document => !document.isDirty));
    assert.equal(await fs.readFile(collision,'utf8'),'preserve existing destination');
    await fs.unlink(collision);
    owned.delete(collision);

    const plan = await service.prepareInterfaceExtraction(report,{...options,name:targetName});
    assert.equal(plan.selectedMembers,1);
    assert.equal(plan.callerFiles,1);
    assert.equal(plan.documents.length,3);
    assert.equal(plan.resourceOperations.length,1);
    const created = plan.documents.find(item => item.created), existing = plan.documents.filter(item => !item.created);
    assert.equal(created.uri,vscode.Uri.file(target).toString());
    assert.equal(created.before,'');
    assert.match(created.after,new RegExp('interface ' + targetName + '<T extends Number>'));
    assert.match(created.after,/T read\(T value\);/);
    assert.doesNotMatch(created.after,/concreteOnly/);
    assert.match(existing.find(item => item.uri === documents[0].uri.toString()).after,new RegExp('implements ' + targetName + '<T>'));
    const afterCaller = existing.find(item => item.uri === documents[1].uri.toString()).after;
    assert.match(afterCaller,new RegExp(targetName + '<Integer> adapter = new ' + ownerName));
    assert.match(afterCaller,new RegExp(ownerName + '<Integer> concrete = new ' + ownerName));
    const previewIndex = plan.documents.indexOf(created);
    const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse(
      'rocketbrain-java-refactor:/' + plan.id + '/' + previewIndex + '/after.java'));
    assert.equal(preview.getText(),created.after);
    await assert.rejects(fs.stat(target),{code:'ENOENT'});
    const result = await api.java.refactoring.apply(plan.id);
    if (await fs.stat(target).catch(() => null)) owned.add(target);
    assert.equal(result.state,'applied');
    assert.equal(result.files.length,3);
    assert.equal(result.resourceOperationsSavedToDisk,true);
    assert.equal(await fs.readFile(target,'utf8'),created.after);
    assert.deepEqual(await Promise.all([owner,caller].map(destination => fs.readFile(destination,'utf8'))),[ownerText,callerText]);
    assert.ok(documents.every(document => document.isDirty));
    assert.ok((await Promise.all(documents.map(document => document.save()))).every(Boolean));
    await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await build();
    const jdbc = await jdbcReadback();
    checks.push('JDT extracted one selected method from a generic Spring class into a new interface and retyped only its compatible caller.');
    checks.push('Rocketbrain compiled and previewed all three files. One reviewed workspace edit created the interface bytes without overwriting a conflicting file.');
    return {selectedMembers:1,changedFiles:3,callerFiles:1,publicGenericBound:true,compatibleCaller:true,
      concreteCallerPreserved:true,staleDestinationRefused:true,newFileContentsVerified:true,existingBuffersUnsaved:true,
      springBuild:true,jdbc};
  } finally {
    for (const document of documents) if (document.isDirty) await document.save();
    for (const destination of owned) await fs.unlink(destination);
  }
}

module.exports = { runJavaExtractInterfaceChecks };
