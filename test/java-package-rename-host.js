'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { ownerPath, sourceFolder, targetFolder, clientPath, unrelated, fixtureSources, populatePackageRename, runPackageSpring,
  bootFiles, bootText, packageClasspath, serviceFile, serviceText, javaLocation } =
  require('./helpers/java-package-rename-fixture');

async function runJavaPackageRenameChecks(api, vscode, checks, { withBoot = false, withServices = false } = {}) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const parent = await fs.realpath(os.tmpdir()), compile = await fs.mkdtemp(path.join(parent, 'rb-package-native-build-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-package-rename-'));
  const file = relative => path.join(root, javaLocation(relative, withServices));
  const old = file(sourceFolder), next = file(targetFolder), caller = file(clientPath);
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
    const sources = fixtureSources(withBoot, withServices);
    await populatePackageRename(root, await packageClasspath(classpathFile, spring.dbEngine, withBoot), { withBoot, withServices });
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = async renamed => runPackageSpring({ javaHome, root, database, engine: spring.dbEngine,
      classpathFile, classes: await fs.mkdtemp(path.join(compile, 'classes-')), renamed, withBoot, withServices });
    const original = await run(false);
    const descriptor = vscode.Uri.file(path.join(root, '.project')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []).catch(() => {});
    const java = await open(file(ownerPath));
    for (const relative of sources.keys()) await open(path.join(root, relative));
    await vscode.window.showTextDocument(java, { preview: false });
    projectUri = await until(async () => {
      const cp = await api.java.executeWorkspaceCommand('java.project.getClasspaths', java.uri.toString(), { scope: 'test' });
      return cp?.projectRoot && path.relative(root, vscode.Uri.parse(cp.projectRoot).fsPath) === '' &&
        cp.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? cp.projectRoot : undefined;
    }, 100000);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.renamePackage'));
    await assert.rejects(api.java.move.prepareRenamePackage(java, 'Billing'), /exists or collides by case/u);
    if (withBoot) {
      const registry = path.join(root, bootFiles[0]);
      const stale = await api.java.move.prepareRenamePackage(java, 'settlement');
      await fs.appendFile(registry, '# changed after review\r\n');
      try { await assert.rejects(api.java.refactoring.apply(stale.id), /changed after review/u); }
      finally { await fs.writeFile(registry, bootText(0, false)); }
      await until(async () => (await open(registry)).getText() === bootText(0, false), 10000);
    }
    if (withServices) {
      const registry = path.join(root, serviceFile(0));
      const stale = await api.java.move.prepareRenamePackage(java, 'settlement');
      await fs.appendFile(registry, '# changed after review\r\n');
      try { await assert.rejects(api.java.refactoring.apply(stale.id), /changed after review/u); }
      finally { await fs.writeFile(registry, serviceText(0)); }
      await until(async () => (await open(registry)).getText() === serviceText(0), 10000);
      const collision = await api.java.move.prepareRenamePackage(java, 'settlement');
      const destination = path.join(root, serviceFile(0, true));
      await fs.writeFile(destination, serviceText(0, true), { flag: 'wx' });
      try { await assert.rejects(api.java.refactoring.apply(collision.id), /changed after review|destination/u); }
      finally { await fs.unlink(destination); }
    }
    const plan = await api.java.move.prepareRenamePackage(java, 'settlement');
    assert.equal(plan.packageRename.movedFiles, (withBoot ? 3 : 2) + (withServices ? 3 : 0));
    assert.equal(plan.packageRename.editedFiles, (withBoot ? 7 : 4) + (withServices ? 7 : 0));
    assert.equal(plan.resourceOperations.length, withServices ? 2 : 1);
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
    if (withBoot) {
      assert.deepEqual(plan.packageRename.bootImports, { files: 2, registrations: 2 });
      for (const [index, relative] of bootFiles.entries()) {
        const slot = plan.documents.findIndex(change => path.relative(path.join(root, relative), vscode.Uri.parse(change.uri).fsPath) === '');
        assert.ok(slot >= 0);
        for (const side of ['before', 'after']) {
          const virtual = await vscode.workspace.openTextDocument(
            vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + slot + '/' + side + '.imports'));
          assert.equal(virtual.getText(), bootText(index, side === 'after'));
        }
      }
    }
    if (withServices) {
      assert.equal(plan.packageRename.services.descriptors, 2);
      assert.equal(plan.packageRename.services.renamedDescriptors, 1);
      assert.equal(plan.packageRename.services.providerNames, 2);
      assert.equal(plan.resourceOperations[1].newUri, vscode.Uri.file(path.join(root, serviceFile(0, true))).toString());
      for (const index of [0, 1]) {
        const slot = plan.documents.findIndex(item => path.relative(path.join(root, serviceFile(index)), vscode.Uri.parse(item.uri).fsPath) === '');
        assert.ok(slot >= 0);
        const change = plan.documents[slot];
        assert.equal(change.serviceDescriptor, true);
        assert.equal(change.before, serviceText(index));
        assert.equal(change.after, serviceText(index, true));
        for (const side of ['before', 'after']) {
          const preview = await vscode.workspace.openTextDocument(
            vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + slot + '/' + side + '.txt'));
          assert.equal(preview.getText(), serviceText(index, side === 'after'));
        }
      }
    }

    const fileAfter = value => {
      if (value.newUri) return vscode.Uri.parse(value.newUri).fsPath;
      const name = vscode.Uri.parse(value.uri).fsPath;
      return inDirectory(old, name) ? path.join(next, path.relative(old, name)) : name;
    };
    async function ensureState(after) {
      await until(async () => (await exists(old)) === !after && (await exists(next)) === after, 10000);
      if (withServices) await until(async () => (await exists(path.join(root, serviceFile(0)))) === !after &&
        (await exists(path.join(root, serviceFile(0, true)))) === after, 10000);
      for (const value of plan.documents) {
        const observed = await open(after ? fileAfter(value) : vscode.Uri.parse(value.uri).fsPath);
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
      assert.equal(await (await open(fileAfter(value))).save(), true);
    }
    assert.equal(await fs.readFile(file(unrelated), 'utf8'), sources.get(javaLocation(unrelated, withServices)));
    const final = await run(true);
    assert.deepEqual(final, original);
    if (withBoot) {
      for (const [index, relative] of bootFiles.entries()) assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), bootText(index, true));
      checks.push('Spring Boot imports are exact, participate in native Undo and Redo, and still load the renamed bean factory.');
    }
    if (withServices) {
      for (const index of [0, 1]) assert.equal(await fs.readFile(path.join(root, serviceFile(index, true)), 'utf8'), serviceText(index, true));
      checks.push('ServiceLoader filename and provider edits undo and redo with the package and preserve descriptor bytes and discovery order.');
    }
    checks.push('JDT and Javac reviewed main/test callers and nested packages with one native directory rename and text edit.');
    checks.push('The directory and edits undo and redo together. Saved Java sources preserve the Spring bean and JDBC result.');
    return { ...plan.packageRename, nativeWorkspaceEdit: true, nativeDirectoryUndo: true, nativeDirectoryRedo: true,
      lateTargetRefused: true, spring: final, ...(withBoot && { bootDriftRefused: true, bootImportsUndoRedo: true }),
      ...(withServices && { serviceDriftRefused: true, serviceCollisionRefused: true, serviceUndoRedo: true }) };
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

const runJavaPackageBootImportsChecks = (api, vscode, checks) =>
  runJavaPackageRenameChecks(api, vscode, checks, { withBoot: true });
const runJavaPackageServiceRenameChecks = (api, vscode, checks) =>
  runJavaPackageRenameChecks(api, vscode, checks, { withBoot: true, withServices: true });

module.exports = { runJavaPackageRenameChecks, runJavaPackageBootImportsChecks, runJavaPackageServiceRenameChecks };
