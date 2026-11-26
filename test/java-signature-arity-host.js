'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { sources, targetPath, marker, selection, primitiveFacts, instanceFacts, rejected,
  populateArity, runAritySpring, assertArityPlan } = require('./helpers/java-signature-arity-fixture');

async function runJavaSignatureArityChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_VARARGS_CLASSPATH ||
    path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const temp = await fs.realpath(os.tmpdir());
  const outputs = await fs.mkdtemp(path.join(temp, 'rb-arity-classes-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-signature-arity-'));
  const open = relative => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, relative)));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let projectUri;
  try {
    await populateArity(root, classpathFile, spring.dbEngine);
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = async () => runAritySpring({ javaHome, root, database, engine: spring.dbEngine, classpathFile,
      classes: await fs.mkdtemp(path.join(outputs, 'classes-')) });
    const before = await run();
    const descriptor = vscode.Uri.file(path.join(root, '.project')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []).catch(() => {});
    for (const source of sources.keys()) await open(source);
    const declaration = await open(targetPath);
    await vscode.window.showTextDocument(declaration, { preview: false });
    projectUri = await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', declaration.uri.toString(), { scope: 'test' });
      return model?.projectRoot && path.relative(root, vscode.Uri.parse(model.projectRoot).fsPath) === '' &&
        model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? model.projectRoot : undefined;
    }, 100000);
    // Wait for JDT's class output to settle before the compiler snapshots it.
    const build = () => api.java.buildWorkspace();
    await build();
    const signature = api.java.changeSignature;
    const inspect = value => {
      const { start, end } = selection(declaration.getText(), value);
      return signature.info(declaration, new vscode.Range(start.line, start.character, end.line, end.character));
    };
    for (const [value, reason] of rejected) await assert.rejects(inspect(value), reason);
    const collision = await inspect('collision(Object');
    await assert.rejects(signature.preview(collision.id, { arity: 'array' }), /overload resolution or an unrelated caller binding/u);
    const info = await inspect(marker);
    const plan = await signature.preview(info.id, { arity: 'array' });
    assertArityPlan(info, plan);
    const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
    assert.equal(preview.getText().replace(/\r\n/gu, '\n'), plan.documents[0].after.replace(/\r\n/gu, '\n'));
    await vscode.window.showTextDocument(declaration, { preview: false });
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    assert.equal(declaration.getText(), plan.documents[0].after);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    assert.equal(declaration.getText(), plan.documents[0].before);
    await vscode.commands.executeCommand('redo');
    assert.equal(declaration.getText(), plan.documents[0].after);
    assert.equal(await declaration.save(), true);
    await build();
    const primitive = await inspect('sum(int');
    const primitivePlan = await signature.preview(primitive.id, { arity: 'array' });
    assertArityPlan(primitive, primitivePlan, primitiveFacts);
    assert.equal((await api.java.refactoring.apply(primitivePlan.id)).state, 'applied');
    assert.equal(await declaration.save(), true);
    await build();
    const instance = await inspect('collect(String');
    const instancePlan = await signature.preview(instance.id, { arity: 'array' });
    assertArityPlan(instance, instancePlan, instanceFacts);
    assert.equal((await api.java.refactoring.apply(instancePlan.id)).state, 'applied');
    assert.equal(await declaration.save(), true);
    const after = await run();
    assert.deepEqual(after, before);
    checks.push('Change Signature converted private object and primitive varargs to arrays while retaining fixed-array references and adapting typed spread references.');
    checks.push('Native Undo and Redo covered the reviewed declaration, direct callers and method references. Real Spring JDBC confirmed argument order, array identity and fresh spread arrays.');
    return { referenceArray: plan.signature.arityConversion, primitiveArray: primitivePlan.signature.arityConversion,
      instanceArray: instancePlan.signature.arityConversion,
      changedOverloadRefused: true, refusedUnsupportedCalls: rejected.length, nativeApplyUndoRedo: true, before, after };
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
      for (const [dir, parent, prefix] of [[root, workspace, 'rb-signature-arity-'], [outputs, temp, 'rb-arity-classes-']]) {
        const real = await fs.realpath(dir);
        assert.equal(path.relative(parent, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaSignatureArityChecks };
