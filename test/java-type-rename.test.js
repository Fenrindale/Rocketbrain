'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { editedText } = require('../src/java/refactoring');
const { prepareJavaTypeRename, classContracts, verifiedEngineEdits } = require('../src/java/java-type-rename');
const { moveScope, snapshotScope, validateScope } = require('../src/java/move-scope');
const { beanClassEdits } = require('../src/java/java-type-rename-xml');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { typeRenameFixture, springTypeRenameClasspath, runSpringTypeRename } = require('./helpers/java-type-rename-fixture');

const stateFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_TYPE_RENAME_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_TYPE_RENAME_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('XML rename changes only namespace-attributed literal bean classes', () => {
  const source = { text: '<beans xmlns="http://www.springframework.org/schema/beans">\r\n' +
    '<!-- demo.Service -->\r\n<bean id="demo.Service" class = \'demo.Service\'/>\r\n' +
    '<bean class="demo.ServicePrefix"/>\r\n<bean class="prefix.demo.Service"/>\r\n</beans>' };
  const edits = beanClassEdits(source, 'demo.Service', 'demo.Invoicing');
  assert.equal(edits.length, 1);
  assert.equal(editedText(source.text, edits), source.text.replace("class = 'demo.Service'", "class = 'demo.Invoicing'"));
  for (const body of [
    '<bean class="demo.&#83;ervice"/>', '<bean class="demo.Service$Nested"/>',
    '<bean class="other"><property name="target" value="demo.Service"/></bean>',
    '<bean class="other"><property name="target"><value>demo.Service</value></property></bean>'
  ]) {
    assert.throws(() => beanClassEdits({ text: '<beans xmlns="http://www.springframework.org/schema/beans">' + body + '</beans>' },
      'demo.Service', 'demo.Invoicing'), /ordinary literal|unsupported XML/u);
  }
  assert.throws(() => beanClassEdits({ text: '<!DOCTYPE beans><beans class="demo.Service"/>' }, 'demo.Service', 'demo.Invoicing'), /without DTD/u);
  assert.throws(() => beanClassEdits({ text: '<beans class="demo.Service">' }, 'demo.Service', 'demo.Invoicing'), /XML class contract/u);
});

test('review refuses dynamic Java names, services, Kotlin and Maven class settings', () => {
  for (const [file, text] of [
    ['Caller.java', 'class Caller { String name = "demo.Service"; }'],
    ['META-INF/services/demo.Service', 'demo.Other'],
    ['META-INF/spring/org.example.SomeAutoConfiguration.imports', 'demo.Service'],
    ['Caller.kt', 'fun call(value: Service) = value'],
    ['pom.xml', '<project><mainClass>demo.Service</mainClass></project>']
  ]) {
    assert.throws(() => classContracts([{ file, text }], 'demo.Service', 'demo.Invoicing'), /separate rename|configured callers|unsupported XML/u);
  }
  assert.deepEqual(classContracts([{ file: 'Caller.java', text: 'class Caller { /* demo.Service */ String note = "demo.ServiceExtra"; }' }],
    'demo.Service', 'demo.Invoicing'), { entries: [], permissions: [] });
});

test('a JDT grouped replacement must equal the reviewed Javac tokens byte for byte', () => {
  const uri = pathToFileURL(path.resolve('Old.java')).href;
  const source = { uri, file: fileURLToPath(uri), text: 'Old a = new Old();', version: 1 };
  const range = (start, end) => ({ start: { line: 0, character: start }, end: { line: 0, character: end } });
  const expected = [{ textDocument: { uri, version: 1 }, edits: [range(0, 3), range(12, 15)]
    .map(range => ({ range, newText: 'NewName' })) }];
  const proposed = { changes: { [uri]: [{ range: range(0, 15), newText: 'NewName a = new NewName' }] } };
  const rename = { oldUri: uri, newUri: pathToFileURL(path.resolve('NewName.java')).href };
  assert.deepEqual(verifiedEngineEdits(proposed, [source], expected, rename), { files: 1, fileRenameFromEngine: false });
  proposed.changes[uri][0].newText = 'NewName b = new NewName';
  assert.throws(() => verifiedEngineEdits(proposed, [source], expected, rename), /differs from the exact/u);
  assert.throws(() => verifiedEngineEdits({ ...proposed, documentChanges: [{ kind: 'delete', uri }] }, [source], expected, rename),
    /unexpected file operation/u);
});

