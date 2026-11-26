'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { declaration, caller, chosen, selected, sources, selection, createParameterReactor,
  buildParameterReactor, runParameterSpring, assertParameterPlan } = require('./helpers/java-parameter-rename-fixture');

async function runJavaParameterRenameChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_PARAMETER_RENAME_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const root = await fs.mkdtemp(path.join(workspace, 'rb-java-parameter-'));
  const docs = new Map();
  const inside = file => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  try {
    await api.java.start();
    const tools = { javaHome: api.java.getState().javaHome, mavenHome: vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome') };
    const app = await createParameterReactor(root);
    const run = () => runParameterSpring({ javaHome: tools.javaHome, root, database, engine: spring.dbEngine, classpathFile });
    await buildParameterReactor(root, tools);
    const before = await run();
    const descriptor = vscode.Uri.file(path.join(root, 'pom.xml')).toString();
    const address = vscode.Uri.file(path.join(app, declaration));
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []);
    await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', address.toString(), { scope: 'test' });
      return model?.projectRoot && !path.relative(app, vscode.Uri.parse(model.projectRoot).fsPath) &&
        model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar'));
    }, 120000);
    for (const name of sources.keys()) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(app, name)));
      docs.set(name, doc);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    const target = docs.get(declaration);
    const show = () => vscode.window.showTextDocument(target, { preview: false });
    await show();
    const at = selection(target.getText(), chosen);
    const change = api.java.changeSignature;
    const info = await change.info(target, new vscode.Range(at.start.line, at.start.character, at.end.line, at.end.character));
    await assert.rejects(change.preview(info.id, { renameParameter: { ...selected, name: 'existing' } }), /conflicts/u);
    const plan = await change.preview(info.id, { renameParameter: selected });
    assertParameterPlan(info, plan);
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
    assert.equal(diff.getText().replace(/\r\n/gu, '\n'), plan.documents[0].after.replace(/\r\n/gu, '\n'));
    const documents = await Promise.all(plan.documents.map(async entry => ({
      ...entry, document: await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri))
    })));
    const current = phase => documents.every(entry => entry.document.getText() === entry[phase]);
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    assert.ok(current('after'));
    await show();
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(() => current('before'), 15000);
    await vscode.commands.executeCommand('redo');
    await until(() => current('after'), 15000);
    for (const entry of documents) assert.equal(await entry.document.save(), true);
    assert.equal(await fs.readFile(path.join(app, caller), 'utf8'), sources.get(caller));
    await buildParameterReactor(root, tools);
    const after = await run();
    assert.deepEqual(after, before);
    checks.push('Change Signature renames a parameter across the interface and two overrides with exact Javac body and Javadoc bindings.');
    checks.push('Caller bytes and the sibling overload stay identical. The native operation supports Undo and Redo and the Maven reactor rebuild preserves the Spring JDBC result.');
    return { family: plan.signature.parameterRename, preservedDirectFamilyCalls: plan.signature.resolvedReferences,
      overloadedSiblingUnchanged: true, callerBytesUnchanged: true, nativeApplyUndoRedo: true, actualMavenReactor: true, before, after };
  } finally {
    try {
      for (const doc of docs.values()) if (doc.isDirty) {
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      const list = await api.java.executeWorkspaceCommand('java.project.getAll').catch(() => []);
      const imported = list.filter(value => {
        try { return inside(vscode.Uri.parse(value).fsPath); } catch { return false; }
      });
      if (imported.length) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], imported).catch(() => {});
    } finally {
      const real = await fs.realpath(root);
      assert.equal(path.relative(workspace, path.dirname(real)), '');
      assert.match(path.basename(real), /^rb-java-parameter-/u);
      await fs.rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }
}

module.exports = { runJavaParameterRenameChecks };
