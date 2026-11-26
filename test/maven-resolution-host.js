'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { populateMavenMediation, compileMavenProbe, runMavenProbe, resolutionAssertion } =
  require('./helpers/maven-resolution-fixture');

async function runMavenResolutionChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-maven-resolution-'));
  const workbench = api.java.workbench, service = workbench.mavenResolution;
  const projects = [];
  const belongs = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  try {
    await api.java.start();
    const setting = vscode.workspace.getConfiguration('rocketbrain.java');
    const tools = { javaHome: api.java.getState().javaHome, mavenHome: setting.get('mavenHome') };
    assert.ok(tools.mavenHome, 'Use the configured independent Maven installation.');
    const observations = [];
    for (const mode of ['nearest', 'managed']) {
      const project = await populateMavenMediation(path.join(root, mode), mode);
      const projectUri = vscode.Uri.file(project.root).toString();
      await workbench.resyncProject({ projectUri, allowProjectExecution: true });
      projects.push(projectUri);
      const report = await service.inspect({ projectUri, allowProjectExecution: true });
      const { selected, omitted, sourceKind } = resolutionAssertion(report, mode);
      const editor = await service.showReport(report.id, omitted?.id || selected.id);
      assert.equal(editor.document.uri.scheme, 'rocketbrain-maven-resolution');
      assert.match(editor.document.lineAt(editor.selection.start.line).text, /org\.jspecify:jspecify/u);
      const anchor = await service.openPom(report.id, selected.id);
      assert.equal(anchor.kind, sourceKind);
      const active = vscode.window.activeTextEditor;
      assert.equal(path.relative(path.join(project.root, 'pom.xml'), active.document.uri.fsPath), '');
      assert.match(active.document.getText(active.selection), /<version>1\.0\.0<\/version>/u);
      const classpath = await compileMavenProbe(project, tools);
      const actual = await runMavenProbe({ project, tools, classpath, database, engine: spring.dbEngine });
      observations.push({ mode, winner: selected.version, omitted: omitted?.version, managedFrom: selected.managedFrom,
        sourceKind, spring: actual });
    }
    checks.push('The installed Maven dependency view reveals selected and omitted paths and opens exact dependency and dependencyManagement nodes.');
    checks.push('The Maven-compiled Spring project loaded the selected artifact and read the same owned JDBC fixture.');
    return { observations, nativeTree: true, nativePomNavigation: true };
  } finally {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const uri = tab.input?.uri;
        return uri?.scheme === 'file' && belongs(uri.fsPath);
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projects.length) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], projects).catch(() => {});
    } finally {
      const real = await fs.realpath(root);
      assert.equal(path.relative(workspace, path.dirname(real)), '');
      assert.ok(path.basename(real).startsWith('rb-maven-resolution-'));
      await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
  }
}

module.exports = { runMavenResolutionChecks };
