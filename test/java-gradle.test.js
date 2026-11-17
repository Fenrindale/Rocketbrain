'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, positionOf, until } = require('./helpers/stdio-lsp');

test('official JDT LS imports a real local Gradle project through Buildship', { skip: !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG || !process.env.ROCKETBRAIN_GRADLE_HOME, timeout: 240000 }, async t => {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const javaHome = config.javaHome || config.settings['rocketbrain.java.javaHome'];
  const serverPath = config.serverPath || config.settings['rocketbrain.java.serverPath'];
  const gradleHome = process.env.ROCKETBRAIN_GRADLE_HOME;
  const root = path.join(__dirname, 'integration/java-gradle');
  const launch = resolveLaunch({ javaHome, serverPath, storagePath: path.resolve(__dirname, '../test-output/java-engine-gradle') });
  launch.options.env.GRADLE_USER_HOME = path.resolve(__dirname, '../test-output/java-gradle-user-home');
  const lsp = new StdioLsp(launch); t.after(() => lsp.close());
  const rootUri = pathToFileURL(root).href;
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }], { gradleHome, gradleJavaHome: javaHome });
  settings.java.import.gradle.wrapper.enabled = false;
  settings.java.import.gradle.offline = { enabled: true };
  await lsp.request('initialize', {
    processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'rocketbrain-gradle-fixture' }],
    capabilities: { workspace: { workspaceFolders: true, configuration: true }, textDocument: { completion: { completionItem: { snippetSupport: false } }, definition: { linkSupport: true } } },
    initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings, extendedClientCapabilities: { progressReportProvider: true } }
  }, 90000);
  lsp.notify('initialized', {});
  const file = path.join(root, 'src/main/java/dev/rocketbrain/gradle/Application.java');
  const uri = pathToFileURL(file).href, source = fs.readFileSync(file, 'utf8');
  lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'java', version: 1, text: source } });
  const projects = await until(async () => {
    const result = await lsp.request('workspace/executeCommand', { command: 'java.project.getAll', arguments: [] });
    return Array.isArray(result) && result.some(project => decodeURIComponent(String(project)).includes('java-gradle')) ? result : false;
  }, 120000);
  const definition = await until(async () => {
    const response = await lsp.request('textDocument/definition', { textDocument: { uri }, position: positionOf(source, 'GreetingService', 2) });
    return response?.some(item => (item.uri || item.targetUri || '').endsWith('/GreetingService.java')) ? response : false;
  });
  const report = { engine: 'Eclipse JDT LS 1.63.0 / Eclipse Buildship', javaHome, gradleHome, root, projects, checks: ['Gradle project import through local distribution', 'cross-file Java definition in imported Gradle source set'], definition, caveat: 'Small single-project Java fixture without remote dependencies; not composite/Android/Kotlin DSL parity.' };
  fs.writeFileSync(path.resolve(__dirname, '../test-output/java-engine-gradle.json'), JSON.stringify(report, null, 2));
  assert.ok(definition.length);
});
