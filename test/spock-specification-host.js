'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { populateSpockSpring, assertSpockSpring, failureLine } = require('./helpers/spock-specification-fixture');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

async function runSpockSpecificationChecks(api, vscode, checks) {
  const service = api.java.groovy;
  assert.equal(typeof service.runSpecification, 'function');
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api, workspace);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const fixture = await populateSpockSpring(workspace, {
    engine: spring.dbEngine, configFile: spring.dbConfigPath,
    classpathFile: process.env.ROCKETBRAIN_SPOCK_SPRING_CLASSPATH || path.join(spring.projectPath, 'build', 'runtime-classpath.txt'),
    gradleHome: vscode.workspace.getConfiguration('rocketbrain.java').get('gradleHome')
  });
  const projectAddress = vscode.Uri.file(fixture.root).toString();
  const inside = file => {
    const relative = path.relative(fixture.root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  try {
    const view = await api.java.workbench.resyncProject({ projectUri: projectAddress, allowProjectExecution: true });
    const project = view.projects.find(candidate => !path.relative(candidate.root, fixture.root));
    assert.equal(project?.tool, 'gradle');
    assert.ok(project.languages.includes('groovy'));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.fixtureSource));
    assert.equal(document.languageId, 'groovy');
    await vscode.window.showTextDocument(document, { preview: false });
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.groovy.runSpecification'));
    await assert.rejects(service.runSpecification({ document, projectUri: project.uri }), /before executing Gradle/u);
    const receipt = await vscode.commands.executeCommand('rocketbrain.groovy.runSpecification');
    assert.ok(receipt);
    assert.equal(receipt.source, document.uri.toString());
    const evidence = await assertSpockSpring(receipt, fixture, spring.dbEngine);
    const diagnostic = await until(() => vscode.languages.getDiagnostics(document.uri)
      .find(item => item.source === 'Spock' && item.range.start.line === failureLine - 1), 10000);
    assert.match(diagnostic.message, /actual == expected/u);
    const jdbc = await jdbcReadback();
    checks.push('The Groovy editor ran only the active Spock specification using Gradle and showed all three native case results.');
    checks.push('Spock reported the exact failure line from a real Spring JDBC assertion and left the unselected suite untouched.');
    return { ...evidence, nativeCommand: true, sourceDiagnosticLine: diagnostic.range.start.line + 1, springWorkspace: true, jdbc };
  } finally {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
      tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectAddress]).catch(() => {});
    const real = await fs.realpath(fixture.root);
    assert.equal(path.relative(workspace, path.dirname(real)), '');
    assert.ok(path.basename(real).startsWith('rb-groovy-fixture-'));
    await fs.rm(real, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

module.exports = { runSpockSpecificationChecks };
