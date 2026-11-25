'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {importedSpring,jdbcReadback} = require('./java-source-analysis-host');
const {until} = require('./helpers/stdio-lsp');
const {usageSources,kotlinExtensionSources} = require('./helpers/java-symbol-navigation-fixture');

function cursor(document,marker,shift=1) {
  const index = document.getText().indexOf(marker);
  assert.ok(index>=0,marker);
  return document.positionAt(index+shift);
}

async function runJavaUsageSearchChecks(api,vscode,checks) {
  const service = api.javaNavigation;
  assert.ok(service?.findUsages && service?.revealUsage);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.findUsages'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const fixture = usageSources('fixture.boot','Rb'+randomBytes(5).toString('hex'));
  const files = [], docs = new Map();
  try {
    for (const [name,text] of Object.entries(fixture.files)) {
      const directory = name.endsWith('.java') ? 'src/main/java/fixture/boot' : 'src/main/resources';
      const file = path.join(workspace,directory,name);
      await fs.writeFile(file,text,{flag:'wx'});
      files.push(file);
      docs.set(name,await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }
    const source = docs.get(fixture.type+'.java'), caller = docs.get(fixture.caller+'.java');
    const xml = [...docs.values()].find(item => item.uri.path.endsWith('.xml'));
    const config = [...docs.values()].find(item => item.uri.path.endsWith('.properties'));
    const references = (document,marker,scope='folder',includeDeclaration=false,shift) => service.findUsages({uri:document.uri,
      position:cursor(document,marker,shift),scope,includeDeclaration});
    await api.java.buildWorkspace();
    await api.java.spring.refresh();
    const jdt = await until(async () => {
      const result = await references(source,'echo(int value)');
      return result.targets.some(target => target.uri===caller.uri.toString()) ? result : undefined;
    },40000);
    assert.deepEqual(jdt.targets.map(target => target.range.start.line).sort((a,b)=>a-b),[2,7]);
    assert.ok(jdt.targets.every(target => target.provider==='java'));
    const local = await references(source,'echo(int value)','file');
    assert.equal(local.targets.length,1);
    assert.equal(local.targets[0].uri,source.uri.toString());
    const type = await references(source,'class '+fixture.type,'workspace',false,7);
    assert.equal(type.symbol,fixture.fqn);
    const xmlTargets = type.targets.filter(target => target.provider==='spring-class');
    assert.equal(xmlTargets.length,1);
    await service.revealUsage(type,xmlTargets[0].id);
    assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),fixture.fqn);
    const fromXml = await references(xml,'class="'+fixture.fqn,'folder',false,9);
    assert.ok(fromXml.targets.some(target => target.uri===caller.uri.toString() && target.provider==='java'));
    const property = await references(config,fixture.property+'=fixture');
    assert.deepEqual(property.targets.map(target=>target.provider).sort(),['spring-property','spring-property']);
    const value = property.targets.find(target => target.uri===source.uri.toString());
    await service.revealUsage(property,value.id);
    assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),fixture.property);
    const configLink = await references(source,fixture.property,'workspace',true);
    assert.equal(configLink.targets.filter(target => target.provider==='spring-config').length,1);
    await fs.appendFile(xml.uri.fsPath,'<!-- after search -->\n');
    await assert.rejects(service.revealUsage(type,xmlTargets[0].id),/usage location changed/);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC service.');
    checks.push('The installed JVM/Spring usage search found exact Java overload calls, opened a Spring XML class attribute, followed the XML class back to Java calls, and selected exact Spring property ranges.');
    return {springWorkspace:true,jdbc,scopes:['file','folder','workspace'],javaOverloadReferences:jdt.targets.length,
      fileOnlyReferences:local.targets.length,exactXmlClassTargets:xmlTargets.length,xmlToJava:true,propertyUses:property.targets.length,
      configurationKey:true,staleLocationRefused:true};
  } finally { await Promise.all(files.map(file=>fs.rm(file,{force:true}))); }
}

async function runKotlinUsageSearchChecks(api,vscode,checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const settings = vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'), target = vscode.ConfigurationTarget.Global;
  assert.ok(process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,'Use the pinned open Kotlin editor server.');
  const root = await fs.mkdtemp(path.join(workspace,'rb-kotlin-usage-'));
  const restore = [];
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    const directory = path.join(root,'src/main/kotlin/editor/fixture');
    for (const [file,text] of Object.entries(kotlinExtensionSources())) await fs.writeFile(path.join(directory,file),text,{flag:'wx'});
    for (const [key,value] of [['serverHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME],['gradleUserHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME]]) {
      if (!value) continue;
      restore.push([key,settings.inspect(key)?.globalValue]);
      await settings.update(key,value,target);
    }
    const caller = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory,'ExtensionCaller.kt')));
    const lines = [];
    for (const [receiver,line] of [['invoice',2],['value',3]]) {
      const result = await until(async () => {
        const report = await api.javaNavigation.findUsages({uri:caller.uri,position:cursor(caller,receiver+'.ticketLabel()',receiver.length+3),scope:'file'});
        return report.targets.length ? report : undefined;
      },90000);
      assert.deepEqual(result.targets.map(target=>target.range.start.line),[line]);
      assert.equal(result.targets[0].provider,'kotlin');
      await api.javaNavigation.revealUsage(result,result.targets[0].id);
      assert.equal(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection),'ticketLabel');
      lines.push(line+1);
    }
    const jdbc = await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC service.');
    checks.push('The installed Kotlin usage search separated the identical extension name by receiver and opened each exact reference token.');
    return {springWorkspace:true,jdbc,provider:api.java.kotlinEditor.getState().serverVersion,receiverSpecificLines:lines,exactSelection:true};
  } finally {
    try { await api.java.kotlinEditor.stop(); }
    finally {
      for (const [key,previous] of restore.reverse()) await settings.update(key,previous,target);
      const owned = await fs.realpath(root);
      assert.equal(path.relative(path.dirname(owned),workspace),'');
      assert.match(path.basename(owned),/^rb-kotlin-usage-/);
      await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:150});
    }
  }
}

module.exports = {runJavaUsageSearchChecks,runKotlinUsageSearchChecks};
