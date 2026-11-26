'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {fileURLToPath} = require('node:url');
const {uri} = require('./helpers/java-signature-jdt-host');
const {StdioLsp, until} = require('./helpers/stdio-lsp');
const {resolveLaunch, serverSettings} = require('../src/java/runtime');
const {registerJavaMove} = require('../src/java/move');
const {registerJavaRefactoring, editedText} = require('../src/java/refactoring');
const {key} = require('../src/java/move-scope');
const {serviceMoveCandidate} = require('../src/java/package-move-service-scope');
const F = require('./helpers/java-jpms-service-package-move-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome = process.env.ROCKETBRAIN_SERVICE_MOVE_MAVEN_HOME;
const repository = process.env.ROCKETBRAIN_SERVICE_MOVE_MAVEN_REPOSITORY;
const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_SERVICE_MOVE_' + engine.toUpperCase() + '_CONFIG']]);

function headless(root, lsp, request) {
  const cache = new Map(), applied = [];
  let refactoring, move;
  const vscode = {
    Uri: {file: uri, parse: value => uri(fileURLToPath(value))},
    Range: class {constructor(sl, sc, el, ec) {this.start = {line: sl, character: sc}; this.end = {line: el, character: ec};}},
    TextEdit: class {constructor(range, newText) {Object.assign(this, {range, newText});}},
    WorkspaceEdit: class {
      entries = [];
      renames = [];
      set(target, edits) {this.entries.push({target, edits});}
      renameFile(from, to, options) {this.renames.push({from, to, options});}
    },
    workspace: {
      isTrusted: true,
      get textDocuments() {return [...cache.values()];},
      getWorkspaceFolder(target) {
        const relative = path.relative(root, target.fsPath);
        if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) return {uri: uri(root)};
      },
      async openTextDocument(target) {
        if (cache.has(key(target.fsPath))) return cache.get(key(target.fsPath));
        const text = await fs.readFile(target.fsPath, 'utf8');
        const languageId = target.fsPath.endsWith('.java') ? 'java' : 'plaintext';
        const document = {uri: target, version: 1, isClosed: false, isDirty: false, languageId, getText: () => text};
        cache.set(key(target.fsPath), document);
        if (languageId === 'java') lsp.notify('textDocument/didOpen', {textDocument: {uri: target.toString(), text, version: 1, languageId}});
        return document;
      },
      registerTextDocumentContentProvider: () => ({dispose() {}}),
      async applyEdit(edit) {
        assert.ok(edit instanceof vscode.WorkspaceEdit);
        assert.equal(edit.renames.length, 1);
        const [rename] = edit.renames;
        assert.equal(key(rename.from.fsPath), key(path.join(root, F.selected)));
        assert.equal(key(rename.to.fsPath), key(path.join(root, F.destination)));
        assert.deepEqual(rename.options, {overwrite: false, ignoreIfExists: false});
        for (const {target, edits} of edit.entries) {
          const text = await fs.readFile(target.fsPath, 'utf8');
          await fs.writeFile(target.fsPath, editedText(text, edits));
        }
        await fs.rename(rename.from.fsPath, rename.to.fsPath);
        applied.push(edit);
        return true;
      }
    },
    commands: {registerCommand: () => ({dispose() {}})}
  };
  refactoring = registerJavaRefactoring({}, vscode);
  function launch(runtime) {
    move = registerJavaMove({}, vscode, {refactoring, runtime, request});
    return move;
  }
  return {vscode, applied, launch, refactoring, async dispose() {await move?.dispose(); await refactoring?.dispose();}};
}

test('closed JPMS package Move selection identifies only an exported service namespace in a literal reactor', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'rb-service-select-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, {recursive: true, force: false});
  });
  await F.populate(root);
  assert.deepEqual(serviceMoveCandidate(path.join(root, F.selected)), {owner: path.join(root, 'spi'), aggregator: root});
  assert.equal(serviceMoveCandidate(path.join(root, [...F.original.keys()].find(file => file.endsWith('Direct.java')))), null);
});

