'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerJavaSafeDelete } = require('../src/java/safe-delete');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { readLifecycleXml, resourceEntry, selfContainedJarIndex } = require('../src/java/spring-xml-lifecycle');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { headlessHost } = require('./helpers/java-signature-jdt-host');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { xml, inheritedXml, bean, config, owner, entry, beanPath, configPath, markers, populateResourceLifecycle, jarResource, createJar,
  runXmlLifecycle, assertXmlCallback, position, maven } = require('./helpers/spring-xml-lifecycle-fixture');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome = process.env.ROCKETBRAIN_XML_LIFECYCLE_MAVEN_HOME;
const engines = ['mysql', 'mariadb'].map(engine =>
  [engine, process.env['ROCKETBRAIN_XML_LIFECYCLE_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('archived Spring XML reads exact literal callback ranges and rejects dynamic or ambiguous grammar', () => {
  assert.equal(resourceEntry('classpath:' + entry), entry);
  for (const location of ['classpath*:' + entry, 'classpath:/' + entry, 'classpath:../settings.xml',
    'classpath:%2e%2e/settings.xml', 'classpath:${config}.xml', 'classpath:fixture/*-bean.xml', 'file:' + entry,
    'classpath:backup.groovy']) assert.equal(resourceEntry(location), undefined, location);
  const callbacks = readLifecycleXml(Buffer.from(xml), owner);
  assert.deepEqual(callbacks.map(item => [item.owner, item.attribute, item.name]), [
    [owner, 'init-method', markers.init], [owner, 'destroy-method', markers.destroy]
  ]);
  for (const callback of callbacks) {
    const line = xml.split('\n')[callback.range.start.line];
    assert.equal(line.slice(callback.range.start.character, callback.range.end.character), callback.name);
  }
  const withBean = suffix => xml.replace('</beans>', suffix + '</beans>');
  for (const candidate of [
    xml.replace('<beans', '<!DOCTYPE beans SYSTEM "file:///unknown"><beans'),
    xml.replace('https://www.springframework.org/schema/beans/spring-beans.xsd', 'https://unknown.test/custom.xsd'),
    xml.replace('init-method=', 'factory-method='),
    xml.replace('init-method=', 'parent='),
    xml.replace('xmlns:xsi=', 'xmlns:custom="urn:other" xmlns:xsi='),
    xml.replace(markers.init, '&#119;armFromJar'),
    xml.replace(markers.init, '${unknown}'),
    xml.replace(owner, 'fixture.other.CompetingBean'),
    withBean('<import resource="another.xml"/>'),
    withBean('<bean id="externalXmlBean" class="' + owner + '"/>'),
    withBean('<![CDATA[extra]]>'),
    withBean('<?transform resource="unknown"?>')
  ]) assert.throws(() => readLifecycleXml(Buffer.from(candidate), owner), /unsupported-xml/u, candidate);
});

test('Spring XML resolves same-document abstract parents and preserves exact overridden callback provenance', () => {
  const callbacks = readLifecycleXml(Buffer.from(inheritedXml), owner);
  assert.deepEqual(callbacks.map(({ id, declaredOn, name, templateOnly }) => [id, declaredOn, name, templateOnly]), [
    ['externalXmlBean', 'lifecycleBase', markers.init, undefined],
    ['externalXmlBean', 'lifecycleChild', markers.inheritedDestroy, undefined],
    ['lifecycleBase', undefined, markers.destroy, true]
  ]);
  for (const candidate of [
    inheritedXml.replace('parent="lifecycleBase"', 'parent="missingParent"'),
    inheritedXml.replace('abstract="true" class=', 'abstract="true" parent="lifecycleChild" class='),
    inheritedXml.replace('parent="lifecycleBase"', 'parent="lifecycle&#66;ase"'),
    inheritedXml.replace('abstract="true"', 'abstract="${abstractTemplate}"'),
    inheritedXml.replace('destroy-method="' + markers.inheritedDestroy + '"', 'destroy-method=""'),
    inheritedXml.replace('parent="lifecycleChild"', 'parent="lifecycleChild" class="fixture.other.CompetingBean"')
  ]) assert.throws(() => readLifecycleXml(Buffer.from(candidate), owner), /unsupported-xml/u, candidate);
});

test('legacy JAR index metadata may name the same archive only', () => {
  const file = path.join('fixtures', 'driver.jar');
  const current = 'JarIndex-Version: 1.0\n\ndriver.jar\ncom\ncom/vendor\n';
  assert.equal(selfContainedJarIndex(Buffer.from(current), file), true);
  for (const text of [current + '\nneighbor.jar\nassets\n', current + 'neighbor.jar\nassets\n',
    current.replace('driver.jar', '../driver.jar'), current.replace('driver.jar', 'another.jar')]) {
    assert.equal(selfContainedJarIndex(Buffer.from(text), file), false);
  }
});

test('actual Safe Delete proves inherited private callbacks from an imported JAR XML and keeps Spring JDBC behavior', {
  skip: !javaConfig || !mavenHome || !engines.every(([, file]) => file), timeout: 320000
}, async context => {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-xml-lifecycle-'));
  const root = path.join(owned, 'project');
  const runtime = await read(javaConfig);
  const tools = { javaHome: runtime.javaHome, mavenHome };
  let lsp, safeDelete, refactoring;
  context.after(async () => {
    await safeDelete?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    const real = await fs.realpath(owned);
    assert.equal(path.relative(owned, real), '');
    assert.equal(path.relative(path.dirname(real), parent), '');
    assert.match(path.basename(real), /^rb-xml-lifecycle-/u);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const fixture = await populateResourceLifecycle(root, path.join(owned, 'aux'), tools, { addEclipse: true, resource: inheritedXml });
  const databases = await Promise.all(engines.map(async ([engine, file]) => [engine, await read(file)]));
  const runBoth = () => Promise.all(databases.map(([engine, database]) => runXmlLifecycle(fixture, tools, database, engine, '42:7:777')));
  const before = await runBoth();
  const settings = serverSettings([{ name: 'JavaSE-25', path: tools.javaHome, default: true }]);
  settings.java.autobuild.enabled = false;
  const rootUri = pathToFileURL(root).href;
  lsp = new StdioLsp(resolveLaunch({ javaHome: tools.javaHome, serverPath: runtime.serverPath, storagePath: path.join(owned, 'jdt') }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'resource-lifecycle' }],
    capabilities: { workspace: { configuration: true }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { workspaceFolders: [rootUri], settings } }, 75000);
  lsp.notify('initialized', {});
  lsp.notify('workspace/didChangeConfiguration', { settings });
  const host = headlessHost(root, { notify(method, packet) {
    if (packet.textDocument?.uri.endsWith('.java')) lsp.notify(method, packet);
  } });
  const open = file => host.workspace.openTextDocument(host.vscode.Uri.file(path.join(root, file)));
  const document = await open(beanPath), configuration = await open(configPath);
  await until(async () => {
    const facts = await lsp.request('workspace/executeCommand', { command: 'java.project.getClasspaths',
      arguments: [document.uri.toString(), { scope: 'runtime' }] });
    return facts?.projectRoot && facts.classpaths.some(file => file.endsWith('xml-entrypoints.jar'));
  }, 85000);
  let additionalArchive;
  const request = async (method, params) => {
    const response = await lsp.request(method, params);
    if (additionalArchive && params.command === 'java.project.getClasspaths' && response?.classpaths) {
      return { ...response, classpaths: [...response.classpaths, additionalArchive] };
    }
    return response;
  };
  const storagePath = path.join(owned, 'compiler');
  const extension = { globalStorageUri: host.vscode.Uri.file(storagePath) };
  refactoring = registerJavaRefactoring(extension, host.vscode, { request });
  safeDelete = registerJavaSafeDelete(extension, host.vscode, { request, refactoring, runtime: () => ({ javaHome: tools.javaHome, storagePath }) });
  const inspect = async name => (await safeDelete.inspect(document, position(document, name))).springAnalysis;
  const prepare = name => safeDelete.prepare(document, position(document, name));
  const inspected = [
    assertXmlCallback(await inspect(markers.init), markers.init, 'init-method', inheritedXml),
    assertXmlCallback(await inspect(markers.inheritedDestroy), markers.inheritedDestroy, 'destroy-method', inheritedXml),
    assertXmlCallback(await inspect(markers.destroy), markers.destroy, 'destroy-method', inheritedXml)
  ];
  assert.deepEqual(inspected.slice(0, 2).map(({ beanId, declaredOn }) => [beanId, declaredOn]),
    [['externalXmlBean', 'lifecycleBase'], ['externalXmlBean', 'lifecycleChild']]);
  assert.equal(inspected[2].templateOnly, true);
  await assert.rejects(prepare(markers.init), error => error.code === 'ROCKETBRAIN_SAFE_DELETE_CONFLICT' &&
    error.springAnalysis.conflicts.some(item => item.kind === 'spring.binary-xml-lifecycle'));
  await assert.rejects(prepare(markers.inheritedDestroy), { code: 'ROCKETBRAIN_SAFE_DELETE_CONFLICT' });
  assert.equal(document.getText(), bean);
  assert.equal(host.submitted.length, 0);

  additionalArchive = path.join(owned, 'competing.jar');
  await fs.copyFile(fixture.archive, additionalArchive);
  let refused = await inspect(markers.helper);
  assert.equal(refused.verdict, 'unknown');
  assert.equal(refused.binaryResourceLifecycle.reason, 'competing-classpath-jar-resource');
  additionalArchive = path.join(owned, 'competing-owner.jar');
  await createJar(tools, additionalArchive, path.join(root, 'target', 'classes'), owner.replaceAll('.', '/') + '.class');
  refused = await inspect(markers.helper);
  assert.equal(refused.verdict, 'unknown');
  assert.equal(refused.binaryResourceLifecycle.reason, 'competing-classpath-jar-owner');
  additionalArchive = undefined;

  const original = await fs.readFile(fixture.archive);
  try {
    await jarResource(fixture, tools, inheritedXml.replace('</beans>', '<import resource="more.xml"/></beans>'));
    refused = await inspect(markers.helper);
    assert.equal(refused.verdict, 'unknown');
    assert.equal(refused.binaryResourceLifecycle.reason, 'no-reviewed-resource');
  } finally {
    await fs.writeFile(fixture.archive, original);
  }
  async function saveConfiguration(text) {
    configuration.text = text;
    configuration.version++;
    configuration.isDirty = true;
    lsp.notify('textDocument/didChange', { textDocument: { uri: configuration.uri.toString(), version: configuration.version },
      contentChanges: [{ text }] });
    await host.save();
  }
  await saveConfiguration(config.replace('@ImportResource("classpath:' + entry + '")', '@ImportResource(DependencyXmlConfig.RESOURCE)')
    .replace('public class DependencyXmlConfig {}', 'public class DependencyXmlConfig { static final String RESOURCE = "classpath:' + entry + '"; }'));
  refused = await inspect(markers.helper);
  assert.equal(refused.verdict, 'unknown');
  assert.equal(refused.binaryResourceLifecycle.reason, 'unsupported-resource-location');
  await saveConfiguration(config);

  const stale = await prepare(markers.helper);
  assert.equal(stale.springAnalysis.binaryResourceLifecycle.state, 'inspected');
  try {
    await fs.appendFile(fixture.archive, Buffer.from([0]));
    await assert.rejects(safeDelete.apply(stale.id), /classpath changed after signature inspection/u);
  } finally {
    await fs.writeFile(fixture.archive, original);
  }
  const staleShadow = await prepare(markers.helper);
  const classpath = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
    arguments: [document.uri.toString(), { scope: 'runtime' }] });
  const outputs = [path.join(root, 'target', 'classes'), path.join(root, 'bin')];
  const compiledOutput = classpath.classpaths.find(file => outputs.some(folder => path.relative(file, folder) === ''));
  assert.ok(compiledOutput, 'Expected a JDT observed output for the owned fixture');
  const shadow = path.join(compiledOutput, entry);
  await fs.mkdir(path.dirname(shadow), { recursive: true });
  try {
    await fs.writeFile(shadow, xml, { flag: 'wx' });
    await assert.rejects(safeDelete.apply(staleShadow.id), /competing-classpath-directory-resource/u);
  } finally {
    await fs.rm(shadow, { force: true });
  }
  const review = await prepare(markers.helper);
  assert.equal(review.springAnalysis.verdict, 'allowed');
  assert.equal((await safeDelete.apply(review.id)).state, 'applied');
  assert.equal(host.submitted.length, 1);
  assert.doesNotMatch(document.getText(), /unreferencedLocalHelper/u);
  await host.save();
  await maven(tools, root, ['compile']);
  const after = await runBoth();
  assert.deepEqual(after, before);
  if (process.env.ROCKETBRAIN_XML_LIFECYCLE_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_XML_LIFECYCLE_RECEIPT, JSON.stringify({ inspected, before, after,
      duplicateRefused: true, competingOwnerRefused: true, unsupportedXmlRefused: true, computedSourceRefused: true, staleJarRefused: true,
      staleClasspathShadowRefused: true, unreferencedApplied: true, noProjectCodeDuringReview: true }, null, 2) + '\n', { flag: 'wx' });
  }
});
