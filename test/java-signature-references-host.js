'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { springJdbcClasspath } = require('./helpers/instance-inline-fixture');
const { sources, targetPath, negativeTargets, operations, selection, nextParameters, assertPlan,
  populateSignatureReferences, runSignatureSpring } = require('./helpers/java-signature-references-fixture');

async function runJavaSignatureReferenceChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_REF_CLASSPATH || path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const parent = await fs.realpath(os.tmpdir());
  const outputs = await fs.mkdtemp(path.join(parent, 'rb-signature-ref-classes-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-signature-references-'));
  const open = relative => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, relative)));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let projectUri;
  try {
    await populateSignatureReferences(root, await springJdbcClasspath(classpathFile, spring.dbEngine));
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const run = async () => runSignatureSpring({ javaHome, root, database, engine: spring.dbEngine, classpathFile,
      classes: await fs.mkdtemp(path.join(outputs, 'classes-')) });
    const baseline = await run();
    const descriptor = vscode.Uri.file(path.join(root, '.project')).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []).catch(() => {});
    for (const file of sources.keys()) await open(file);
    const declaration = await open(targetPath);
    await vscode.window.showTextDocument(declaration, { preview: false });
    projectUri = await until(async () => {
      const cp = await api.java.executeWorkspaceCommand('java.project.getClasspaths', declaration.uri.toString(), { scope: 'test' });
      return cp?.projectRoot && path.relative(root, vscode.Uri.parse(cp.projectRoot).fsPath) === '' &&
        cp.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? cp.projectRoot : undefined;
    }, 100000);

    async function inspect(marker) {
      const doc = await open(targetPath);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
      const { start, end } = selection(doc.getText(), marker);
      return api.java.changeSignature.info(doc, new vscode.Range(start.line, start.character, end.line, end.character));
    }
    async function validate(plan, phase, save = false) {
      for (const entry of plan.documents) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
        assert.equal(doc.getText(), entry[phase]);
        if (save) assert.equal(await doc.save(), true);
      }
    }
    const completed = [];
    for (const operation of operations) {
      const info = await inspect(operation.marker);
      assert.equal(info.adaptableMethodReferences, operation.refs);
      const plan = await api.java.changeSignature.preview(info.id, { parameters: nextParameters(info, operation.operation) });
      const details = assertPlan(plan, operation);
      assert.deepEqual(plan.resourceOperations, []);
      if (!completed.length) {
        const after = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
        assert.equal(after.getText().replace(/\r\n/gu, '\n'), plan.documents[0].after.replace(/\r\n/gu, '\n'));
      }
      assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
      await validate(plan, 'after');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand('undo');
      await validate(plan, 'before');
      await vscode.commands.executeCommand('redo');
      await validate(plan, 'after', true);
      assert.deepEqual(await run(), baseline);
      completed.push(details);
    }
    for (const [marker] of negativeTargets) {
      await assert.rejects(inspect(marker), /Method or constructor references need additional signature adaptation analysis/u);
    }
    checks.push('Reviewed Change Signature adapts static, constructor, unbound, this-bound and exact private generic references with the same functional interface and callable target.');
    checks.push('Native Undo and Redo cover each signature and its adapters together. Saved sources preserve the Spring JDBC result.');
    checks.push('Mutable or effectful bound receivers, a boxed SAM input and unproved private generic substitutions require a separate review.');
    return { completed, nativeUndo: true, nativeRedo: true, refused: negativeTargets.map(([, label]) => label), spring: baseline };
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
      for (const [directory, base, prefix] of [[root, workspace, 'rb-signature-references-'],
        [outputs, parent, 'rb-signature-ref-classes-']]) {
        const actual = await fs.realpath(directory);
        assert.equal(path.relative(base, path.dirname(actual)), '');
        assert.ok(path.basename(actual).startsWith(prefix));
        await fs.rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      }
    }
  }
}

module.exports = { runJavaSignatureReferenceChecks };
