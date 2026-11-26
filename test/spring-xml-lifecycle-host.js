'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bean, beanPath, markers, xml, inheritedXml, populateResourceLifecycle, runXmlLifecycle, assertXmlCallback, position, maven } =
  require('./helpers/spring-xml-lifecycle-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runSpringXmlLifecycleChecks(api, vscode, checks, { requireInheritance = false } = {}) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(workspace, 'rb-xml-lifecycle-'));
  const aux = await fs.mkdtemp(path.join(temp, 'rb-xml-probe-'));
  const projectUri = vscode.Uri.file(root).toString();
  let imported = false;
  try {
    const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
    const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
    assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
    const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
    await api.java.start();
    const tools = { javaHome: api.java.getState().javaHome,
      mavenHome: vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome') };
    assert.ok(tools.mavenHome, 'Use the configured independent Maven installation.');
    const resource = requireInheritance ? inheritedXml : xml;
    const fixture = await populateResourceLifecycle(root, aux, tools, { resource });
    await api.java.workbench.resyncProject({ projectUri, allowProjectExecution: true });
    imported = true;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, beanPath)));
    await vscode.window.showTextDocument(doc, { preview: false });
    await until(async () => {
      const snapshot = await api.java.executeWorkspaceCommand('java.project.getClasspaths', doc.uri.toString(), { scope: 'runtime' });
      return snapshot?.projectRoot && path.relative(root, vscode.Uri.parse(snapshot.projectRoot).fsPath) === '' &&
        snapshot.classpaths.some(file => path.relative(fixture.archive, file) === '');
    }, 90000);
    const built = await api.java.buildWorkspace();
    assert.ok(built === 0 || built === 1 || built?.status === 'succeed', 'JDT fixture build ' + JSON.stringify(built));
    const expected = requireInheritance ? '42:7:777' : '42:7:77';
    const before = await runXmlLifecycle(fixture, tools, database, spring.dbEngine, expected);
    const safe = api.java.safeDelete;
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.safeDelete'));
    const inspect = async name => (await safe.inspect(doc, position(doc, name))).springAnalysis;
    const checked = [
      assertXmlCallback(await inspect(markers.init), markers.init, 'init-method', resource),
      assertXmlCallback(await inspect(markers.destroy), markers.destroy, 'destroy-method', resource)
    ];
    if (requireInheritance) {
      checked.push(assertXmlCallback(await inspect(markers.inheritedDestroy), markers.inheritedDestroy, 'destroy-method', resource));
      assert.equal(checked[0].declaredOn, 'lifecycleBase');
      assert.equal(checked[1].templateOnly, true);
      assert.equal(checked[2].declaredOn, 'lifecycleChild');
    }
    await assert.rejects(safe.prepare(doc, position(doc, markers.init)), error => error.code === 'ROCKETBRAIN_SAFE_DELETE_CONFLICT' &&
      error.springAnalysis.conflicts.some(item => item.kind === 'spring.binary-xml-lifecycle'));
    assert.equal(doc.getText(), bean);

    const review = await safe.prepare(doc, position(doc, markers.helper));
    assert.equal(review.springAnalysis.binaryResourceLifecycle.state, 'inspected');
    assert.equal(review.springAnalysis.verdict, 'allowed');
    assert.equal((await safe.apply(review.id)).state, 'applied');
    assert.doesNotMatch(doc.getText(), /unreferencedLocalHelper/u);
    // Preserve the actual editor's Undo stack while verifying the saved product outcome.
    assert.equal(await doc.save(), true);
    await maven(tools, root, ['compile']);
    const after = await runXmlLifecycle(fixture, tools, database, spring.dbEngine, expected);
    assert.deepEqual(after, before);
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), bean);
    if (doc.isDirty) assert.equal(await doc.save(), true);
    checks.push('The installed Safe Delete protects exact Spring init and destroy methods from an imported dependency-JAR XML resource.');
    checks.push('The unrelated private helper supports native delete and Undo. Actual Spring callback state and JDBC readback match after the deletion.');
    return { checked, before, after, nativeApplyUndo: true, noProjectCodeDuringReview: true };
  } finally {
    try {
      const ownedTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const uri = tab.input?.uri;
        if (uri?.scheme !== 'file') return false;
        const relative = path.relative(root, uri.fsPath);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      });
      for (const tab of ownedTabs) {
        const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === tab.input.uri.toString());
        if (document?.isDirty) assert.equal(await document.save(), true);
      }
      if (ownedTabs.length) await vscode.window.tabGroups.close(ownedTabs);
      if (imported) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [folder, parent, prefix] of [[root, workspace, 'rb-xml-lifecycle-'], [aux, temp, 'rb-xml-probe-']]) {
        const real = await fs.realpath(folder);
        assert.equal(path.relative(real, folder), '');
        assert.equal(path.relative(path.dirname(real), parent), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runSpringXmlLifecycleChecks };
