'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {importedSpring,jdbcReadback} = require('./java-source-analysis-host');
const {until} = require('./helpers/stdio-lsp');
const {formatSource,assertFormat} = require('./helpers/java-format-fixture');
const {editedText} = require('../src/java/refactoring');

async function runJavaFormattingChecks(api,vscode,checks) {
  const service = api.java.formatting;
  assert.ok(service?.prepare);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.previewFormatting'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const sourceRoot = await fs.realpath(path.join(workspace,'src/main/java/fixture/boot'));
  const root = await fs.mkdtemp(path.join(sourceRoot,'rbfmt'));
  const namespace = 'fixture.boot.'+path.basename(root), nested = path.join(root,'nested');
  const nestedConfig = path.join(nested,'.editorconfig'), documentOptions = {insertSpaces:true,tabSize:6};
  const documents = [];
  try {
    await fs.mkdir(nested);
    await fs.writeFile(path.join(root,'.editorconfig'),'root=true\n[*.java]\nindent_style=space\nindent_size=2\nend_of_line=lf\n',{flag:'wx'});
    const savedNested = '[*.java]\nindent_style=tab\ntab_width=4\nend_of_line=crlf\n';
    await fs.writeFile(nestedConfig,savedNested,{flag:'wx'});
    const plain = formatSource(namespace,'RbSpaces',{spring:true});
    const mixed = formatSource(namespace+'.nested','RbMixed',{spring:true});
    const paths = [[path.join(root,'RbSpaces.java'),plain],[path.join(nested,'RbMixed.java'),mixed]];
    for (const [file,fixture] of paths) {
      await fs.writeFile(file,fixture.source,{flag:'wx'});
      documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }
    const [plainDoc,mixedDoc] = documents, original = mixedDoc.getText();
    await vscode.window.showTextDocument(mixedDoc,{preview:false});
    await api.java.buildWorkspace();
    const nativePlain = await until(()=>vscode.commands.executeCommand('vscode.executeFormatDocumentProvider',plainDoc.uri,documentOptions).then(edits=>edits?.length?edits:null),45000);
    assertFormat(editedText(plainDoc.getText(),nativePlain),{insertSpaces:true,indentSize:2,tabWidth:2});

    const range = new vscode.Range(mixedDoc.positionAt(mixed.from),mixedDoc.positionAt(mixed.until));
    const rangePlan = await service.prepare({document:mixedDoc,range,options:documentOptions});
    assert.equal(rangePlan.formatting.mode,'range');
    assert.equal(rangePlan.formatting.endOfLine,null);
    assert.ok(rangePlan.documents[0].after.startsWith(original.slice(0,mixed.from)));
    assert.ok(rangePlan.documents[0].after.endsWith(original.slice(mixed.until)));
    assertFormat(rangePlan.documents[0].after,rangePlan.formatting.options,{range:true});
    const nativeRange = await vscode.commands.executeCommand('vscode.executeFormatRangeProvider',mixedDoc.uri,range,documentOptions);
    assert.equal(editedText(original,nativeRange),rangePlan.documents[0].after);
    const undo = async () => {
      await vscode.window.showTextDocument(mixedDoc,{preview:false});
      await vscode.commands.executeCommand('undo');
      await until(()=>mixedDoc.getText()===original,10000);
      assert.equal(mixedDoc.eol,vscode.EndOfLine.LF);
      assert.equal(mixedDoc.isDirty,false);
    };
    assert.equal((await api.java.refactoring.apply(rangePlan.id)).state,'applied');
    assert.equal(mixedDoc.eol,vscode.EndOfLine.LF);
    await undo();

    const full = await service.prepare({document:mixedDoc,options:documentOptions});
    assert.equal(full.formatting.endOfLine,'crlf');
    assert.equal(full.formatting.configurationSources.length,2);
    assertFormat(full.documents[0].after,{insertSpaces:false,indentSize:2,tabWidth:4});
    const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+full.id+'/0/after.java'));
    assert.equal(preview.getText().replace(/\r\n/g,'\n'),full.documents[0].after.replace(/\r\n/g,'\n'));
    assert.equal((await api.java.refactoring.apply(full.id)).state,'applied');
    assert.equal(mixedDoc.eol,vscode.EndOfLine.CRLF);
    assert.equal(mixedDoc.getText(),full.documents[0].after);
    assert.equal(await fs.readFile(mixedDoc.uri.fsPath,'utf8'),original);
    await undo();

    await vscode.commands.executeCommand('editor.action.formatDocument');
    await until(()=>mixedDoc.getText()===full.documents[0].after,10000);
    assert.equal(mixedDoc.eol,vscode.EndOfLine.CRLF);
    await undo();

    const stale = await service.prepare({document:mixedDoc,options:documentOptions});
    await fs.writeFile(nestedConfig,savedNested.replace('tab_width=4','tab_width=8'));
    await assert.rejects(api.java.refactoring.apply(stale.id),/\.editorconfig files changed/);
    assert.equal(mixedDoc.getText(),original);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC service.');
    checks.push('Native JDT document/range formatting applied nested EditorConfig spaces, tabs, distinct widths and line endings to imported Spring Java source.');
    checks.push('An exact range preserved surrounding text. The full preview committed one undostep including CRLF and rejected changed configuration.');
    return {springWorkspace:true,jdbc,nativeDocument:true,nativeRange:true,configurationFiles:2,spaceIndent:2,mixedIndent:2,tabWidth:4,
      fullCrlf:true,rangeEolPreserved:true,exactRange:true,diskPreserved:true,nativeUndo:true,changedConfigRefused:true};
  } finally {
    try {
      for (const document of documents.filter(value=>value.isDirty)) {
        await vscode.window.showTextDocument(document,{preview:false});
        if (vscode.window.activeTextEditor?.document===document) await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } finally {
      const real = await fs.realpath(root);
      assert.equal(path.relative(path.dirname(real),sourceRoot),'');
      assert.match(path.basename(real),/^rbfmt/);
      await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:150});
    }
  }
}

module.exports = {runJavaFormattingChecks};