test('type rename pins JDT test paths and reassesses clients while Move keeps runtime scope', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const workspace = await fs.mkdtemp(path.join(parent, 'rb-type-rename-scope-'));
  t.after(async () => {
    assert.equal(await fs.realpath(workspace), workspace);
    assert.equal(path.dirname(workspace), parent);
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const project = path.join(workspace, 'app'), client = path.join(workspace, 'client');
  const main = path.join(project, 'src', 'main'), tests = path.join(project, 'src', 'test');
  const runtimeOutput = path.join(project, 'bin', 'main');
  const testLibrary = path.join(workspace, 'junit-jupiter-params.jar');
  const declaration = path.join(main, 'Ledger.java'), testSource = path.join(tests, 'LedgerTests.java');
  await Promise.all([main, tests, runtimeOutput, client].map(folder => fs.mkdir(folder, { recursive: true })));
  await fs.writeFile(declaration, 'public class Ledger {}');
  await fs.writeFile(testSource, 'import org.junit.jupiter.params.ParameterizedTest; class LedgerTests {}');
  await fs.writeFile(testLibrary, 'fixture classpath entry');
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const vscode = { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) }, workspace: {
    getWorkspaceFolder: () => ({ uri: uri(workspace) }),
    openTextDocument: async range => {
      const text = await fs.readFile(range.fsPath, 'utf8');
      return { getText: () => text, version: 1, isDirty: false, isClosed: false };
    }
  } };
  const calls = [];
  let includeTestLibrary = true, clientDependsOnApp = false;
  const request = async (_method, { command, arguments: args }) => {
    if (command === 'java.project.getAll') return [project, client].map(file => uri(file).toString());
    if (command === 'java.project.getSettings') return { 'org.eclipse.jdt.ls.core.sourcePaths': [main, tests] };
    assert.equal(command, 'java.project.getClasspaths');
    const [target, { scope }] = args;
    const clientRequest = target === uri(client).toString();
    calls.push(scope);
    if (clientRequest) return {
      classpaths: [], modulepaths: scope === 'test' && clientDependsOnApp ? [runtimeOutput] : []
    };
    return { projectRoot: uri(project).toString(), modulepaths: [],
      classpaths: [runtimeOutput, ...(scope === 'test' && includeTestLibrary ? [testLibrary] : [])] };
  };
  const anchor = uri(declaration);
  const rename = await moveScope(vscode, request, anchor, anchor, undefined, { classpathScope: 'test' });
  assert.equal(rename.classpathScope, 'test');
  assert.deepEqual(rename.source.classpaths.classpaths, [runtimeOutput, testLibrary]);
  assert.ok((await snapshotScope(rename, vscode, () => {})).some(source => source.file === testSource));
  await validateScope(rename, vscode, request, anchor, anchor);
  assert.deepEqual(new Set(calls.splice(0)), new Set(['test']));
  includeTestLibrary = false;
  await assert.rejects(validateScope(rename, vscode, request, anchor, anchor), /classpath\/source-root metadata changed/);
  includeTestLibrary = true;
  clientDependsOnApp = true;
  await assert.rejects(validateScope(rename, vscode, request, anchor, anchor), /additional imported Java project depends/);
  calls.length = 0;
  const move = await moveScope(vscode, request, anchor, anchor);
  await validateScope(move, vscode, request, anchor, anchor);
  assert.deepEqual(move.source.classpaths.classpaths, [runtimeOutput]);
  assert.deepEqual(new Set(calls), new Set(['runtime']));
});

