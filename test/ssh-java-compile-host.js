'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { stageJavaCompile } = require('./helpers/ssh-java-compile-fixture');

async function runSshJavaCompileChecks(api, vscode, checks) {
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sshWorkspace.javaCompile'));
  const workspace = api.sshWorkspace;
  const service = workspace.javaCompile;
  const { ROCKETBRAIN_SSH_PROCESS_TEST_JDK: javaHome, ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python,
    ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage, ROCKETBRAIN_SPRING_PROJECT_CONFIG: config } = process.env;
  assert.ok(javaHome && python && pythonPackage && config, 'Provide the owned SSH and Spring Java fixtures.');
  const preimage = await jdbcReadback();
  let cleanup;
  try {
    const fixture = await startSshProcessFixture({ python, pythonPackage, ownWorkerTemp: true }, callback => { cleanup = callback; });
    const staged = await stageJavaCompile(fixture, config);
    const root = await workspace.attach(fixture.profile);
    const uri = vscode.Uri.joinPath(root, ...staged.selectedFile.slice(1).split('/'));
    const file = await vscode.workspace.openTextDocument(uri);
    assert.equal(file.languageId, 'java');
    const review = await service.inspect(uri, javaHome, staged.jars);
    assert.equal(review.sourceCount, 2);
    assert.equal(review.module, staged.module);
    await assert.rejects(service.start(uri, { token: review.token }), /Approve the reviewed/);
    const approve = value => ({ token: value.token, allowSshJavaCompile: true });
    const result = await service.start(uri, approve(review));
    assert.equal(result.state, 'compiled');
    assert.deepEqual(result.classes, ['compilefixture/AccountRead.class', 'compilefixture/TableName.class']);
    assert.deepEqual(await fs.readdir(fixture.workerTemp), []);
    await assert.rejects(service.start(uri, approve(review)), /current SSH process review/);
    const stale = await service.inspect(uri, javaHome, staged.jars);
    await fs.writeFile(staged.companionFile, 'package compilefixture; final class TableName {}\n');
    await assert.rejects(service.start(uri, approve(stale)), /changed after review/);
    const broken = await service.inspect(uri, javaHome, staged.jars);
    const outcome = await service.start(uri, approve(broken));
    assert.equal(outcome.state, 'failed');
    const diagnostic = outcome.diagnostics.find(item => item.path === 'compilefixture/AccountRead.java');
    assert.ok(diagnostic);
    await service.openDiagnostic(uri, broken, diagnostic);
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.toString(), uri.toString());
    assert.equal(editor.selection.start.line, diagnostic.line - 1);
    assert.equal(editor.selection.start.character, diagnostic.column - 1);
    assert.deepEqual(await jdbcReadback(), preimage);
    assert.ok(!(await fs.readdir(path.join(fixture.profile.root, staged.module))).includes('target'));
    checks.sshJavaCompile = { classes: result.classCount, sourceCount: review.sourceCount, jarCount: staged.jars.length,
      actualJdkCompile: true, sourceDiagnosticOpened: true, staleCompanionRejected: true, oneShot: true,
      tempCleaned: true, jdbcUnchanged: true };
  } finally {
    workspace.close();
    if (vscode.window.activeTextEditor?.document.uri.scheme === 'rocketbrain-ssh') {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await cleanup?.();
  }
}

module.exports = { runSshJavaCompileChecks };
