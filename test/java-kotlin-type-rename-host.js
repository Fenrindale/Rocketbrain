'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { randomUUID } = require('node:crypto');
const { until, positionOf } = require('./helpers/stdio-lsp');
const plain = require('./helpers/java-kotlin-rename-fixture');
const aliased = require('./helpers/java-kotlin-aliased-rename-fixture');

async function verifyMixedRename(api, vscode, checks, fixture) {
  const { owner, target, caller, shadow, kotlin, newName, files, populate, rebuild, readDatabase } = fixture;
  const expectedSites = fixture.evidence || { files: 1, sites: 4, constructorBindings: 1, compilerVerified: true };
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const parent = await fs.realpath(path.dirname(workspace));
  const preparation = await fs.mkdtemp(path.join(parent, 'rb-mixed-rename-prep-'));
  const projectName = 'rb-java-kotlin-rename-' + randomUUID().slice(0, 12);
  const root = path.join(workspace, projectName);
  const staged = path.join(preparation, projectName);
  const configuration = (key) => vscode.workspace.getConfiguration(key, vscode.Uri.file(root));
  const java = api.java;
  const tools = {
    javaHome: configuration('rocketbrain.java').get('javaHome') || java.getState().javaHome,
    gradleHome: process.env.ROCKETBRAIN_MIXED_RENAME_GRADLE_HOME || configuration('rocketbrain.java').get('gradleHome'),
    gradleUserHome: process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME || configuration('rocketbrain.kotlinEditor').get('gradleUserHome')
  };
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
  const show = async file => vscode.window.showTextDocument(await open(file), { preview: false, preserveFocus: false });
  const exists = file => fs.stat(path.join(root, file)).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  function owns(file) {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  let imported, plan, installed = false;
  try {
    const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
    const ownership = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
    assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(ownership.kind));
    const config = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
    // Finish the Eclipse descriptors before the native workspace watcher can import the Gradle fixture.
    await populate(staged, tools, { deployedRoot: root });
    const physical = await fs.realpath(staged);
    assert.equal(path.relative(physical, staged), '');
    assert.equal(path.relative(path.dirname(physical), preparation), '');
    assert.equal(path.relative(path.dirname(root), workspace), '');
    assert.equal(path.relative(await fs.realpath(workspace), workspace), '');
    await fs.rename(physical, root);
    installed = true;
    const before = await readDatabase(root, tools, config, spring.dbEngine);
    await java.start();
    await java.executeWorkspaceCommand('java.project.changeImportedProjects', [vscode.Uri.file(path.join(root, '.project')).toString()], [], []);
    const document = (await show(owner)).document, kt = (await show(kotlin)).document;
    const javaUse = await open(caller);
    const kotlinUnits = [...files.keys()].filter(unit=>unit.endsWith('.kt'));
    for (const unit of kotlinUnits) if (unit !== kotlin) await open(unit);
    imported = await until(async () => {
      const metadata = await java.executeWorkspaceCommand('java.project.getClasspaths', document.uri.toString(), { scope: 'test' });
      const key = metadata?.projectRoot, physical = key?.startsWith('file:') ? fileURLToPath(key) : key;
      const kotlinOutput = path.join(root, 'build/classes/kotlin/main');
      return physical && path.isAbsolute(physical) && !path.relative(physical, root) &&
        metadata.classpaths?.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) &&
        metadata.classpaths.some(file => !path.relative(kotlinOutput, file)) ? key : undefined;
    }, 100000);
    await java.kotlinEditor.start({ document: kt });
    const use = positionOf(kt.getText(), 'domain.Shipment', 8);
    await until(async () => {
      const defs = await java.kotlinEditor.definition(kt, new vscode.Position(use.line, use.character));
      return defs?.some(item => {
        const address = item.targetUri || item.uri;
        return typeof address === 'string' && address.startsWith('file:') &&
          !path.relative(path.join(root, owner), fileURLToPath(address));
      });
    }, 80000);
    const position = document.positionAt(document.getText().indexOf('class Shipment') + 6);
    await until(async () => {
      const references = await java.navigationLocations('references', { textDocument: { uri: document.uri.toString() },
        position: { line: position.line, character: position.character }, context: { includeDeclaration: true } });
      const paths = references?.filter(ref => ref.uri?.startsWith('file:')).map(ref => fileURLToPath(ref.uri)) || [];
      if (!paths.some(file => !path.relative(javaUse.uri.fsPath, file))) {
        throw Error('JDT has not indexed the saved JavaUsage.java caller for the exact imported mixed project.');
      }
      return true;
    }, 25000);
    plan = await java.typeRename.prepare({ document, position, newName });
    assert.deepEqual(plan.typeRename.kotlinCallers, expectedSites);
    assert.equal(plan.resourceOperations.length, 1);
    const kotlinDiffs = plan.documents.map((file,index)=>({file,index})).filter(({file})=>file.javaTypeKotlinReference);
    assert.equal(kotlinDiffs.length,kotlinUnits.length);
    for (const {file,index} of kotlinDiffs) {
      if (fixture.renamedKotlin) assert.equal(file.after,fixture.renamedKotlin(file.before));
      for (const side of ['before','after']) {
        const comparison = await vscode.workspace.openTextDocument(
          vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/' + index + '/' + side + '.kt'));
        assert.equal(comparison.getText().replaceAll('\r\n','\n'),file[side].replaceAll('\r\n','\n'));
      }
    }
    async function verify(after) {
      assert.equal(await exists(owner), !after);
      assert.equal(await exists(target), after);
      for (const file of plan.documents) {
        const loaded = await vscode.workspace.openTextDocument(vscode.Uri.parse(after && file.newUri ? file.newUri : file.uri));
        assert.equal(loaded.getText(), after ? file.after : file.before);
      }
    }
    assert.equal((await java.refactoring.apply(plan.id)).state, 'applied');
    await verify(true);
    await show(target);
    await vscode.commands.executeCommand('undo');
    await until(async () => await exists(owner) && !await exists(target), 10000);
    await verify(false);
    await vscode.commands.executeCommand('redo');
    await until(async () => !await exists(owner) && await exists(target), 10000);
    await verify(true);
    for (const file of [target, caller, ...kotlinUnits]) assert.equal(await (await open(file)).save(), true);
    assert.equal(await fs.readFile(path.join(root, shadow), 'utf8'), files.get(shadow));
    await rebuild(root, tools);
    const after = await readDatabase(root, tools, config, spring.dbEngine);
    assert.deepEqual(after, before);
    checks.push(fixture.evidence
      ? 'Reviewed Java class rename preserves Kotlin import aliases and verifies the exact JVM bindings of aliased and unaliased constructor references.'
      : 'Reviewed Java public class rename resolves Kotlin imports, direct constructors and explicit types with the exact Java owner.');
    checks.push('One native Undo and Redo covers the Java file rename and both languages. The Gradle Spring JDBC output is unchanged.');
    return { ...plan.typeRename, kotlinDiff: true, nativeUndo: true, nativeRedo: true, spring: after };
  } finally {
    await java.kotlinEditor.stop().catch(() => {});
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== 'file' || !owns(document.uri.fsPath) || !document.isDirty) continue;
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      const address = tab.input?.uri;
      return address && (address.scheme === 'file' && owns(address.fsPath) ||
        plan && address.scheme === 'rocketbrain-java-refactor' && address.path.startsWith('/' + plan.id + '/'));
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    if (imported) await java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [imported]).catch(() => {});
    for (const [temporary, owner, prefix] of [
      ...(installed ? [[root, workspace, 'rb-java-kotlin-rename-']] : []),
      [preparation, parent, 'rb-mixed-rename-prep-']
    ]) {
      const physical = await fs.realpath(temporary);
      assert.equal(path.relative(physical, temporary), '');
      assert.equal(path.relative(path.dirname(physical), owner), '');
      assert.ok(path.basename(physical).startsWith(prefix));
      await fs.rm(physical, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
  }
}

const runJavaKotlinTypeRenameChecks = (api,vscode,checks) => verifyMixedRename(api,vscode,checks,plain);
const runJavaKotlinAliasedTypeRenameChecks = (api,vscode,checks) => verifyMixedRename(api,vscode,checks,aliased);
module.exports = { runJavaKotlinTypeRenameChecks, runJavaKotlinAliasedTypeRenameChecks };
