'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { until, positionOf } = require('./helpers/stdio-lsp');
const { javaFile, kotlinFile, prepareNullabilityFixture, brokenCalls, restoreCalls, runJdbc } =
  require('./helpers/mixed-nullability-fixture');

async function runKotlinNullabilityChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const prepared = process.env.ROCKETBRAIN_V113_NULLABILITY_WORKSPACE;
  const project = prepared ? await fs.realpath(prepared) : await fs.mkdtemp(path.join(workspace,'rb-kotlin-nullability-'));
  const parent = prepared ? path.dirname(workspace) : workspace;
  if (prepared) {
    assert.equal(path.relative(parent,path.dirname(project)),'');
    assert.match(path.basename(project),/^rb-kotlin-nullability-(?:mysql|mariadb)$/u);
    assert.equal(path.relative(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project)).uri.fsPath,project),'');
  }
  const uri = vscode.Uri.file(project);
  const javaSettings = vscode.workspace.getConfiguration('rocketbrain.java', uri);
  const kotlinSettings = vscode.workspace.getConfiguration('rocketbrain.kotlinEditor', uri);
  const tools = {
    javaHome: javaSettings.get('javaHome') || api.java.getState().javaHome,
    gradleHome: process.env.ROCKETBRAIN_MIXED_RENAME_GRADLE_HOME || javaSettings.get('gradleHome'),
    gradleUserHome: process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME || kotlinSettings.get('gradleUserHome')
  };
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const testFile = path.join(project, kotlinFile), javaPath = path.join(project, javaFile);
  const service = api.java.kotlinEditor.nullability;

  try {
    if (!prepared) await prepareNullabilityFixture(project, tools);
    const before = await runJdbc(project, tools, config, spring.dbEngine);
    const original = await fs.readFile(javaPath);
    const saved = await brokenCalls(project, ['checked', 'items', 'ordinary']);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(testFile));
    await vscode.window.showTextDocument(document, { preview: false });
    await api.java.start();
    const dependency = await vscode.workspace.openTextDocument(vscode.Uri.file(javaPath));
    await until(async () => {
      const cp = await api.java.executeWorkspaceCommand('java.project.getClasspaths',dependency.uri.toString(),{scope:'runtime'});
      const root = cp?.projectRoot && (cp.projectRoot.startsWith('file:') ? fileURLToPath(cp.projectRoot) : cp.projectRoot);
      return root && path.isAbsolute(root) && path.relative(project,root)==='' &&
        cp.classpaths?.some(file => file.endsWith('jspecify-1.0.1.jar'));
    }, 100000);
    await api.java.kotlinEditor.start({ document });
    const point = name => {
      const found = positionOf(document.getText(), 'Names.' + name, 'Names.'.length);
      return new vscode.Position(found.line, found.character);
    };
    await until(async () => {
      const answer = await api.java.kotlinEditor.definition(document, point('platform'));
      return (Array.isArray(answer) ? answer : [answer]).some(link => (link?.targetUri || link?.uri)?.endsWith('/Names.java'));
    }, 85000);
    const observed = [];
    for (const [name, code] of [['checked', 'UPPER_BOUND_VIOLATED'], ['items', 'UNSAFE_CALL'], ['platform', undefined]]) {
      const result = await service.inspect({ document, position: point(name) });
      assert.equal(result.target.file, javaPath);
      const native = vscode.languages.getDiagnostics(document.uri).filter(item => item.source === 'Rocketbrain JSpecify');
      if (code) assert.ok(native.some(item => item.code === code), name + ' diagnostics');
      else assert.deepEqual(native, []);
      for (const diagnostic of native) {
        const location = diagnostic.relatedInformation[0].location;
        assert.equal(path.relative(javaPath, location.uri.fsPath), '');
        assert.equal((await vscode.workspace.openTextDocument(location.uri)).getText(location.range), name);
      }
      const editor = await service.openJava(result);
      assert.equal(path.relative(javaPath, editor.document.uri.fsPath), '');
      assert.equal(editor.document.getText(editor.selection), name);
      observed.push({ name, codes: result.diagnostics.map(item => item.code) });
    }
    assert.equal(await fs.readFile(testFile, 'utf8'), saved);
    assert.deepEqual(await fs.readFile(javaPath), original);
    const previous = await service.inspect({ document, position: point('platform') });
    await fs.appendFile(javaPath, '\n// Native source change invalidates the review.\n');
    await assert.rejects(service.openJava(previous), /Inspect the current Java contract|selected Gradle project changed/u);
    await fs.writeFile(javaPath, original);
    await restoreCalls(project, tools);
    const after = await runJdbc(project, tools, config, spring.dbEngine);
    assert.deepEqual(after, before);
    checks.push('Kotlin compiler diagnostics identify JSpecify generic bounds and nullable generic elements with exact navigable Java declarations.');
    checks.push('A platform type stays quiet, unrelated Kotlin checks are omitted, and a changed Java file invalidates navigation.');
    return { observed, nativeProblems: true, exactJavaNavigation: true, staleRejected: true, spring: after };
  } finally {
    await api.java.kotlinEditor.stop().catch(() => {});
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      if (tab.input?.uri?.scheme !== 'file') return false;
      const relative = path.relative(project, tab.input.uri.fsPath);
      return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    const real = await fs.realpath(project);
    assert.equal(path.relative(parent,path.dirname(real)),'');
    assert.match(path.basename(real), /^rb-kotlin-nullability-[^/\\]+$/u);
    if (!prepared) await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports = { runKotlinNullabilityChecks };
