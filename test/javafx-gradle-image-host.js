'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');
const { populate, checkLauncher } = require('./helpers/javafx-gradle-image-fixture');

async function runJavaFxGradleImageChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const root = await fs.mkdtemp(path.join(workspace, 'rb-javafx-gradle-'));
  const project = vscode.Uri.file(root);
  try {
    populate(root);
    await assert.rejects(api.java.fx.build(project, 'image'), /explicit action/u);
    const result = await api.java.fx.build(project, 'image', { allowProjectExecution: true });
    const evidence = checkLauncher(root, result);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('The installed JavaFX action discovered :jlink, verified a Gradle runtime image and reported its working FXML launcher.');
    return { ...evidence, reviewedTask: result.task, installerOrImageAutoLaunched: false, jdbc };
  } finally {
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [project.toString()]);
    const real = await fs.realpath(root);
    assert.equal(path.relative(workspace, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-javafx-gradle-/u);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 12, retryDelay: 350 });
  }
}

module.exports = { runJavaFxGradleImageChecks };
