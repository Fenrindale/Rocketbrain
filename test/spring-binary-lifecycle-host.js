'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { beanPath, markers, bean, maven, populateBinaryLifecycle, runBinaryLifecycle, position, exactConflict } =
  require('./helpers/spring-binary-lifecycle-fixture');

async function runSpringBinaryLifecycleChecks(api, vscode, checks) {
  const boundary = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(boundary, 'rb-binary-lifecycle-'));
  const auxiliary = await fs.mkdtemp(path.join(temp, 'rb-lifecycle-probe-'));
  const projectUri = vscode.Uri.file(root).toString();
  const open = value => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, value)));
  let imported = false;
  try {
    const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
    const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
    assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
    const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
    await api.java.start();
    const tools = { javaHome: api.java.getState().javaHome,
      mavenHome: vscode.workspace.getConfiguration('rocketbrain.java').get('mavenHome') };
    assert.ok(tools.mavenHome, 'Use the configured independent Maven installation.');
    const fixture = await populateBinaryLifecycle(root, auxiliary, tools);
    await api.java.workbench.resyncProject({ projectUri, allowProjectExecution: true });
    imported = true;
    const doc = await open(beanPath), safe = api.java.safeDelete;
    await vscode.window.showTextDocument(doc);
    const before = await runBinaryLifecycle(fixture, tools, database, spring.dbEngine);
    const inspected = [];
    for (const [marker, reason] of [[markers.default, 'binary-alias-default'], [markers.explicit, 'source-alias'],
      [markers.shutdown, 'binary-meta']]) {
      const report = (await safe.inspect(doc, position(doc, marker))).springAnalysis;
      inspected.push(exactConflict(report, marker, reason));
    }
    await assert.rejects(safe.prepare(doc, position(doc, markers.default)), error => error.code === 'ROCKETBRAIN_SAFE_DELETE_CONFLICT');
    assert.equal(doc.getText(), bean);
    const review = await safe.prepare(doc, position(doc, markers.unused));
    assert.equal(review.springAnalysis.binaryLifecycle.state, 'inspected');
    assert.equal((await safe.apply(review.id)).state, 'applied');
    assert.doesNotMatch(doc.getText(), /unreferencedHelper/u);
    assert.equal(await doc.save(), true);
    await maven(tools, root, ['compile']);
    const after = await runBinaryLifecycle(fixture, tools, database, spring.dbEngine);
    assert.deepEqual(after, before);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), bean);
    if (doc.isDirty) assert.equal(await doc.save(), true);
    checks.push('Installed Safe Delete protects three private lifecycle methods from exact compiled Spring Bean alias and meta-annotation evidence.');
    checks.push('An unreferenced helper still supports native apply and Undo. Actual Spring lifecycle and JDBC readback are unchanged after compilation.');
    return { inspected, before, after, nativeApplyUndo: true, processorsInvokedDuringReview: false };
  } finally {
    try {
      const ownedTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const uri = tab.input?.uri;
        if (uri?.scheme !== 'file') return false;
        const relative = path.relative(root, uri.fsPath);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      });
      if (ownedTabs.length) {
        for (const tab of ownedTabs) {
          const doc = vscode.workspace.textDocuments.find(value => value.uri.toString() === tab.input.uri.toString());
          if (doc?.isDirty) assert.equal(await doc.save(), true);
        }
        await vscode.window.tabGroups.close(ownedTabs);
      }
      if (imported) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [folder, parent, prefix] of [[root, boundary, 'rb-binary-lifecycle-'], [auxiliary, temp, 'rb-lifecycle-probe-']]) {
        const real = await fs.realpath(folder);
        assert.equal(path.relative(parent, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runSpringBinaryLifecycleChecks };
