'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { prepareGroovyProject, rangeFor, withGroovyDatabase, expectedOutput } = require('./helpers/groovy-project-fixture');

async function runGroovyProjectConsoleChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-groovy-project-'));
  const service = api.java.groovy.project;
  const run = plan => service.run({ id: plan.id, allowExecution: true });
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const reviews = new Set();
  let projectUri;
  try {
    await api.java.start();
    const config = vscode.workspace.getConfiguration('rocketbrain.java');
    const fixture = await prepareGroovyProject(root, {
      javaHome: api.java.getState().javaHome, mavenHome: config.get('mavenHome')
    });
    const descriptor = vscode.Uri.file(path.join(root, 'pom.xml')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []);
    const reference = vscode.Uri.file(path.join(root, fixture.nativeSource)).toString();
    projectUri = await until(async () => {
      const metadata = await api.java.executeWorkspaceCommand('java.project.getClasspaths', reference, { scope: 'runtime' });
      return metadata?.projectRoot && !path.relative(root, vscode.Uri.parse(metadata.projectRoot).fsPath) &&
        metadata.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? metadata.projectRoot : undefined;
    }, 120000);
    const commandIds = await vscode.commands.getCommands(true);
    assert.ok(commandIds.includes('rocketbrain.groovy.projectSelection'));
    assert.ok(commandIds.includes('rocketbrain.groovy.stopProject'));
    const review = async (name, scope = 'runtime') => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'scripts', name + '.groovy')));
      const { start, end } = rangeFor(document, name);
      const plan = await service.review({ document, range: new vscode.Range(start, end), projectUri, scope });
      reviews.add(plan.id);
      return plan;
    };
    const plan = await review('query');
    assert.equal(plan.project.tool, 'maven');
    assert.ok(plan.classpath.some(entry => entry.kind === 'directory' && entry.files > 0));
    const view = await service.show(plan.id);
    assert.equal(view.document.uri.scheme, 'rocketbrain-groovy-project');
    assert.ok(view.document.getText().includes(plan.source));
    await assert.rejects(service.run({ id: plan.id }), /Explicitly approve/u);
    const jdbc = await withGroovyDatabase(database, spring.dbEngine, async () => expectedOutput(await run(plan), spring.dbEngine));
    await assert.rejects(run(plan), /selection again/u);
    assert.equal((await run(await review('scope'))).state, 'error');
    assert.equal((await run(await review('scope', 'test'))).value, 'test-class');
    checks.push('The installed project Groovy selection opens a read-only source and classpath review before running the approved code.');
    checks.push('An imported Maven project supplies copied Java classes, resources, Spring JDBC and distinct runtime and test classpaths.');
    return { jdbc, runtimeAndTestScopes: true, copiedProjectClassAndResources: true, approvedSelectionOnly: true, oneUse: true };
  } finally {
    try {
      await service.stop();
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const uri = tab.input?.uri;
        return uri && (uri.scheme === 'file' && inside(uri.fsPath) ||
          uri.scheme === 'rocketbrain-groovy-project' && reviews.has(uri.path.split('/')[1]));
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      const owned = await fs.realpath(root);
      assert.equal(path.relative(workspace, path.dirname(owned)), '');
      assert.match(path.basename(owned), /^rb-groovy-project-/u);
      await fs.rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }
}

module.exports = { runGroovyProjectConsoleChecks };
