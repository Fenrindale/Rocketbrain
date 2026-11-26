'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { test } = require('node:test');
const { boundKotlinSites } = require('../src/java/java-kotlin-type-rename');
const { registerJavaTypeRename } = require('../src/java/java-type-rename-vscode');
const { registerJavaRefactoring, editedText } = require('../src/java/refactoring');
const { kotlinEditorLaunch, kotlinProtocolUri } = require('../src/java/kotlin-editor-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { rangeAt } = require('../src/spring/java');
const plain = require('./helpers/java-kotlin-rename-fixture');
const aliased = require('./helpers/java-kotlin-aliased-rename-fixture');
const { owner, kotlin, newName, files } = plain;
const { uri } = require('./helpers/java-signature-jdt-host');
const { StdioLsp, until, positionOf } = require('./helpers/stdio-lsp');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const serverHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const gradleHome = process.env.ROCKETBRAIN_MIXED_RENAME_GRADLE_HOME;
const gradleUserHome = process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_MIXED_RENAME_' + engine.toUpperCase() + '_CONFIG']]);
const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

function testHost(root, java, kotlinClient) {
  const docs = new Map(), submitted = [];
  const channel = doc => doc.languageId === 'kotlin' ? kotlinClient : java;
  const protocolUri = doc => doc.languageId === 'kotlin' ? kotlinProtocolUri(doc.uri.fsPath) : doc.uri.toString();
  const host = {
    Uri: { file: uri, parse: value => uri(fileURLToPath(value)) },
    Range: class {
      constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
    },
    TextEdit: class { constructor(range, newText) { Object.assign(this, { range, newText }); } },
    WorkspaceEdit: class {
      entries = [];
      renames = [];
      set(addr, edits) { this.entries.push([addr, edits]); }
      renameFile(oldUri, newUri, options) { this.renames.push({ oldUri, newUri, options }); }
    },
    workspace: {
      isTrusted: true,
      get textDocuments() { return [...docs.values()]; },
      getWorkspaceFolder(address) {
        const relative = path.relative(root, address.fsPath);
        if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return { uri: uri(root) };
      },
      async openTextDocument(address) {
        if (docs.has(address.fsPath)) return docs.get(address.fsPath);
        const document = { uri: address, version: 1, isDirty: false, isClosed: false,
          languageId: address.fsPath.endsWith('.kt') ? 'kotlin' : 'java', text: await fs.readFile(address.fsPath, 'utf8'),
          getText() { return this.text; },
          offsetAt(position) {
            return this.text.split('\n').slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character;
          } };
        docs.set(address.fsPath, document);
        channel(document).notify('textDocument/didOpen', {
          textDocument: { uri: protocolUri(document), text: document.text, version: 1, languageId: document.languageId }
        });
        return document;
      },
      async applyEdit(edit) {
        assert.ok(edit instanceof host.WorkspaceEdit);
        submitted.push(edit);
        for (const [address, changes] of edit.entries) {
          const document = await this.openTextDocument(address);
          document.text = editedText(document.text, changes);
          document.version++;
          document.isDirty = true;
        }
        for (const { oldUri, newUri, options } of edit.renames) {
          assert.deepEqual(options, { overwrite: false, ignoreIfExists: false });
          await fs.rename(oldUri.fsPath, newUri.fsPath);
          const document = docs.get(oldUri.fsPath);
          docs.delete(oldUri.fsPath);
          document.uri = newUri;
          docs.set(newUri.fsPath, document);
        }
        return true;
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} })
    },
    commands: { registerCommand: () => ({ dispose() {} }) }
  };
  return {
    host, submitted,
    async save() {
      for (const doc of docs.values()) {
        if (doc.isDirty) await fs.writeFile(doc.uri.fsPath, doc.getText());
      }
    }
  };
}

