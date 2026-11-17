'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');

const { StdioLsp, positionOf, until } = require('./helpers/stdio-lsp');

test('official JDT LS directly imports Maven and supplies completion, definition, rename and diagnostics', { skip: !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, timeout: 240000 }, async t => {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const settingsConfig = config.settings || config;
  const javaHome = settingsConfig.javaHome || settingsConfig['rocketbrain.java.javaHome'];
  const serverPath = settingsConfig.serverPath || settingsConfig['rocketbrain.java.serverPath'];
  const root = path.join(__dirname, 'fixtures/java/maven');
  const launch = resolveLaunch({ javaHome, serverPath, storagePath: path.resolve(__dirname, '../test-output/java-engine-maven') });
  const lsp = new StdioLsp(launch); t.after(() => lsp.close());
  const rootUri = pathToFileURL(root).href;
  const result = await lsp.request('initialize', {
    processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'rocketbrain-java-fixture' }],
    capabilities: { workspace: { workspaceFolders: true, configuration: true, applyEdit: true }, textDocument: { completion: { completionItem: { snippetSupport: false } }, definition: { linkSupport: true }, rename: { prepareSupport: true }, publishDiagnostics: { relatedInformation: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings: serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]), extendedClientCapabilities: { progressReportProvider: true, classFileContentsSupport: true } }
  }, 90000);
  assert.ok(result.capabilities.completionProvider); assert.ok(result.capabilities.renameProvider);
  lsp.notify('initialized', {});
  const app = path.join(root, 'src/main/java/dev/rocketbrain/App.java'), uri = pathToFileURL(app).href, source = fs.readFileSync(app, 'utf8');
  lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'java', version: 1, text: source } });
  const completion = await until(async () => {
    const response = await lsp.request('textDocument/completion', { textDocument: { uri }, position: positionOf(source, 'greeter.greet', 'greeter.'.length) });
    const items = Array.isArray(response) ? response : response?.items;
    return items?.some(item => item.label.startsWith('greet')) ? items : false;
  });
  const definition = await until(async () => {
    const response = await lsp.request('textDocument/definition', { textDocument: { uri }, position: positionOf(source, 'greeter.greet', 'greeter.'.length + 1) });
    return response?.some(item => (item.uri || item.targetUri || '').endsWith('/Greeter.java')) ? response : false;
  });
  const rename = await lsp.request('textDocument/rename', { textDocument: { uri }, position: positionOf(source, 'greeter.greet', 'greeter.'.length + 1), newName: 'welcome' });
  const edits = rename.documentChanges || Object.entries(rename.changes || {}).map(([editUri, value]) => ({ textDocument: { uri: editUri }, edits: value }));
  assert.ok(edits.some(item => item.textDocument?.uri.endsWith('/Greeter.java')));
  assert.ok(edits.some(item => item.textDocument?.uri.endsWith('/App.java')));
  const libraryDefinition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: positionOf(source, 'String[]', 1) });
  const libraryUri = libraryDefinition?.[0]?.uri || libraryDefinition?.[0]?.targetUri;
  assert.ok(libraryUri?.startsWith('jdt:'), 'Library navigation supplies a jdt virtual document');
  const librarySource = await lsp.request('java/classFileContents', { uri: libraryUri });
  assert.ok(typeof librarySource === 'string' && /class String\b/.test(librarySource));
  const broken = source.replace('Greeter greeter = new Greeter();', 'Greeter greeter = new Greeter();\n        int broken = "wrong";');
  lsp.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] });
  const equivalentUri = value => process.platform === 'win32' ? decodeURIComponent(value).toLowerCase() === decodeURIComponent(uri).toLowerCase() : value === uri;
  const diagnostics = await until(() => lsp.notifications.filter(item => item.method === 'textDocument/publishDiagnostics' && equivalentUri(item.params.uri)).at(-1)?.params.diagnostics.find(item => item.severity === 1 && /(?:String|int|convert|mismatch)/i.test(item.message)));
  const projects = await lsp.request('workspace/executeCommand', { command: 'java.project.getAll', arguments: [] });
  assert.ok(Array.isArray(projects) && projects.some(project => String(project).includes('maven')));
  const report = { engine: 'Eclipse JDT LS 1.63.0', jdk: javaHome, serverPath, project: root, checks: ['Maven project imported', 'member completion', 'definition to another Java file', 'cross-file rename edits', 'JDK virtual document source', 'type mismatch diagnostic'], completionSample: completion.find(item => item.label.startsWith('greet')).label, definition, libraryUri, renameDocuments: edits.map(item => item.textDocument?.uri), diagnostic: diagnostics.message, projects };
  fs.mkdirSync(path.resolve(__dirname, '../test-output'), { recursive: true }); fs.writeFileSync(path.resolve(__dirname, '../test-output/java-engine.json'), JSON.stringify(report, null, 2));
});

