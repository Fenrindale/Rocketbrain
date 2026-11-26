'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { springJdbcClasspath } = require('./helpers/instance-inline-fixture');
const { ownerPath, sourceFolder, targetFolder, clientPath, unrelated, sources, populatePackageRename, runPackageSpring } =
  require('./helpers/java-package-rename-fixture');

async function runJavaPackageRenameChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const parent = await fs.realpath(os.tmpdir()), compile = await fs.mkdtemp(path.join(parent, 'rb-package-native-build-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-package-rename-'));
  const old = path.join(root, sourceFolder), next = path.join(root, targetFolder), caller = path.join(root, clientPath);
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const exists = file => fs.stat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  function inDirectory(directory, file) {
    const relative = path.relative(directory, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  let projectUri;
  try {
    await populatePackageRename(root, await springJdbcClasspath(classpathFile, spring.dbEngine));
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = async renamed => runPackageSpring({ javaHome, root, database, engine: spring.dbEngine,
      classpathFile, classes: await fs.mkdtemp(path.join(compile, 'classes-')), renamed });
    const original = await run(false);
    const descriptor = vscode.Uri.file(path.join(root, '.project')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []).catch(() => {});
    const java = await open(path.join(root, ownerPath));
    for (const relative of sources.keys()) await open(path.join(root, relative));
    await vscode.window.showTextDocument(java, { preview: false });
    projectUri = await until(async () => {
      const cp = await api.java.executeWorkspaceCommand('java.project.getClasspaths', java.uri.toString(), { scope: 'test' });
      return cp?.projectRoot && path.relative(root, vscode.Uri.parse(cp.projectRoot).fsPath) === '' &&
        cp.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? cp.projectRoot : undefined;
    }, 100000);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.renamePackage'));
    await assert.rejects(api.java.move.prepareRenamePackage(java, 'Billing'), /exists or collides by case/u);
    const plan = await api.java.move.prepareRenamePackage(java, 'settlement');
    assert.equal(plan.packageRename.movedFiles, 2);
    assert.equal(plan.packageRename.editedFiles, 4);
    assert.equal(plan.resourceOperations.length, 1);
    assert.equal(plan.resourceOperations[0].directory, true);
    assert.equal(plan.resourceOperations[0].newUri, vscode.Uri.file(next).toString());
    assert.equal(await exists(next), false);
    const callerIndex = plan.documents.findIndex(change => path.relative(caller, vscode.Uri.parse(change.uri).fsPath) === '');
    assert.ok(callerIndex >= 0);
    for (const side of ['before', 'after']) {
      const virtual = await vscode.workspace.openTextDocument(
        vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + callerIndex + '/' + side + '.java'));
      assert.equal(virtual.getText().replace(/\r\n/gu, '\n'), plan.documents[callerIndex][side].replace(/\r\n/gu, '\n'));
    }

    const fileAfter = file => inDirectory(old, file) ? path.join(next, path.relative(old, file)) : file;
    async function ensureState(after) {
      await until(async () => (await exists(old)) === !after && (await exists(next)) === after, 10000);
      for (const value of plan.documents) {
        const file = vscode.Uri.parse(value.uri).fsPath;
        const observed = await open(after ? fileAfter(file) : file);
        assert.equal(observed.getText(), after ? value.after : value.before);
      }
    }
    await fs.mkdir(next);
    await assert.rejects(api.java.refactoring.apply(plan.id), /destination package already exists/u);
    await fs.rmdir(next);
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await ensureState(true);
    async function history(command, after) {
      await vscode.window.showTextDocument(await open(caller), { preview: false, preserveFocus: false });
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand(command);
      await ensureState(after);
    }
    await history('undo', false);
    await history('redo', true);
    for (const value of plan.documents) {
      assert.equal(await (await open(fileAfter(vscode.Uri.parse(value.uri).fsPath))).save(), true);
    }
    assert.equal(await fs.readFile(path.join(root, unrelated), 'utf8'), sources.get(unrelated));
    const final = await run(true);
    assert.deepEqual(final, original);
    checks.push('JDT and Javac reviewed main/test callers and nested packages with one native directory rename and text edit.');
    checks.push('The directory and edits undo and redo together. Saved Java sources preserve the Spring bean and JDBC result.');
    return { ...plan.packageRename, nativeWorkspaceEdit: true, nativeDirectoryUndo: true, nativeDirectoryRedo: true,
      lateTargetRefused: true, spring: final };
  } finally {
    try {
      for (const document of vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && inDirectory(root, doc.uri.fsPath))) {
        if (!document.isDirty) continue;
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inDirectory(root, tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [folder, base, prefix] of [[root, workspace, 'rb-package-rename-'], [compile, parent, 'rb-package-native-build-']]) {
        const real = await fs.realpath(folder);
        assert.equal(path.relative(base, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaPackageRenameChecks };
