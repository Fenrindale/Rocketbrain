'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { until } = require('./helpers/stdio-lsp');
const { populateTargets, buildTargets, runTargets } = require('./helpers/java-source-target-fixture');

async function runJavaSourceTargetChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpath = process.env.ROCKETBRAIN_SOURCE_TARGET_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const root = await fs.mkdtemp(path.join(workspace, 'rb-source-target-'));
  const inside = file => {
    const relative = path.relative(root, file);
    return Boolean(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  let imported = [];
  try {
    const targets = await populateTargets(root);
    await api.java.start();
    const config = vscode.workspace.getConfiguration('rocketbrain.java');
    const tools = { javaHome: api.java.getState().javaHome, gradleHome: config.get('gradleHome'), mavenHome: config.get('mavenHome') };
    const cache = process.env.ROCKETBRAIN_SOURCE_TARGET_GRADLE_CACHE || process.env.GRADLE_USER_HOME;
    assert.ok(cache, 'Use the populated independent Gradle fixture cache.');
    await buildTargets(root, tools, cache);
    const files = ['maven/pom.xml', 'gradle/build.gradle'].map(file => vscode.Uri.file(path.join(root, file)).toString());
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', files, [], []);
    const service = api.java.workbench.sourceTarget;
    const selected = ['maven/service', 'gradle/workbench', 'gradle/vendor/service'].map(file => path.join(root, file));
    await until(async () => {
      imported = (await api.java.executeWorkspaceCommand('java.project.getAll')).filter(uri => {
        try { return inside(fileURLToPath(uri)); } catch { return false; }
      });
      return selected.every(root => imported.some(uri => !path.relative(root, fileURLToPath(uri))));
    }, 160000);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.workbench.sourceTarget'));
    const records = {};
    for (const [name, sourceUri] of Object.entries(targets)) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));
      const report = await service.inspect({ sourceUri: document.uri });
      assert.equal(report.executedProjectCode, false);
      assert.equal(report.scope, name.endsWith('Test') ? 'test' : 'runtime');
      assert.equal(report.classpath.some(file => file.endsWith('junit-jupiter-api-6.1.3.jar')), name.endsWith('Test'));
      records[name] = report;
    }
    assert.equal(records.maven.declaredBuild.reactorProject, 'service');
    assert.equal(records.includedTest.declaredBuild.buildTreePath, ':linked-tools:service');
    const report = await service.show(records.includedTest.id);
    assert.equal(report.document.uri.scheme, 'rocketbrain-java-source-target');
    assert.match(report.document.getText(), /Build tree project path: :linked-tools:service/u);
    const detail = await service.openBuild(records.includedTest.id, 1);
    const editor = vscode.window.activeTextEditor;
    assert.equal(detail.kind, 'included-gradle-build');
    assert.match(editor.document.getText(editor.selection), /includeBuild\('vendor'\) \{ name = 'linked-tools' \}/u);
    const maven = await service.openBuild(records.maven.id, 0);
    assert.equal(maven.kind, 'reactor-module');
    assert.match(vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection), /<module>service<\/module>/u);
    const jdbc = await runTargets(root, tools, classpath, database, spring.dbEngine);
    checks.push('The installed source action distinguishes imported Maven reactor and renamed included Gradle projects and their main and test scopes.');
    checks.push('Opening the report and exact aggregation declaration uses read-only JDT queries. Both built Spring JDBC applications returned 42.');
    return { selected: Object.keys(records), jdbc, exactDeclarationLinks: true, readOnlyInspection: true };
  } finally {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const uri = tab.input?.uri;
        return uri?.scheme === 'file' && inside(uri.fsPath);
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (imported.length) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], imported).catch(() => {});
    } finally {
      const real = await fs.realpath(root);
      assert.equal(path.relative(workspace, path.dirname(real)), '');
      assert.ok(path.basename(real).startsWith('rb-source-target-'));
      await fs.rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
}

module.exports = { runJavaSourceTargetChecks };
