'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { moduleName, sourceFolder, targetFolder, owner, descriptor, client, fixtureSources, populate,
  compileModule, runSpring } = require('./helpers/java-jpms-package-rename-fixture');

async function runJavaJpmsPackageRenameChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const ownership = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(ownership.kind));
  const data = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const parent = await fs.realpath(os.tmpdir());
  const compile = await fs.mkdtemp(path.join(parent, 'rb-jpms-native-build-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-jpms-native-rename-'));
  const old = path.join(root, sourceFolder), next = path.join(root, targetFolder);
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const show = async file => vscode.window.showTextDocument(await open(file), { preview: false, preserveFocus: false });
  const exists = file => fs.stat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  function inside(directory, file) {
    const relative = path.relative(directory, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  let projectUri, plan;
  try {
    await populate(root);
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const installed = path.join(root, 'bin/main');
    const originalModule = await compileModule(root, installed, javaHome);
    async function readDatabase(classes, renamed) {
      return runSpring({ root: await fs.mkdtemp(path.join(compile, 'spring-')), classes, javaHome, cpFile, data,
        engine: spring.dbEngine, renamed });
    }
    const originalSpring = await readDatabase(installed, false);
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [
      vscode.Uri.file(path.join(root, '.project')).toString()
    ], [], []);
    const document = (await show(path.join(root, owner))).document;
    for (const file of fixtureSources.keys()) await open(path.join(root, file));
    projectUri = await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', document.uri.toString(), { scope: 'test' });
      return model?.projectRoot && path.relative(root, vscode.Uri.parse(model.projectRoot).fsPath) === '' &&
        model.modulepaths?.some(file => path.relative(installed, file) === '') ? model.projectRoot : undefined;
    }, 100000);
    plan = await api.java.move.prepareRenamePackage(document, 'settlement');
    assert.equal(plan.packageRename.namedModule.name, moduleName);
    assert.equal(plan.packageRename.namedModule.directiveNamesChanged, 5);
    assert.equal(plan.packageRename.engineModuleDirectives, 5);
    assert.equal(plan.resourceOperations.length, 1);
    const index = plan.documents.findIndex(file => path.relative(path.join(root, descriptor), vscode.Uri.parse(file.uri).fsPath) === '');
    assert.ok(index >= 0);
    for (const side of ['before', 'after']) {
      const preview = await vscode.workspace.openTextDocument(
        vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + index + '/' + side + '.java'));
      assert.equal(preview.getText().replaceAll('\r\n', '\n'), plan.documents[index][side].replaceAll('\r\n', '\n'));
    }
    const destination = file => {
      const name = vscode.Uri.parse(file.uri).fsPath;
      return inside(old, name) ? path.join(next, path.relative(old, name)) : name;
    };
    async function verify(after) {
      await until(async () => await exists(old) === !after && await exists(next) === after, 10000);
      for (const file of plan.documents) {
        assert.equal((await open(after ? destination(file) : vscode.Uri.parse(file.uri).fsPath)).getText(),
          after ? file.after : file.before);
      }
    }
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await verify(true);
    for (const [command, after] of [['undo', false], ['redo', true]]) {
      await show(path.join(root, client));
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand(command);
      await verify(after);
    }
    for (const file of plan.documents) assert.equal(await (await open(destination(file))).save(), true);
    const classes = await fs.mkdtemp(path.join(compile, 'classes-'));
    assert.deepEqual(await compileModule(root, classes, javaHome, true), originalModule);
    const after = await readDatabase(classes, true);
    assert.deepEqual(after, originalSpring);
    checks.push('Package Rename updates exact JPMS exports, opens, uses and providers. One native Undo and Redo covers the module descriptor and Java directory.');
    checks.push('The rebuilt named module loads its ordered factory/direct providers and an external Spring JDBC client reaches its exported API and open package.');
    return { ...plan.packageRename, nativeUndo: true, nativeRedo: true, descriptorPreview: true,
      module: originalModule, spring: after };
  } finally {
    try {
      for (const document of vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && inside(root, doc.uri.fsPath))) {
        if (!document.isDirty) continue;
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const address = tab.input?.uri;
        return address?.scheme === 'file' && inside(root, address.fsPath) ||
          plan && address?.scheme === 'rocketbrain-java-refactor' && address.path.startsWith('/' + plan.id + '/');
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [folder, boundary, prefix] of [[root, workspace, 'rb-jpms-native-rename-'], [compile, parent, 'rb-jpms-native-build-']]) {
        const physical = await fs.realpath(folder);
        assert.equal(path.relative(boundary, path.dirname(physical)), '');
        assert.ok(path.basename(physical).startsWith(prefix));
        await fs.rm(physical, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaJpmsPackageRenameChecks };
