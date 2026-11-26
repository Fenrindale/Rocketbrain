'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { positionOf, until } = require('./helpers/stdio-lsp');
const { target, fixtureSources, sourceFolder, populateConstructorDelete, runConstructorSpring } =
  require('./helpers/java-constructor-delete-fixture');

async function runJavaConstructorSafeDeleteChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_CONSTRUCTOR_DELETE_CLASSPATH ||
    path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const parent = await fs.realpath(os.tmpdir());
  const out = await fs.mkdtemp(path.join(parent, 'rb-native-ctor-build-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-native-ctor-delete-'));
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let projectUri;
  try {
    await populateConstructorDelete(root, classpathFile, spring.dbEngine);
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = stage => runConstructorSpring({
      root, work: path.join(out, stage), javaHome, classpathFile, engine: spring.dbEngine, database
    });
    const before = await run('before');
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',
      [vscode.Uri.file(path.join(root, '.project')).toString()], [], []);
    for (const unit of fixtureSources.keys()) await open(unit);
    const document = await open(target);
    projectUri = await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', document.uri.toString(), { scope: 'test' });
      return model?.projectRoot && !path.relative(root, vscode.Uri.parse(model.projectRoot).fsPath) &&
        model.classpaths.some(file => file.endsWith('spring-context-7.0.10.jar')) ? model.projectRoot : undefined;
    }, 100000);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const at = positionOf(document.getText(), 'discardedSlot', 2);
    const caret = new vscode.Position(at.line, at.character);
    editor.selection = new vscode.Selection(caret, caret);
    const plan = await api.java.safeDelete.prepare(document, caret);
    assert.equal(plan.safeDelete.kind, 'constructor-parameter');
    assert.equal(plan.safeDelete.updatedConstructorCallers, 2);
    const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
    assert.equal(preview.getText().replace(/\r\n/gu, '\n'), plan.documents[0].after.replace(/\r\n/gu, '\n'));
    const injection = await open(path.join(sourceFolder, 'ImplicitCounter.java'));
    const injectionPoint = positionOf(injection.getText(), 'implicitInjectionSlot', 3);
    await assert.rejects(api.java.safeDelete.prepare(injection, injectionPoint), /class literal can register/u);

    assert.equal((await api.java.safeDelete.apply(plan.id)).state, 'applied');
    assert.equal(document.getText(), plan.documents[0].after);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), plan.documents[0].before);
    await vscode.commands.executeCommand('redo');
    assert.equal(document.getText(), plan.documents[0].after);
    assert.equal(await document.save(), true);
    const after = await run('after');
    assert.deepEqual(after, before);
    checks.push('Safe Delete previews and applies an unused private constructor parameter and both exact direct calls in one native edit. Native Undo and Redo restore the complete edit.');
    checks.push('Constructor parameters used by Spring injection remain protected. The rebuilt project preserves Spring constructor injection, JDBC results, and evaluation order of the retained arguments.');
    return { ...plan.safeDelete, reviewDocument: true, nativeUndo: true, nativeRedo: true,
      implicitConstructorInjectionRefused: true, before, after };
  } finally {
    try {
      for (const document of vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && inside(doc.uri.fsPath))) {
        if (!document.isDirty) continue;
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [folder, boundary, prefix] of [[root, workspace, 'rb-native-ctor-delete-'], [out, parent, 'rb-native-ctor-build-']]) {
        const real = await fs.realpath(folder);
        assert.equal(path.relative(boundary, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaConstructorSafeDeleteChecks };
