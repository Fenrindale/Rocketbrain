'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {until} = require('./helpers/stdio-lsp');
const F = require('./helpers/java-jpms-service-package-move-fixture');

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const exists = file => fs.access(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function runServicePackageMoveChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const parent = await fs.realpath(os.tmpdir());
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const repository = await fs.realpath(process.env.ROCKETBRAIN_SERVICE_MOVE_MAVEN_REPOSITORY);
  const mavenHome = await fs.realpath(process.env.ROCKETBRAIN_SERVICE_MOVE_MAVEN_HOME ||
    vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-jpms-services-'));
  const scratch = await fs.mkdtemp(path.join(parent, 'rb-jpms-services-native-'));
  const identities = await Promise.all([root, scratch].map(file => fs.lstat(file, {bigint: true})));
  const owner = path.join(root, F.selected), destination = path.join(root, F.destination);
  const imported = F.modules.map(([name]) => vscode.Uri.file(path.join(root, name)).toString());
  const prepare = () => api.java.move.preparePackage(vscode.Uri.file(path.join(root, F.sourceFolder)),
    vscode.Uri.file(path.join(root, F.targetFolder)));
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const show = async file => vscode.window.showTextDocument(await open(file), {preview: false, preserveFocus: false});
  let plan, requestedImport = false;
  try {
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    await F.populate(root);
    await F.runMaven(root, javaHome, mavenHome, repository);
    const run = async moved => ({jvm: await F.runModule(root, javaHome, moved),
      spring: await F.runSpring({root, work: await fs.mkdtemp(path.join(scratch, 'spring-')),
        javaHome, cpFile, configFile: spring.dbConfigPath, engine: spring.dbEngine})});
    const before = await run(false);
    const poms = [vscode.Uri.file(path.join(root, 'pom.xml')).toString()];
    requestedImport = true;
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', poms, [], []);
    await until(async () => {
      const observations = await Promise.all(F.modules.map(([name]) =>
        api.java.executeWorkspaceCommand('java.project.getClasspaths', vscode.Uri.file(path.join(root, name)).toString(), {scope: 'test'})));
      return observations.every((cp, index) => cp?.modulepaths?.length === (index === 0 ? 1 : 2) &&
        cp.modulepaths.some(file => path.relative(F.outputPaths(root)[index], file) === ''));
    }, 100000);
    await show(owner);
    plan = await prepare();
    assert.equal(plan.move.moduleServices.owner, F.apiModule);
    assert.deepEqual(plan.move.moduleServices.providers.map(item => item.module), [F.leftModule, F.rightModule]);
    assert.deepEqual(plan.move.moduleServices.consumers, [F.consumerModule]);
    assert.equal(plan.move.moduleServices.checkedCalls, 1);
    assert.equal(plan.resourceOperations.length, 1);
    assert.equal(plan.documents.filter(item => vscode.Uri.parse(item.uri).fsPath.endsWith('module-info.java')).length, 4);
    const descriptorIndex = plan.documents.findIndex(item => vscode.Uri.parse(item.uri).fsPath.endsWith('module-info.java'));
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse(
      'rocketbrain-java-refactor:/' + plan.id + '/' + descriptorIndex + '/after.java'));
    const newlines = text => text.replaceAll('\r\n', '\n');
    assert.equal(newlines(diff.getText()), newlines(plan.documents[descriptorIndex].after));

    const changedFile = plan.documents.find(item => vscode.Uri.parse(item.uri).fsPath.includes(path.sep + 'client' + path.sep) &&
      vscode.Uri.parse(item.uri).fsPath.endsWith('Probe.java'));
    assert.ok(changedFile);
    const editorFile = vscode.Uri.parse(changedFile.uri).fsPath;
    const destinationFor = (source, moved) => path.relative(owner, source) === '' && moved ? destination : source;
    async function verify(moved) {
      await until(async () => await exists(owner) === !moved && await exists(destination) === moved, 10000);
      for (const item of plan.documents) {
        const file = destinationFor(vscode.Uri.parse(item.uri).fsPath, moved);
        const document = await open(file);
        assert.equal(newlines(document.getText()), newlines(moved ? item.after : item.before));
      }
    }

    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await verify(true);
    for (const [command, moved] of [['undo', false], ['redo', true]]) {
      await show(editorFile);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand(command);
      await verify(moved);
    }
    for (const item of plan.documents) assert.equal(await (await open(destinationFor(vscode.Uri.parse(item.uri).fsPath, true))).save(), true);
    await F.runMaven(root, javaHome, mavenHome, repository, {rebuild: true});
    const after = await run(true);
    assert.deepEqual(before, after);
    checks.push('Installed Java Package Move reviewed both named providers, consumer and exported service package with one Undo and Redo.');
    checks.push('Both provider instances returned their original values after rebuilding the Maven reactor, and the Spring JDBC control agreed.');
    return {moduleServices: plan.move.moduleServices, ...after, preview: true, nativeUndo: true, nativeRedo: true};
  } finally {
    try {
      const documents = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && inside(root, doc.uri.fsPath));
      for (const document of documents.filter(doc => doc.isDirty)) {
        await vscode.window.showTextDocument(document, {preview: false});
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const target = tab.input?.uri;
        return target?.scheme === 'file' && inside(root, target.fsPath) ||
          plan && target?.scheme === 'rocketbrain-java-refactor' && target.path.startsWith('/' + plan.id + '/');
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (requestedImport) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [],
        [...imported, vscode.Uri.file(root).toString()]);
    } finally {
      for (const [index, folder, boundary] of [[0, root, workspace], [1, scratch, parent]]) {
        const real = await fs.realpath(folder), stat = await fs.lstat(real, {bigint: true});
        assert.equal(path.relative(boundary, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith('rb-jpms-services-'));
        assert.deepEqual([stat.dev, stat.ino], [identities[index].dev, identities[index].ino]);
        await fs.rm(real, {recursive: true, force: false, maxRetries: 8, retryDelay: 250});
      }
    }
  }
}

module.exports = {runServicePackageMoveChecks};
