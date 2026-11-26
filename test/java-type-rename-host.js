'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { typeRenameFixture, springTypeRenameClasspath, runSpringTypeRename } = require('./helpers/java-type-rename-fixture');

async function runJavaTypeRenameChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const classpath = await springTypeRenameClasspath(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), runtime.dbEngine);
  const fixture = typeRenameFixture('fixture.boot', 'RbRename' + randomBytes(5).toString('hex'));
  const java = path.join(workspace, 'src/main/java/fixture/boot');
  const nested = path.join(java, fixture.callerPackage.split('.').at(-1));
  const old = path.join(java, fixture.oldName + '.java');
  const next = path.join(java, fixture.newName + '.java');
  const caller = path.join(nested, fixture.caller + '.java');
  const extra = path.join(java, fixture.additional + '.java');
  const xml = path.join(workspace, 'src/main/resources', fixture.xmlFileName);
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-native-type-rename-'));
  const created = new Set();
  let ownNested = false;
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const exists = file => fs.stat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  async function run(files) {
    return runSpringTypeRename({ javaHome: project.jdk || api.java.getState().javaHome, classpath, config,
      engine: runtime.dbEngine, className: fixture.callerPackage + '.' + fixture.caller, files, xmlFile: xml,
      classes: await fs.mkdtemp(path.join(owned, 'classes-')) });
  }
  async function confirmContents(plan, after) {
    assert.equal(await exists(old), !after);
    assert.equal(await exists(next), after);
    for (const file of plan.documents) {
      const uri = vscode.Uri.parse(after && file.newUri ? file.newUri : file.uri);
      assert.equal((await vscode.workspace.openTextDocument(uri)).getText(), after ? file.after : file.before);
    }
  }
  try {
    await fs.mkdir(nested);
    ownNested = true;
    for (const [file, text] of [[old, fixture.ownerText], [caller, fixture.callerText], [extra, fixture.extraText], [xml, fixture.xml]]) {
      await fs.writeFile(file, text, { flag: 'wx' });
      created.add(file);
    }
    const beforeRuntime = await run([old, caller, extra]);
    assert.equal(beforeRuntime.output, fixture.expected);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.reviewTypeRename'));
    const document = await open(old), callerDocument = await open(caller), xmlDocument = await open(xml);
    for (const value of [callerDocument, xmlDocument, document]) {
      await vscode.window.showTextDocument(value, { preview: false, preserveFocus: false });
    }
    const position = document.positionAt(document.getText().indexOf('class ' + fixture.oldName) + 'class '.length);
    const prepare = newName => api.java.typeRename.prepare({ document, position, newName });
    await assert.rejects(prepare(fixture.additional), /filename already exists/u);
    const plan = await until(async () => {
      try {
        return await prepare(fixture.newName);
      } catch (error) {
        if (/JDT did not recognize|class(?:path| file membership) changed|source\/resource\/build buffer changed|source file changed after review/u.test(error.message)) return;
        throw error;
      }
    }, 85000);
    assert.equal(plan.typeRename.attributedSpans, 8);
    assert.equal(plan.typeRename.files, 2);
    assert.equal(plan.typeRename.xmlBeanClasses, 1);
    assert.equal(plan.resourceOperations.length, 1);
    assert.equal(plan.resourceOperations[0].newUri, vscode.Uri.file(next).toString());
    assert.equal(await exists(next), false);
    created.add(next);
    const xmlIndex = plan.documents.findIndex(file => file.beanClassReference);
    assert.ok(xmlIndex >= 0);
    for (const side of ['before', 'after']) {
      const virtual = await vscode.workspace.openTextDocument(
        vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + xmlIndex + '/' + side + '.xml'));
      assert.equal(virtual.getText().replace(/\r\n/g, '\n'), plan.documents[xmlIndex][side].replace(/\r\n/g, '\n'));
    }
    assert.equal((await api.java.refactoring.apply(plan.id)).state, 'applied');
    await confirmContents(plan, true);
    assert.equal(await fs.readFile(xml, 'utf8'), fixture.xml);
    await vscode.window.showTextDocument(await open(next), { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('undo');
    await until(async () => await exists(old) && !await exists(next), 10000);
    await confirmContents(plan, false);
    await vscode.commands.executeCommand('redo');
    await until(async () => !await exists(old) && await exists(next), 10000);
    await confirmContents(plan, true);
    for (const file of [next, caller, xml]) assert.equal(await (await open(file)).save(), true);
    assert.equal(await fs.readFile(extra, 'utf8'), fixture.extraText);
    assert.equal(await fs.readFile(xml, 'utf8'), fixture.xml.replace("class='" + fixture.oldFqn + "'", "class='" + fixture.newFqn + "'"));
    const afterRuntime = await run([next, caller, extra]);
    assert.deepEqual(afterRuntime, beforeRuntime);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Reviewed public Java class rename updates ordinary and static imports, class references, its filename and the literal Spring XML bean class.');
    checks.push('Native Undo and Redo cover Java and XML together. Saved sources compile and the actual Spring bean and JDBC results agree before and after.');
    return { ...plan.typeRename, nativeWorkspaceEdit: true, nativeXmlDiff: true, nativeUndo: true, nativeRedo: true,
      sameNamePrefixUntouched: true, destinationCollisionRefused: true, savedSpring: afterRuntime, jdbc };
  } finally {
    try {
      for (const file of created) {
        if (!await exists(file)) continue;
        const doc = vscode.workspace.textDocuments.find(value => value.uri.toString() === vscode.Uri.file(file).toString());
        if (doc?.isDirty) {
          await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await fs.unlink(file);
      }
      if (ownNested) await fs.rmdir(nested);
    } finally {
      assert.equal(await fs.realpath(owned), owned);
      assert.equal(path.dirname(owned), parent);
      await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    }
  }
}

module.exports = { runJavaTypeRenameChecks };