test('Kotlin candidate attribution requires the exact class or constructor, including unqualified callable references', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-java-kt-range-'));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const [java, kt] = await Promise.all([owner, kotlin].map(async file => {
    const physical = path.join(root, file), text = files.get(file);
    await fs.mkdir(path.dirname(physical), { recursive: true });
    await fs.writeFile(physical, text, { flag: 'wx' });
    return { file: physical, uri: uri(physical).toString(), text };
  }));
  kt.text = 'package mixed.reverse.app\nimport mixed.reverse.domain.Shipment\nval factory = ::Shipment\n';
  const declaration = { start: java.text.indexOf('public final'), end: java.text.lastIndexOf('}') + 1,
    typeParameters: 0, annotations: [], constructors: [{ start: java.text.indexOf('public Shipment'),
      end: java.text.indexOf(' }', java.text.indexOf('public Shipment')) + 2, public: true, varargs: false, typeParameters: 0 }] };
  const lookup = (_, { position }) => ({ uri: java.uri,
    range: position.line === 1 ? rangeAt(java.text, declaration.start, declaration.end)
      : rangeAt(java.text, declaration.constructors[0].start, declaration.constructors[0].end) });
  const input = { root, sources: [java, kt], owner: java, declaration, fqn: 'mixed.reverse.domain.Shipment', newName };
  const bound = await boundKotlinSites({ ...input, runtime: { request: lookup, check() {} } });
  assert.deepEqual(bound.map(site=>site.role), ['type', 'constructor-reference']);
  kt.text = kt.text.replace('domain.Shipment','domain.Shipment as Delivery').replace('::Shipment','::Delivery');
  const unchanged = await boundKotlinSites({ ...input, runtime: { request: lookup, check() {} } });
  assert.deepEqual(unchanged.map(site=>[site.role,Boolean(site.importAlias),Boolean(site.keepAlias)]),
    [['type',true,false],['constructor-reference',false,true]]);
  kt.text = kt.text.replace('::Delivery','Delivery::class');
  await assert.rejects(boundKotlinSites({ ...input, runtime: { request: lookup, check() {} } }), /class literals/u);
  await assert.rejects(boundKotlinSites({ ...input, runtime: { request: async () => ({ uri: java.uri, range: rangeAt(java.text, 0, 1) }),
    check() {} } }), /exact attributed Java class/u);
  await assert.rejects(boundKotlinSites({ ...input, declaration: { ...declaration,
    constructors: [...declaration.constructors, ...declaration.constructors] } }), /one explicit public constructor/u);
});

