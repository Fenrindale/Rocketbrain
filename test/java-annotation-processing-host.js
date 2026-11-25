'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { LOMBOK_URL,LOMBOK_VERSION,LOMBOK_SHA256 } = require('../src/java/annotation-processing');
const { copyProcessorProject,processorSource,renamedProcessorSources } = require('./helpers/java-processor-fixture');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

const equivalent = (left,right) => !path.relative(left,right);

async function runJavaAnnotationProcessorChecks(api,vscode,checks) {
  assert.ok(vscode.workspace.isTrusted);
  const host = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,host);
  const scratch = await fs.mkdtemp(path.join(host,'rb-java-processors-'));
  const configuration = vscode.workspace.getConfiguration('rocketbrain.java');
  const setting = {lombok:'annotationProcessing.lombokJar',gradle:'annotationProcessing.gradleEnabled'};
  const previous = Object.fromEntries(Object.values(setting).map(key => [key,configuration.inspect(key)?.globalValue]));
  const target = vscode.ConfigurationTarget.Global;
  const projects = [];
  let changedSettings = false;
  try {
    const agent = path.join(scratch,'lombok-'+LOMBOK_VERSION+'.jar');
    let bytes;
    if (process.env.ROCKETBRAIN_LOMBOK_TEST_JAR) bytes = await fs.readFile(process.env.ROCKETBRAIN_LOMBOK_TEST_JAR);
    else {
      const response = await fetch(LOMBOK_URL,{signal:AbortSignal.timeout(30000)});
      assert.equal(response.ok,true);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'),LOMBOK_SHA256);
    await fs.writeFile(agent,bytes,{flag:'wx'});
    changedSettings=true;
    await configuration.update(setting.lombok,agent,target);
    await configuration.update(setting.gradle,true,target);
    let runtime = await api.java.start();
    if (!runtime.annotationProcessing?.gradle || runtime.annotationProcessing?.lombok?.version !== LOMBOK_VERSION) {
      runtime = await api.java.restart();
    }
    assert.equal(runtime.state,'running');
    assert.deepEqual(runtime.annotationProcessing,{
      gradle:true,maven:'project',lombok:{version:LOMBOK_VERSION,sha256:LOMBOK_SHA256}
    });
    for (const tool of ['maven','gradle']) {
      const root = await copyProcessorProject(path.join(scratch,tool),tool);
      const projectUri = vscode.Uri.file(root).toString();
      projects.push({root,projectUri,tool});
      await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    }

    async function verify({root,tool}) {
      const documents = {};
      for (const name of ['Profile','ProfileMapper','ProcessorProbe']) {
        documents[name] = await vscode.workspace.openTextDocument(vscode.Uri.file(processorSource(root,name)));
      }
      const probe = documents.ProcessorProbe;
      const at = (marker,extra=2) => {
        const start = probe.getText().indexOf(marker);
        assert.ok(start >= 0,marker);
        return probe.positionAt(start+extra);
      };
      const completion = async (marker,extra) => {
        const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',probe.uri,at(marker,extra));
        return (result?.items || []).map(item => typeof item.label === 'string' ? item.label : item.label.label);
      };
      const definition = async marker => {
        const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',probe.uri,at(marker));
        return result?.[0]?.targetUri || result?.[0]?.uri;
      };
      const errors = () => vscode.languages.getDiagnostics(probe.uri).filter(value => value.severity === vscode.DiagnosticSeverity.Error);
      const hasGetter = (labels,name) => labels.some(label => new RegExp('^'+name+'(?:\\(|$)').test(label));
      const build = async () => {
        const result = await api.java.buildWorkspace();
        return result === 0 || result === 1 || result?.status === 'succeed';
      };
      await until(build,45000);
      await until(async () => {
        const labels = await completion('value.getLabel()',6);
        return hasGetter(labels,'getLabel') && !errors().length;
      },30000);
      assert.ok(equivalent((await definition('getLabel()')).fsPath,documents.Profile.uri.fsPath));
      const generated = await until(() => definition('ProfileMapperImpl()'),30000);
      await until(async () => (await completion('new ProfileMapperImpl()',17)).some(label => label.includes('ProfileMapperImpl')),30000);
      assert.match(generated.fsPath,/generated-sources[\\/]annotations[\\/].*ProfileMapperImpl\.java$/);
      const generatedRoot = tool === 'maven' ? 'target' : 'bin';
      assert.equal(path.relative(root,generated.fsPath).split(path.sep).join('/'),
        generatedRoot+'/generated-sources/annotations/processors/fixture/ProfileMapperImpl.java');
      assert.match(await fs.readFile(generated.fsPath,'utf8'),/value\.getLabel\(\)/);

      async function replace(changes) {
        const edit = new vscode.WorkspaceEdit();
        for (const [name,text] of Object.entries(changes)) {
          const document = documents[name];
          edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);
        }
        assert.ok(await vscode.workspace.applyEdit(edit));
      }
      const original = Object.fromEntries(Object.entries(documents).map(([name,doc]) => [name,doc.getText()]));
      await replace({ProcessorProbe:original.ProcessorProbe.replace('getLabel()','getMissing()')});
      await until(() => errors().some(item => /getMissing/.test(item.message)),30000);
      await replace(renamedProcessorSources(original));
      for (const doc of Object.values(documents)) assert.ok(await doc.save());
      await until(build,45000);
      await until(async () => {
        const labels = await completion('value.getAlias()',6), output = await fs.readFile(generated.fsPath,'utf8');
        return !errors().length && hasGetter(labels,'getAlias') && !hasGetter(labels,'getLabel') && /value\.getAlias\(\)/.test(output);
      },35000);
      assert.ok(equivalent((await definition('getAlias()')).fsPath,documents.Profile.uri.fsPath));
      return {tool,getterCompletion:true,generatedTypeCompletion:true,generatedSourceDefinition:true,invalidGetterDiagnostic:true,incrementalRegeneration:true};
    }

    const evidence = [];
    for (const project of projects) evidence.push(await verify(project));
    const jdbc = await jdbcReadback();
    checks.push('Independent JDT processed real Lombok and MapStruct in Maven and Gradle projects, with completion, definitions, errors and incremental regeneration checked in VS Code.');
    return {lombokVersion:LOMBOK_VERSION,verifiedAgentSha256:LOMBOK_SHA256,projects:evidence,springWorkspace:true,jdbc};
  } finally {
    for (const document of vscode.workspace.textDocuments.filter(item => item.uri.scheme === 'file' &&
      item.uri.fsPath.startsWith(scratch+path.sep))) {
      if (document.isDirty) await document.save();
      if (vscode.window.visibleTextEditors.some(editor => editor.document === document)) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
    if (projects.length) {
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],
        projects.map(project => project.projectUri)).catch(() => {});
    }
    if (changedSettings) {
      await configuration.update(setting.lombok,previous[setting.lombok],target);
      await configuration.update(setting.gradle,previous[setting.gradle],target);
      await api.java.start().catch(() => {});
    }
    const actual = await fs.realpath(scratch);
    if (path.dirname(actual) !== host || !path.basename(actual).startsWith('rb-java-processors-')) {
      throw Error('Processor fixture ownership changed before cleanup.');
    }
    await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

module.exports = { runJavaAnnotationProcessorChecks };