test('pinned JDT and Javac review one public class and saved Spring XML loads before and after on both actual databases', {
  skip: !stateFile || !classpathFile || !dbFiles.every(([, file]) => file), timeout: 220000
}, async t => {
  const state = await read(stateFile);
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-type-rename-'));
  const root = path.join(owned, 'project');
  const fixture = typeRenameFixture('fixture.billing', 'Ledger');
  const sourceRoot = path.join(root, 'src');
  const classRoot = path.join(sourceRoot, ...fixture.namespace.split('.'));
  const callerRoot = path.join(sourceRoot, ...fixture.callerPackage.split('.'));
  const owner = path.join(classRoot, fixture.oldName + '.java');
  const caller = path.join(callerRoot, fixture.caller + '.java');
  const extra = path.join(classRoot, fixture.additional + '.java');
  const xml = path.join(root, fixture.xmlFileName);
  const target = path.join(classRoot, fixture.newName + '.java');
  const lsp = new StdioLsp(resolveLaunch({ ...state, storagePath: path.join(owned, 'jdt') }));
  t.after(async () => {
    await lsp.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await fs.mkdir(callerRoot, { recursive: true });
  await fs.mkdir(path.join(root, 'bin'));
  await fs.writeFile(path.join(root, '.project'), '<projectDescription><name>rb-public-type</name><buildSpec>' +
    '<buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>' +
    '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
  const initCp = await springTypeRenameClasspath(classpathFile, 'mysql');
  await fs.writeFile(path.join(root, '.classpath'), '<classpath><classpathentry kind="src" path="src"/>' +
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>' +
    initCp.map(file => '<classpathentry kind="lib" path="' + file.replaceAll('\\', '/').replaceAll('&', '&amp;') + '"/>').join('') +
    '<classpathentry kind="output" path="bin"/></classpath>');
  for (const [file, contents] of [[owner, fixture.ownerText], [caller, fixture.callerText], [extra, fixture.extraText], [xml, fixture.xml]]) {
    await fs.writeFile(file, contents);
  }
  const makeUri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const docs = new Map();
  const vscode = {
    Uri: { file: makeUri, parse: uri => makeUri(fileURLToPath(uri)) },
    workspace: {
      get textDocuments() { return [...docs.values()]; },
      getWorkspaceFolder: () => ({ uri: makeUri(root) }),
      openTextDocument: async uri => {
        if (!docs.has(uri.fsPath)) {
          const text = await fs.readFile(uri.fsPath, 'utf8');
          const document = { uri, getText: () => text, version: 1, isDirty: false, isClosed: false,
            languageId: uri.fsPath.endsWith('.java') ? 'java' : 'xml',
            offsetAt: position => text.split('\n').slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character };
          docs.set(uri.fsPath, document);
          if (document.languageId === 'java') lsp.notify('textDocument/didOpen',
            { textDocument: { uri: uri.toString(), languageId: 'java', version: 1, text } });
        }
        return docs.get(uri.fsPath);
      }
    }
  };
  const workspaceUri = makeUri(root).toString();
  const settings = serverSettings([{ name: 'JavaSE-25', path: state.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  await lsp.request('initialize', {
    processId: process.pid, rootUri: workspaceUri, workspaceFolders: [{ uri: workspaceUri, name: 'rename' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true,
      workspaceEdit: { documentChanges: true, resourceOperations: ['rename'] } }, textDocument: { rename: { prepareSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [workspaceUri], settings }
  }, 90000);
  lsp.notify('initialized', {});
  const document = await vscode.workspace.openTextDocument(makeUri(owner));
  await vscode.workspace.openTextDocument(makeUri(caller));
  const request = (method, params) => lsp.request(method, params, 30000);
  await until(async () => {
    const cp = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [document.uri.toString(), { scope: 'runtime' }] });
    return cp?.projectRoot && cp.classpaths.some(file => file.includes('spring-context'));
  }, 90000);
  const computed = await prepareJavaTypeRename({
    vscode, request, runtime: () => ({ javaHome: state.javaHome, storagePath: owned }), trusted: () => {},
    refactoring: { previewWorkspaceEdit: async (edit, options) => {
      await options.validate();
      return { edit, options };
    } }
  }, { document, newName: fixture.newName, position: { line: 1, character: 'public final class '.length } });
  const { edit, options, typeRename } = computed;
  assert.equal(typeRename.attributedSpans, 8);
  assert.equal(typeRename.files, 2);
  assert.equal(typeRename.xmlBeanClasses, 1);
  assert.equal(typeRename.xmlFiles, 1);
  assert.equal(edit.documentChanges.at(-1).newUri, makeUri(target).toString());
  assert.equal(options.allowedBeanClassEdits.length, 1);
  const values = [];
  for (const [engine, file] of dbFiles) {
    const config = await read(file), classpath = await springTypeRenameClasspath(classpathFile, engine);
    const run = async (files, xmlFile) => runSpringTypeRename({ engine, config, javaHome: state.javaHome,
      classpath, className: fixture.callerPackage + '.' + fixture.caller, files, xmlFile,
      classes: await fs.mkdtemp(path.join(owned, 'classes-')) });
    const before = await run([owner, caller, extra], xml);
    assert.equal(before.output, fixture.expected);
    const afterFiles = await fs.mkdtemp(path.join(owned, 'saved-'));
    for (const entry of edit.documentChanges.filter(change => change.textDocument)) {
      const file = fileURLToPath(entry.textDocument.uri);
      const text = editedText(await fs.readFile(file, 'utf8'), entry.edits);
      await fs.writeFile(path.join(afterFiles, path.basename(file === owner ? target : file)), text);
    }
    const afterXml = path.join(afterFiles, path.basename(xml));
    assert.equal(await fs.readFile(afterXml, 'utf8'), fixture.xml.replace("class='" + fixture.oldFqn + "'", "class='" + fixture.newFqn + "'"));
    const after = await run([path.join(afterFiles, path.basename(target)), path.join(afterFiles, path.basename(caller)), extra], afterXml);
    assert.deepEqual(after, before);
    values.push(after);
  }
  await fs.appendFile(xml, '\n<!-- stale XML -->\n');
  assert.throws(options.preApply, /descriptor changed/u);
  if (process.env.ROCKETBRAIN_TYPE_RENAME_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_TYPE_RENAME_RECEIPT,
      JSON.stringify({ typeRename, actualJdt: true, savedSpringXmlAndJava: true, unchangedPrefix: true, staleXmlRefused: true, values }) + '\n');
  }
});