async function verifyMixedRename(t, fixture, receiptVariable) {
  const { owner, target, caller, shadow, kotlin, newName, files, populate, rebuild, readDatabase } = fixture;
  const expectedSites = fixture.evidence || { files: 1, sites: 4, constructorBindings: 1, compilerVerified: true };
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-java-kt-rename-'));
  const root = path.join(owned, 'project');
  const runtime = await load(runtimeFile);
  const tools = { javaHome: runtime.javaHome, gradleHome, gradleUserHome };
  let java, kotlinClient, launch, review, service;
  t.after(async () => {
    await service?.dispose();
    await review?.dispose();
    await Promise.allSettled([java?.close(), kotlinClient?.close()]);
    await launch?.dispose();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const staged = path.join(owned, 'staging', 'project');
  await populate(staged, tools, { deployedRoot: root });
  await fs.rename(staged, root);
  const databases = await Promise.all(engines.map(async ([engine, file]) => [engine, await load(file)]));
  const before = await Promise.all(databases.map(([engine, config]) => readDatabase(root, tools, config, engine)));
  const rootUri = uri(root).toString();
  java = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  const settings = serverSettings([{ name: 'JavaSE-25', path: tools.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  if (settings.java.import?.gradle) settings.java.import.gradle.enabled = false;
  await java.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'Java class Kotlin callers' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true,
      workspaceEdit: { documentChanges: true, resourceOperations: ['rename'] } }, textDocument: { rename: { prepareSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
  java.notify('initialized', {});
  launch = await kotlinEditorLaunch({ ...tools, root, serverHome, storageRoot: path.join(owned, 'ktlsp') });
  kotlinClient = new StdioLsp(launch);
  const kotlinRoot = kotlinProtocolUri(root);
  await kotlinClient.request('initialize', { processId: process.pid, rootUri: kotlinRoot, rootPath: root,
    workspaceFolders: [{ uri: kotlinRoot, name: 'Java class Kotlin callers' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: { definition: { linkSupport: true } } }
  }, 90000);
  kotlinClient.notify('initialized', {});
  const bridge = testHost(root, java, kotlinClient);
  const vscode = bridge.host;
  const document = await vscode.workspace.openTextDocument(uri(path.join(root, owner)));
  await vscode.workspace.openTextDocument(uri(path.join(root, caller)));
  const kotlinUnits = [...files.keys()].filter(file=>file.endsWith('.kt'));
  const kotlinDocs = await Promise.all(kotlinUnits.map(file=>vscode.workspace.openTextDocument(uri(path.join(root,file)))));
  const kotlinDoc = kotlinDocs[kotlinUnits.indexOf(kotlin)];
  await until(async () => {
    const model = await java.request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [document.uri.toString(), { scope: 'test' }] }, 25000);
    const kotlinOutput = path.join(root, 'build/classes/kotlin/main');
    return model?.classpaths?.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) &&
      model.classpaths.some(file => !path.relative(kotlinOutput, file));
  }, 80000);
  await until(async () => {
    const defs = await kotlinClient.request('textDocument/definition', { textDocument: { uri: kotlinProtocolUri(kotlinDoc.uri.fsPath) },
      position: positionOf(kotlinDoc.getText(), 'domain.Shipment', 8) }, 25000);
    return defs?.some(result => (result.uri || result.targetUri)?.endsWith('/Shipment.java'));
  }, 80000);
  review = registerJavaRefactoring({}, vscode);
  service = registerJavaTypeRename(vscode, { refactoring: review,
    request: (method, params) => java.request(method, params, 30000),
    runtime: () => ({ javaHome: tools.javaHome, storagePath: owned }),
    beginKotlin: async () => ({ root, compiler: launch.compiler, check() {},
      request: (method, params) => kotlinClient.request(method, params, 30000) }) });
  const position = positionOf(document.getText(), 'class Shipment', 6);
  const plan = await service.prepare({ document, position, newName });
  assert.deepEqual(plan.typeRename.kotlinCallers, expectedSites);
  assert.equal(plan.resourceOperations.length, 1);
  assert.equal(plan.documents.length, 2 + kotlinDocs.length);
  const expected = kotlinDocs.map(doc=>fixture.renamedKotlin?.(doc.getText()) ||
    doc.getText().replace(/(?<!reverse\.shadow\.)\bShipment\b/gu,newName));
  for (const [index, doc] of kotlinDocs.entries()) {
    const diff = plan.documents.find(file => file.javaTypeKotlinReference && file.uri === doc.uri.toString());
    assert.equal(diff?.after, expected[index]);
  }
  assert.equal(bridge.submitted.length, 0);
  kotlinDoc.isDirty = true;
  await assert.rejects(review.apply(plan.id), /save|unsaved|changed/iu);
  assert.equal(bridge.submitted.length, 0);
  assert.equal(await fs.readFile(path.join(root, kotlin), 'utf8'), files.get(kotlin));
  kotlinDoc.isDirty = false;
  assert.equal((await review.apply(plan.id)).state, 'applied');
  assert.equal(bridge.submitted.length, 1);
  assert.equal(bridge.submitted[0].entries.length, 2 + kotlinDocs.length);
  assert.equal(bridge.submitted[0].renames.length, 1);
  assert.deepEqual(kotlinDocs.map(doc=>doc.getText()), expected);
  await assert.rejects(review.apply(plan.id), /expired/u);
  await bridge.save();
  await assert.rejects(fs.stat(path.join(root, owner)), { code: 'ENOENT' });
  await fs.stat(path.join(root, target));
  assert.equal(await fs.readFile(path.join(root, shadow), 'utf8'), files.get(shadow));
  await rebuild(root, tools);
  const after = await Promise.all(databases.map(([engine, config]) => readDatabase(root, tools, config, engine)));
  assert.deepEqual(after, before);
  const binary = 'build/classes/java/main/mixed/reverse/domain/';
  await assert.rejects(fs.stat(path.join(root, binary + 'Shipment.class')), { code: 'ENOENT' });
  await fs.stat(path.join(root, binary + newName + '.class'));
  const receipt = process.env[receiptVariable];
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ ...plan.typeRename, editSubmissions: 1,
    jdt: true, kotlinServer: launch.serverVersion, compiler: launch.compilerVersion, gradleRebuilt: true,
    dirtyRefused: true, replayRefused: true, unrelatedClassRetained: true, previousBinaryGone: true, results: after }, null, 2) + '\n');
}

const actual = !runtimeFile || !serverHome || !gradleHome || !gradleUserHome || !engines.every(([, file]) => file);
test('public Java class review updates exact Kotlin constructor and type sites in real Gradle and paired Spring JDBC',
  { skip: actual, timeout: 360000 }, t => verifyMixedRename(t, plain, 'ROCKETBRAIN_JAVA_KOTLIN_RENAME_RECEIPT'));
test('Java class rename preserves Kotlin import aliases and exact direct constructor callable references in real Gradle and paired Spring JDBC',
  { skip: actual, timeout: 360000 }, t => verifyMixedRename(t, aliased, 'ROCKETBRAIN_JAVA_KOTLIN_ALIASED_RENAME_RECEIPT'));
