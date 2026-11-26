'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { sources, targetPath, marker, negativeTargets, parameters, selection, populateVarargs,
  runVarargsSpring, assertVarargsPlan } = require('./helpers/java-signature-varargs-fixture');

async function runJavaSignatureVarargsChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_VARARGS_CLASSPATH ||
    path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const temp = await fs.realpath(os.tmpdir());
  const outputs = await fs.mkdtemp(path.join(temp, 'rb-varargs-classes-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-signature-varargs-'));
  const open = relative => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, relative)));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let projectUri;
  try {
    await populateVarargs(root, classpathFile, spring.dbEngine);
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = async () => runVarargsSpring({ javaHome, root, database, engine: spring.dbEngine, classpathFile,
      classes: await fs.mkdtemp(path.join(outputs, 'classes-')) });
    const before = await run();
    const descriptor = vscode.Uri.file(path.join(root, '.project')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []).catch(() => {});
    for (const file of sources.keys()) await open(file);
    const declaration = await open(targetPath);
    await vscode.window.showTextDocument(declaration, { preview: false });
    projectUri = await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', declaration.uri.toString(), { scope: 'test' });
      return model?.projectRoot && path.relative(root, vscode.Uri.parse(model.projectRoot).fsPath) === '' &&
        model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? model.projectRoot : undefined;
    }, 100000);
    const signature = api.java.changeSignature;
    const inspect = value => {
      const { start, end } = selection(declaration.getText(), value);
      return signature.info(declaration, new vscode.Range(start.line, start.character, end.line, end.character));
    };
    for (const [value, reason] of negativeTargets) await assert.rejects(inspect(value), reason);
    const info = await inspect(marker);
    await assert.rejects(signature.preview(info.id, { parameters: [...info.parameters].reverse() }), /keep the original varargs parameter last/u);
    const plan = await signature.preview(info.id, { parameters: parameters(info) });
    assertVarargsPlan(info, plan);
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
    assert.equal(diff.getText().replace(/\r\n/gu, '\n'), plan.documents[0].after.replace(/\r\n/gu, '\n'));
    const compare = async (phase, save = false) => {
      for (const entry of plan.documents) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
        assert.equal(document.getText(), entry[phase]);
        if (save) assert.equal(await document.save(), true);
      }
    };
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await compare('after');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await compare('before');
    await vscode.commands.executeCommand('redo');
    await compare('after', true);
    const after = await run();
    assert.deepEqual(after, before);
    checks.push('Change Signature reorders fixed parameters across eight attributed calls while keeping five fixed-array and three spread invocations.');
    checks.push('Native Undo and Redo include the declaration and direct callers. A real Spring JDBC build produces the same result and tail evaluation order.');
    return { invocationModes: plan.signature.varargs, verifiedCalls: plan.signature.resolvedReferences, before, after,
      nativeApplyUndoRedo: true, refusedUnsafeCallers: negativeTargets.length };
  } finally {
    try {
      for (const document of vscode.workspace.textDocuments.filter(value => value.uri.scheme === 'file' && inside(value.uri.fsPath))) {
        if (!document.isDirty) continue;
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [dir, parent, prefix] of [[root, workspace, 'rb-signature-varargs-'], [outputs, temp, 'rb-varargs-classes-']]) {
        const real = await fs.realpath(dir);
        assert.equal(path.relative(parent, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaSignatureVarargsChecks };
