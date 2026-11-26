'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerJavaMove } = require('../src/java/move');
const { registerJavaRefactoring, editedText } = require('../src/java/refactoring');
const { reconciledEngineEdits } = require('../src/java/java-package-rename');
const { planBootImports } = require('../src/java/package-boot-imports');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { rangeAt } = require('../src/spring/java');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { originalPackage, renamedPackage, ownerPath, sourceFolder, targetFolder, clientPath, unrelated,
  populatePackageRename, runPackageSpring, fixtureSources, bootProvider, bootFiles, bootText, packageClasspath } =
  require('./helpers/java-package-rename-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH;
const withBoot = process.env.ROCKETBRAIN_PACKAGE_RENAME_BOOT_IMPORTS === '1';
const dbs = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_PACKAGE_RENAME_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

test('JDT import reordering is equivalent only when the package and all code tokens still agree', () => {
  const file = path.resolve('test-output', 'Caller.java'), address = uri(file).toString();
  const text = 'package client;\nimport fixture.billing.*;\nimport static fixture.billing.Ledger.TAG;\nclass Caller { String v = TAG; }\n';
  const exact = [...text.matchAll(/fixture\.billing/gu)].map(match =>
    ({ range: rangeAt(text, match.index, match.index + match[0].length), newText: renamedPackage }));
  const expected = [{ textDocument: { uri: address }, edits: exact }];
  const range = rangeAt(text, text.indexOf('import'), text.indexOf('class'));
  const newText = 'import static fixture.settlement.Ledger.TAG;\n\nimport fixture.settlement.*;\n';
  const fixtures = new Map([[key(file), { uri: address, text, version: 1 }]]);
  const edits = { changes: { [address]: [{ range, newText }] } };
  assert.equal(reconciledEngineEdits(edits, fixtures, expected, originalPackage, renamedPackage, new Map()).engineFiles, 1);
  edits.changes[address][0].newText = newText.replace('.TAG', '.OTHER');
  assert.throws(() => reconciledEngineEdits(edits, fixtures, expected, originalPackage, renamedPackage, new Map()), /exact Javac/);
  edits.changes[address] = [];
  edits.documentChanges = [{ kind: 'rename', oldUri: address, newUri: address }];
  assert.throws(() => reconciledEngineEdits(edits, fixtures, expected, originalPackage, renamedPackage, new Map()), /file operations/);
});

test('Spring Boot imports allow exact top-level registration edits and preserve literal bytes outside the candidate', () => {
  const root = path.resolve('test-output', 'boot-package-policy');
  const owner = path.join(root, bootProvider);
  const { createHash } = require('node:crypto');
  const source = (file, text) => ({ file, text, version: 1, uri: uri(file).toString(),
    diskHash: createHash('sha256').update(text).digest('hex') });
  const candidates = [
    source(owner, fixtureSources(true).get(bootProvider)),
    source(path.join(root, bootFiles[0]), bootText(0, false))
  ];
  const moved = new Map([[key(owner), { packageName: originalPackage }]]);
  const plan = inputs => planBootImports({ sources: inputs, moved, projectRoot: root, oldPackage: originalPackage, newPackage: renamedPackage });
  const accepted = plan(candidates);
  assert.equal(accepted.registrations, 1);
  assert.equal(accepted.allowedAnnotations.get(key(owner)).size, 2);
  assert.equal(editedText(candidates[1].text, accepted.entries[0].edits), bootText(0, true));
  assert.throws(() => plan([candidates[0], source(candidates[1].file, candidates[1].text + renamedPackage + '.LedgerAutoConfiguration\r\n')]), /duplicate/u);
  assert.throws(() => plan([candidates[0], source(candidates[1].file, originalPackage + '.Unknown\n')]), /does not identify/u);
  assert.throws(() => plan([candidates[0], source(candidates[1].file, originalPackage + '.LedgerAutoConfiguration$Inner\n')]), /top-level/u);
  assert.throws(() => plan([candidates[0], source(candidates[1].file, '\uFEFF' + candidates[1].text)]), /plain UTF-8/u);
  assert.throws(() => plan([source(owner, candidates[0].text.replace('import org.springframework.boot.autoconfigure.AutoConfiguration;',
    'import fixture.fake.AutoConfiguration;')), candidates[1]]), /exact public top-level/u);
});

function host(root, lsp, suppresses) {
  const documents = new Map(), applied = [];
  class Range { constructor(a,b,c,d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
  class TextEdit { constructor(range,newText) { Object.assign(this, { range, newText }); } }
  class WorkspaceEdit {
    constructor() { this.parts = []; }
    set(target, edits) { this.parts.push({ target, edits }); }
    renameFile(from, to, options) { this.parts.push({ from, to, options }); }
  }
  const workspace = {
    isTrusted: true,
    get textDocuments() { return [...documents.values()]; },
    getWorkspaceFolder: () => ({ uri: uri(root) }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    async openTextDocument(target) {
      if (!documents.has(key(target.fsPath))) {
        const text = await fs.readFile(target.fsPath, 'utf8');
        const value = { uri: target, version: 1, isClosed: false, isDirty: false,
          languageId: target.fsPath.endsWith('.java') ? 'java' : 'plaintext', getText: () => text };
        documents.set(key(target.fsPath), value);
        if (value.languageId === 'java') lsp.notify('textDocument/didOpen', {
          textDocument: { uri: target.toString(), languageId: 'java', version: 1, text }
        });
      }
      return documents.get(key(target.fsPath));
    },
    async applyEdit(edit) {
      assert.ok(edit instanceof WorkspaceEdit);
      const last = edit.parts.at(-1);
      assert.equal(last.from.toString(), uri(path.join(root, sourceFolder)).toString());
      assert.equal(last.to.toString(), uri(path.join(root, targetFolder)).toString());
      assert.deepEqual(last.options, { overwrite: false, ignoreIfExists: false });
      assert.equal(suppresses([{ oldUri: last.from, newUri: last.to }]), true);
      assert.equal(suppresses([{ oldUri: last.to, newUri: last.from }]), false);
      await assert.rejects(fs.stat(last.to.fsPath), { code: 'ENOENT' });
      for (const {target, edits} of edit.parts.slice(0, -1)) {
        const text = await fs.readFile(target.fsPath, 'utf8');
        await fs.writeFile(target.fsPath, editedText(text, edits));
      }
      await fs.rename(last.from.fsPath, last.to.fsPath);
      applied.push(edit);
      return true;
    }
  };
  return { applied, vscode: { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) }, workspace,
    Range, TextEdit, WorkspaceEdit, commands: { registerCommand: () => ({ dispose() {} }) } } };
}

test('pinned JDT reviews a nonexistent Java package sibling and both actual Spring JDBC builds are equivalent', {
  skip: !runtimeFile || !cpFile || !dbs.every(([, file]) => file), timeout: 300000
}, async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-package-rename-'));
  const root = path.join(owned, 'project');
  const runtime = await read(runtimeFile), cp = await packageClasspath(cpFile, 'mysql', withBoot);
  const sources = fixtureSources(withBoot);
  const lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  let refactoring, move;
  t.after(async () => {
    await move?.dispose();
    await refactoring?.dispose();
    await lsp.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-package-rename-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await populatePackageRename(root, cp, { withBoot });
  const data = await Promise.all(dbs.map(async ([engine, file]) => [engine, await read(file)]));
  const run = async (renamed) => Promise.all(data.map(async ([engine, database]) =>
    runPackageSpring({ javaHome: runtime.javaHome, root, database, engine, classpathFile: cpFile,
      classes: await fs.mkdtemp(path.join(owned, 'classes-')), renamed, withBoot })));
  const original = await run(false);

  const rootUri = uri(root).toString();
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'rename' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true,
      workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  lsp.notify('initialized', {});
  const { vscode, applied } = host(root, lsp, files => refactoring.isApplyingPackageRename(files));
  const document = await vscode.workspace.openTextDocument(uri(path.join(root, ownerPath)));
  const target = path.join(root, targetFolder), caller = path.join(root, clientPath);
  const requests = [];
  const request = async (method, arguments_) => {
    const value = await lsp.request(method, arguments_, 30000);
    if (method === 'workspace/willRenameFiles') requests.push({ arguments_, value });
    return value;
  };
  await until(async () => {
    const model = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [document.uri.toString(), { scope: 'test' }] });
    return model?.projectRoot && model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar'));
  }, 85000);
  refactoring = registerJavaRefactoring({}, vscode);
  move = registerJavaMove({}, vscode, { request, refactoring,
    runtime: () => ({ javaHome: runtime.javaHome, storagePath: path.join(owned, 'compiler') }) });
  const prepare = () => move.prepareRenamePackage(document, 'settlement');

  await assert.rejects(move.prepareRenamePackage(document, 'Billing'), /exists or collides by case/u);
  const marker = path.join(root, sourceFolder, 'owned-resource.txt');
  await fs.writeFile(marker, 'keep', { flag: 'wx' });
  await assert.rejects(prepare(), /contains resources/u);
  await fs.unlink(marker);
  const plan = await prepare();
  assert.deepEqual(requests[0].arguments_, { files: [{ oldUri: uri(path.join(root, sourceFolder)).toString(), newUri: uri(target).toString() }] });
  assert.ok(requests[0].value.documentChanges.every(change => !change.kind));
  assert.ok(requests[0].value.documentChanges.some(change => change.edits.some(edit => edit.newText === 'fixture.settlement.detail')));
  assert.equal(plan.resourceOperations.length, 1);
  assert.equal(plan.resourceOperations[0].directory, true);
  assert.equal(plan.packageRename.movedFiles, withBoot ? 3 : 2);
  assert.equal(plan.packageRename.editedFiles, withBoot ? 7 : 4);
  if (withBoot) {
    assert.deepEqual(plan.packageRename.bootImports, { files: 2, registrations: 2 });
    for (const [index, relative] of bootFiles.entries()) {
      const change = plan.documents.find(file => file.uri === uri(path.join(root, relative)).toString());
      assert.equal(change.bootImportsReference, true);
      assert.equal(change.before, bootText(index, false));
      assert.equal(change.after, bootText(index, true));
    }
  }
  assert.ok(plan.packageRename.bindings > 10);
  assert.equal(plan.packageRename.supplemented, 0);
  assert.equal(applied.length, 0);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  for (const [file, text] of sources) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), text);

  await fs.mkdir(target);
  await assert.rejects(refactoring.apply(plan.id), /destination package already exists/u);
  await fs.rmdir(target);
  await fs.appendFile(caller, '// changed after review\n');
  await assert.rejects(refactoring.apply(plan.id), /descriptor changed after review/u);
  await fs.writeFile(caller, sources.get(clientPath));
  assert.equal(applied.length, 0);
  if (withBoot) {
    const registry = path.join(root, bootFiles[0]);
    await fs.appendFile(registry, '# changed after review\r\n');
    await assert.rejects(refactoring.apply(plan.id), /descriptor changed after review/u);
    await fs.writeFile(registry, bootText(0, false));
    const replacement = registry.replace(/\.imports$/u, '.replacements');
    await fs.writeFile(replacement, originalPackage + '.LedgerAutoConfiguration=' + renamedPackage + '.LedgerAutoConfiguration\n', { flag: 'wx' });
    await assert.rejects(refactoring.apply(plan.id), /registration resource set changed/u);
    await fs.unlink(replacement);
  }

  assert.equal((await refactoring.apply(plan.id)).state, 'applied');
  assert.equal(applied.length, 1);
  assert.equal(refactoring.isApplyingPackageRename([{ oldUri: uri(path.join(root, sourceFolder)), newUri: uri(target) }]), false);
  await assert.rejects(fs.stat(path.join(root, sourceFolder)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, unrelated), 'utf8'), sources.get(unrelated));
  const next = await fs.readFile(caller, 'utf8');
  assert.ok(next.includes('fixture.billing.marker'));
  assert.ok(next.includes('fixture.billings.Other'));
  assert.ok(next.includes('import static fixture.settlement.Ledger.TAG;'));
  if (withBoot) {
    for (const [index, relative] of bootFiles.entries()) assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), bootText(index, true));
  } else assert.ok(next.includes('new fixture.settlement.Ledger()'));
  const rebuilt = await run(true);
  assert.deepEqual(rebuilt, original);
  const receipt = { ...plan.packageRename, actualJdtFolderRequest: true, prospectiveJavac: true, singleDirectoryRename: true, suppressesDuplicateJdtRename: true,
    untouchedSameSpellingVariable: true, untouchedPackagePrefix: true, previewKeptTargetAbsent: true,
    lateTargetRefused: true, changedSourceRefused: true, resourcesRefused: true,
    ...(withBoot && { bootDescriptorDriftRefused: true, bootReplacementAddedRefused: true, registrationBytesExact: true }),
    results: rebuilt };
  if (process.env.ROCKETBRAIN_PACKAGE_RENAME_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_PACKAGE_RENAME_RECEIPT,
    JSON.stringify(receipt, null, 2) + '\n');
});
