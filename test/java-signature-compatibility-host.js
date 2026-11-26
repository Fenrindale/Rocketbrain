'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { selection } = require('./helpers/java-signature-references-fixture');
const { owner, caller, sources, marker, change, legacyDescriptor, expandedDescriptor, populateCompatibility,
  compileCompatibility, compileLegacyClient, checkLegacyClient, runCompatibilitySpring, assertCompatibilityPlan } =
  require('./helpers/java-signature-compatibility-fixture');

async function runJavaSignatureCompatibilityChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const fixtureOwner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(fixtureOwner.kind));
  const database = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_COMPAT_CLASSPATH ||
    path.join(spring.projectPath, 'build/runtime-classpath.txt');
  const temporary = await fs.realpath(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(temporary, 'rb-native-compat-build-'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-native-compat-project-'));
  const open = unit => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, unit)));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let projectUri;
  try {
    await populateCompatibility(root, classpathFile, spring.dbEngine);
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const compile = stage => compileCompatibility({ javaHome, root, scratch: path.join(scratch, stage) });
    const jdbc = (stage, artifact) => runCompatibilitySpring({ javaHome, archive: artifact.archive,
      scratch: path.join(scratch, stage), classpathFile, database, engine: spring.dbEngine });
    const original = await compile('original');
    assert.equal(original.oldCallerSites, 2);
    assert.equal(original.newCallerSites, 0);
    const binary = await compileLegacyClient(javaHome, original.archive, path.join(scratch, 'precompiled'));
    const beforeClient = await checkLegacyClient(javaHome, original.archive, binary);
    const before = await jdbc('db-before', original);

    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',
      [vscode.Uri.file(path.join(root, '.project')).toString()], [], []);
    for (const unit of sources.keys()) await open(unit);
    const declaration = await open(owner), consumer = await open(caller);
    await vscode.window.showTextDocument(declaration, { preview: false });
    projectUri = await until(async () => {
      const model = await api.java.executeWorkspaceCommand('java.project.getClasspaths', declaration.uri.toString(), { scope: 'test' });
      return model?.projectRoot && !path.relative(root, vscode.Uri.parse(model.projectRoot).fsPath) &&
        model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? model.projectRoot : undefined;
    }, 100000);
    await api.java.buildWorkspace();
    const signature = api.java.changeSignature;
    const range = selection(declaration.getText(), marker);
    const inspected = await signature.info(declaration,
      new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character));
    const plan = await signature.preview(inspected.id, { compatibility: change });
    assertCompatibilityPlan(inspected, plan);
    for (const [index, item] of plan.documents.entries()) {
      const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + index + '/after.java'));
      assert.equal(preview.getText().replace(/\r\n/gu, '\n'), item.after.replace(/\r\n/gu, '\n'));
    }
    const editedDocs = [declaration, consumer];
    async function compare(key) {
      await until(() => editedDocs.every(doc => doc.getText() ===
        plan.documents.find(item => !path.relative(doc.uri.fsPath, vscode.Uri.parse(item.uri).fsPath))?.[key]), 9000);
    }
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await compare('after');
    await vscode.window.showTextDocument(declaration, { preview: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await compare('before');
    await vscode.commands.executeCommand('redo');
    await compare('after');
    for (const doc of editedDocs) assert.equal(await doc.save(), true);
    const rebuilt = await compile('rebuilt');
    assert.ok(rebuilt.descriptors.includes(legacyDescriptor) && rebuilt.descriptors.includes(expandedDescriptor));
    assert.equal(rebuilt.oldCallerSites, 0);
    assert.equal(rebuilt.newCallerSites, 2);
    assert.deepEqual(await checkLegacyClient(javaHome, rebuilt.archive, binary), beforeClient);
    const after = await jdbc('db-after', rebuilt);
    assert.deepEqual(after, before);
    checks.push('Change Signature previews the forwarding overload and exact callers. One native Undo and Redo restores or replays both changed files.');
    checks.push('The unchanged precompiled client invokes the retained descriptor. Rebuilt workspace callers use the expanded descriptor and the actual Spring JDBC result is unchanged.');
    return { ...plan.signature.compatibility, nativeUndo: true, nativeRedo: true, precompiledClient: beforeClient, before, after };
  } finally {
    try {
      for (const doc of vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && inside(doc.uri.fsPath))) {
        if (!doc.isDirty) continue;
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      for (const [folder, boundary, prefix] of [[root, workspace, 'rb-native-compat-project-'], [scratch, temporary, 'rb-native-compat-build-']]) {
        const real = await fs.realpath(folder);
        assert.equal(path.relative(boundary, path.dirname(real)), '');
        assert.ok(path.basename(real).startsWith(prefix));
        await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      }
    }
  }
}

module.exports = { runJavaSignatureCompatibilityChecks };
