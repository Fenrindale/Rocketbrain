'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { until, positionOf } = require('./helpers/stdio-lsp');
const { buildIndexFixture, querySpring } = require('./helpers/java-workspace-index-fixture');

function removeFixture(folder, boundary, prefix) {
  const physical = fs.realpathSync(folder);
  assert.equal(path.relative(boundary, path.dirname(physical)), '');
  assert.ok(path.basename(physical).startsWith(prefix));
  fs.rmSync(physical, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}

async function runJavaWorkspaceIndexChecks(api, vscode, checks) {
  const workspace = fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.ok(vscode.workspace.isTrusted);
  const spring = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const config = JSON.parse(fs.readFileSync(spring.dbConfigPath, 'utf8'));
  const classpath = process.env.ROCKETBRAIN_JAVA_INDEX_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const temporary = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(temporary, 'rb-native-index-build-'));
  const project = fs.mkdtempSync(path.join(workspace, 'rb-native-index-workspace-'));
  let fixture;
  try {
    await api.java.start();
    const settings = vscode.workspace.getConfiguration('rocketbrain.java');
    const runtime = { javaHome: api.java.getState().javaHome };
    fixture = await buildIndexFixture(project, { ...runtime,
      mavenHome: settings.get('mavenHome') || process.env.ROCKETBRAIN_JAVA_INDEX_MAVEN_HOME,
      gradleHome: settings.get('gradleHome') });
    await api.java.restart();
    const before = await until(async () => {
      const model = await api.java.workbench.refresh();
      return [fixture.maven, fixture.gradle].every(file =>
        model.projects.some(item => !path.relative(file, item.root))) &&
        api.java.getState();
    }, 150000);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.gradleReader));
    const spot = positionOf(document.getText(), 'GeneratedLabel.value', 16);
    const position = new vscode.Position(spot.line, spot.character);
    async function definition() {
      return until(async () => {
        const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
        const target = locations?.find(location => {
          const file = location.targetUri || location.uri;
          return file?.scheme === 'file' && !path.relative(fixture.generated, file.fsPath);
        });
        return target && { path: path.relative(project, fixture.generated),
          line: (target.targetSelectionRange || target.range).start.line };
      }, 90000);
    }
    const originalDefinition = await definition();
    const springBefore = await querySpring(path.join(scratch, 'before'), fixture, runtime, spring.dbEngine, classpath, config);
    const plan = await api.java.workspaceIndex.review();
    assert.ok(plan.projects.some(item => !path.relative(fixture.gradle, item.root) && item.generatedRoots > 0));
    assert.ok(plan.projects.some(item => !path.relative(fixture.maven, item.root)));
    await assert.rejects(api.java.workspaceIndex.apply(plan.id), /approve/u);
    assert.equal(api.java.getState().workspaceData, before.workspaceData);
    const result = await api.java.workspaceIndex.apply(plan.id, { approved: true });
    assert.equal(result.state, 'rebuilt');
    assert.equal(result.previousWorkspaceData, before.workspaceData);
    assert.equal(result.workspaceData, api.java.getState().workspaceData);
    assert.ok(result.priorRetained && fs.statSync(result.previousWorkspaceData).isDirectory());
    assert.deepEqual(await definition(), originalDefinition);
    const springAfter = await querySpring(path.join(scratch, 'after'), fixture, runtime, spring.dbEngine, classpath, config);
    assert.deepEqual(springAfter, springBefore);
    await api.java.restart();
    assert.equal(api.java.getState().indexGeneration, result.generation);
    assert.equal(api.java.getState().workspaceData, result.workspaceData);
    assert.deepEqual(await definition(), originalDefinition);
    checks.push('The installed Java workspace index review selects Maven and Gradle, switches to a fresh JDT LS data directory, and retains the prior generation. A normal restart reopens the verified generation.');
    checks.push('Both generations navigate to the same actual Gradle-generated declaration. Recombined Maven and Gradle outputs execute a Spring JDBC prepared query against the owned server.');
    return { state: result.state, retained: result.priorRetained, generatedDefinition: originalDefinition,
      ordinaryRestartReusedGeneration: true, projects: result.projects, inputs: result.inputFiles, spring: springAfter };
  } finally {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const file = tab.input?.uri;
        if (file?.scheme !== 'file') return false;
        const relative = path.relative(project, file.fsPath);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (fixture) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [],
        [fixture.maven, fixture.gradle].map(file => vscode.Uri.file(file).toString())).catch(() => {});
    } finally {
      removeFixture(project, workspace, 'rb-native-index-workspace-');
      removeFixture(scratch, temporary, 'rb-native-index-build-');
    }
  }
}

module.exports = { runJavaWorkspaceIndexChecks };