test('stock JDT and Maven verify moving a service package serving two named providers and both Spring databases', {
  skip: !runtimeFile || !mavenHome || !repository || !cpFile || !dbFiles.every(([, file]) => file), timeout: 270000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const parent = await fs.realpath(os.tmpdir()), work = await fs.mkdtemp(path.join(parent, 'rb-service-pair-'));
  const root = path.join(work, 'reactor'), rootUri = uri(root).toString();
  let language, editor;
  t.after(async () => {
    await editor?.dispose();
    await language?.close();
    assert.equal(path.dirname(await fs.realpath(work)), parent);
    assert.ok(path.basename(work).startsWith('rb-service-pair-'));
    await fs.rm(work, {recursive: true, force: true, maxRetries: 8, retryDelay: 250});
  });
  await F.populate(root);
  const check = async moved => {
    await F.runMaven(root, runtime.javaHome, mavenHome, repository, {rebuild: moved});
    const modules = await F.runModule(root, runtime.javaHome, moved);
    const spring = [];
    for (const [engine, configFile] of dbFiles) spring.push(await F.runSpring({
      root, work: await fs.mkdtemp(path.join(work, 'spring-')), javaHome: runtime.javaHome, cpFile, configFile, engine
    }));
    return {modules, spring};
  };
  const before = await check(false);
  language = new StdioLsp(resolveLaunch({...runtime, storagePath: path.join(work, 'jdt')}));
  const settings = serverSettings([{name: 'JavaSE-25', path: runtime.javaHome, default: true}]);
  settings.java.autobuild.enabled = false;
  await language.request('initialize', {
    processId: process.pid, rootUri, workspaceFolders: [{uri: rootUri, name: 'service-modules'}],
    capabilities: {workspace: {configuration: true, workspaceFolders: true, applyEdit: false,
      workspaceEdit: {documentChanges: true, resourceOperations: ['create', 'rename', 'delete']}}},
    initializationOptions: {bundles: [], workspaceFolders: [rootUri], settings}
  }, 90000);
  language.notify('initialized', {});
  language.notify('workspace/didChangeConfiguration', {settings});
  let corruptJdt = false, extraDependency = false;
  const request = async (method, params) => {
    const response = await language.request(method, params, 30000);
    if (extraDependency && params.command === 'java.project.getClasspaths' && response?.modulepaths?.length === 2) {
      return {...response, modulepaths: [...response.modulepaths, path.join(work, 'unlisted-module')]};
    }
    if (method === 'workspace/willRenameFiles' && corruptJdt) {
      const unrelated = [...F.original.keys()].find(file => file.endsWith('Peer.java'));
      return {documentChanges: [...(response.documentChanges || []),
        {textDocument: {uri: uri(path.join(root, unrelated)).toString()}, edits: [{
          range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}, newText: '/* unexpected change */'
        }]}
      ]};
    }
    return response;
  };
  const projects = F.modules.map(([name]) => key(path.join(root, name)));
  await until(async () => {
    const imported = await request('workspace/executeCommand', {command: 'java.project.getAll', arguments: []});
    return projects.every(project => imported.some(raw => key(fileURLToPath(raw)) === project));
  }, 90000);
  editor = headless(root, language, request);
  for (const file of F.original.keys()) await editor.vscode.workspace.openTextDocument(uri(path.join(root, file)));
  const move = editor.launch(() => ({javaHome: runtime.javaHome, storagePath: path.join(work, 'compiler')}));
  const args = [uri(path.join(root, F.sourceFolder)), uri(path.join(root, F.targetFolder))];
  extraDependency = true;
  await assert.rejects(move.preparePackage(...args), /closed imported Maven reactor/);
  extraDependency = false;
  corruptJdt = true;
  await assert.rejects(move.preparePackage(...args), /JDT proposed unrelated Java or module edits/);
  corruptJdt = false;
  const plan = await move.preparePackage(...args);
  assert.equal(plan.move.moduleServices.owner, F.apiModule);
  assert.deepEqual(plan.move.moduleServices.consumers, [F.consumerModule]);
  assert.deepEqual(plan.move.moduleServices.providers.map(item => item.module), [F.leftModule, F.rightModule]);
  assert.equal(plan.move.moduleServices.checkedCalls, 1);
  assert.equal(plan.resourceOperations.length, 1);
  assert.equal(plan.documents.filter(item => fileURLToPath(item.uri).endsWith('module-info.java')).length, 4);
  const descriptor = [...F.original].find(([file]) => file.startsWith('right' + path.sep) && file.endsWith('module-info.java'));
  const descriptorPath = path.join(root, descriptor[0]);
  await fs.writeFile(descriptorPath, descriptor[1] + '// third-party write\n');
  await assert.rejects(editor.refactoring.apply(plan.id), /changed after review|did not match|changed|Save/i);
  assert.equal(editor.applied.length, 0);
  assert.match(await fs.readFile(descriptorPath, 'utf8'), /third-party write/);
  await fs.writeFile(descriptorPath, descriptor[1]);
  assert.equal((await editor.refactoring.apply(plan.id)).state, 'applied');
  assert.equal(editor.applied.length, 1);
  await assert.rejects(editor.refactoring.apply(plan.id), /expired/);
  await fs.access(path.join(root, F.destination));
  await assert.rejects(fs.access(path.join(root, F.selected)), {code: 'ENOENT'});
  for (const [file, original] of F.original) {
    const actual = await fs.readFile(path.join(root, file === F.selected ? F.destination : file), 'utf8');
    assert.equal(actual, original.replaceAll(F.oldPackage, F.newPackage));
  }
  await editor.dispose();
  await language.close();
  editor = undefined;
  language = undefined;
  const after = await check(true);
  assert.deepEqual(before, after);
  const receipt = process.env.ROCKETBRAIN_SERVICE_MOVE_RECEIPT;
  if (receipt) await fs.writeFile(receipt, JSON.stringify({plan: plan.move, before, after,
    jdtConflictRefused: true, unlistedDependencyRefused: true, changedDescriptorRefused: true, oneWorkspaceEdit: true, replayRefused: true,
    preservedUnrelatedSourcesAndComments: true}, null, 2) + '\n', {flag: 'wx'});
});
