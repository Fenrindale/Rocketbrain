'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { createProjectLayout, compileProjectLayout, removeProjectLayout, checkLayout } = require('./helpers/java-project-layout-fixture');

async function runJavaProjectLayoutChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(workspace, await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
  assert.ok(workspace.split(path.sep).includes('test-output'));
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const tools = { javaHome: runtime.javaHome, mavenHome: process.env.ROCKETBRAIN_MAVEN_HOME, gradleHome: process.env.ROCKETBRAIN_GRADLE_HOME };
  const fixture = await createProjectLayout(workspace);
  const workbench = api.java.workbench;
  let imported = false;
  try {
    const compiled = await compileProjectLayout(fixture, tools);
    await importedSpring(api, workspace);
    imported = true;
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', fixture.configUris, [], []);
    const details = await until(async () => {
      const current = checkLayout(await workbench.refresh(), fixture);
      return current.mavenEdge && current.gradleEdge ? current : undefined;
    }, 150000);
    const children = id => workbench.getTreeChildren(id);
    const group = (project, label) => children(project.id).find(node => node.name.startsWith(label));
    const outputs = children(group(details.maven, 'Build outputs').id);
    const actual = outputs.find(node => node.kind === 'output' && node.exists && node.scopes.includes('test'));
    assert.ok(actual);
    const result = await vscode.commands.executeCommand('rocketbrain.java.workbench.revealBuildOutput', actual.id);
    assert.equal(path.relative(result.path, actual.path), '');
    for (const [project, edge] of [[details.maven, details.mavenEdge], [details.gradle, details.gradleEdge]]) {
      const node = children(group(project, 'Dependencies').id).find(item => item.id === edge.id);
      assert.ok(node?.projectDependency);
      const linked = await vscode.commands.executeCommand('rocketbrain.java.workbench.revealProjectDependency', node.id);
      assert.equal(linked.projectId, edge.projectDependency.id);
    }
    const source = children(group(details.gradle, 'Source roots').id).find(item => item.id === details.generated.id);
    const pkg = children(source.id).find(item => item.name === 'fixture.layout');
    const java = children(pkg.id).find(item => item.name === 'GeneratedLayout.java');
    await vscode.commands.executeCommand('rocketbrain.java.workbench.openSource', java.id);
    assert.equal(path.relative(vscode.window.activeTextEditor.document.uri.fsPath, java.path), '');
    assert.match(vscode.window.activeTextEditor.document.getText(), /class GeneratedLayout/);
    checks.push('The Java Projects view opened an observed generated source, revealed its real build layout and navigated exact Maven reactor and Gradle composite project dependencies.');
    return { compiled, mainTestOutputs: true, generatedOpened: true, mavenEdge: true, gradleEdge: true,
      nativeBuildOutputReveal: true, nativeProjectDependencyReveal: true, jdbc: await jdbcReadback() };
  } finally {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      const file = tab.input?.uri?.fsPath;
      return file && path.relative(fixture.directory, file).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(fixture.directory, file));
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    if (imported) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], fixture.projectUris);
    try { await removeProjectLayout(fixture, workspace); }
    catch (error) { if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error; }
  }
}

module.exports = { runJavaProjectLayoutChecks };
