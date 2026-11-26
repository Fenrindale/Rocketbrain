'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { sourcePath, selected, failures, selection, populateAccessProject, runAccessProject,
  assertAccessPlan } = require('./helpers/java-signature-access-fixture');

async function runJavaSignatureAccessChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_ACCESS_CLASSPATH ||
    path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const temp = await fs.realpath(os.tmpdir());
  const outputs = await fs.mkdtemp(path.join(temp, 'rb-access-classes-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-signature-access-'));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let document, projectUri;
  try {
    await populateAccessProject(root, classpathFile, spring.dbEngine);
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = async () => runAccessProject({ javaHome, root, database, engine: spring.dbEngine, classpathFile,
      classes: await fs.mkdtemp(path.join(outputs, 'classes-')) });
    const before = await run();
    const descriptor = vscode.Uri.file(path.join(root, '.project')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []);
    const sourceUri = vscode.Uri.file(path.join(root, sourcePath));
    projectUri = await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', sourceUri.toString(), { scope: 'test' });
      return model?.projectRoot && path.relative(root, vscode.Uri.parse(model.projectRoot).fsPath) === '' &&
        model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? model.projectRoot : undefined;
    }, 100000);
    document = await vscode.workspace.openTextDocument(sourceUri);
    const showSource = () => vscode.window.showTextDocument(document, { preview: false });
    await showSource();
    const signature = api.java.changeSignature;
    const inspect = marker => {
      const { start, end } = selection(document.getText(), marker);
      return signature.info(document, new vscode.Range(start.line, start.character, end.line, end.character));
    };
    for (const [marker, reason] of failures) await assert.rejects(inspect(marker), reason);
    const info = await inspect(selected);
    const plan = await signature.preview(info.id, { visibility: 'private' });
    assertAccessPlan(info, plan);
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
    assert.equal(diff.getText().replace(/\r\n/gu, '\n'), plan.documents[0].after.replace(/\r\n/gu, '\n'));
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    assert.equal(document.getText(), plan.documents[0].after);
    await showSource();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(() => document.getText() === plan.documents[0].before, 15000);
    await vscode.commands.executeCommand('redo');
    await until(() => document.getText() === plan.documents[0].after, 15000);
    assert.equal(await document.save(), true);
    const after = await run();
    assert.deepEqual(after, before);
    checks.push('Change Signature makes one closed-nest package-private Java method private after exact direct caller review.');
    checks.push('Native Undo and Redo restore the exact modifier. The real Spring JDBC result stays 42.');
    return { visibilityChange: plan.signature.visibilityChange, preservedDirectCalls: plan.signature.resolvedReferences,
      before, after, nativeApplyUndoRedo: true, refusedAccessScopes: failures.length };
  } finally {
    try {
      if (document?.isDirty) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [dir, parent, prefix] of [[root, workspace, 'rb-signature-access-'], [outputs, temp, 'rb-access-classes-']]) {
        const real = await fs.realpath(dir);
        assert.equal(path.relative(parent, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaSignatureAccessChecks };
