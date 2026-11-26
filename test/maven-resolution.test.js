'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { parseMavenResolution } = require('../src/java/maven-resolution');
const { registerMavenResolution } = require('../src/java/maven-resolution-vscode');
const { populateMavenMediation, compileMavenProbe, runMavenProbe, resolutionAssertion } =
  require('./helpers/maven-resolution-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome = process.env.ROCKETBRAIN_MVN_MEDIATION_HOME;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_MVN_MEDIATION_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('Maven verbose output preserves classifier-specific winners, reasons and nested paths', () => {
  const result = parseMavenResolution([
    'fixture:app:jar:1',
    '+- group:artifact:jar:tests:2:test',
    '+- group:host:jar:3:compile',
    '|  +- (group:artifact:jar:tests:1:test - omitted for conflict with 2)',
    '|  \\- group:managed:jar:3:compile (version managed from 2; scope managed from runtime)',
    '\\- group:artifact:jar:4:runtime', ''
  ].join('\n'));
  assert.equal(result.nodes.length, 5);
  assert.equal(result.nodes[2].winnerId, result.nodes[0].id);
  assert.equal(result.nodes[2].parentId, result.nodes[1].id);
  assert.equal(result.nodes[3].managedFrom, '2');
  assert.equal(result.nodes[4].classifier, '');
  assert.throws(() => parseMavenResolution('g:a:jar:1\n|  +- g:b:jar:2:compile'), /incomplete dependency path/u);
  assert.throws(() => parseMavenResolution('g:a:jar:1\n+- (g:b:jar:2:compile)'), /why this dependency was omitted/u);
});

function headlessHost(root, projects, tools) {
  const opened = [], displayed = [], documents = [];
  const uri = value => ({ scheme: value.startsWith('file:') ? 'file' : 'rocketbrain-maven-resolution',
    fsPath: value.startsWith('file:') ? fileURLToPath(value) : undefined, path: new URL(value).pathname,
    toString: () => value });
  let provider;
  const vscode = {
    Uri: { parse: uri },
    Range: class { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
    workspace: {
      textDocuments: documents,
      getWorkspaceFolder: () => ({ uri: uri(pathToFileURL(root).href) }),
      registerTextDocumentContentProvider(_scheme, handler) {
        provider = handler;
        return { dispose() {} };
      },
      async openTextDocument(address) {
        opened.push(address);
        return { uri: address, getText: () => address.scheme === 'file' ? '' : provider.provideTextDocumentContent(address) };
      }
    },
    window: { async showTextDocument(document, options) { displayed.push({ document, options }); return displayed.at(-1); } }
  };
  return { opened, displayed, documents, service: registerMavenResolution(vscode, { trusted() {}, generation: () => 0,
    ensureProject: async value => projects.find(project => project.uri === value), getTools: () => tools }) };
}

test('actual Maven resolves and builds nearest and managed Spring JDBC paths on both owned databases', {
  skip: !runtimeFile || !mavenHome || !engines.every(([, file]) => file), timeout: 300000
}, async t => {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'rb-mvn-mediation-'));
  const runtime = await read(runtimeFile);
  const tools = { javaHome: runtime.javaHome, mavenHome };
  let host;
  t.after(async () => {
    await host?.service.dispose();
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), base);
    assert.match(path.basename(root), /^rb-mvn-mediation-/u);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const projects = await Promise.all(['nearest', 'managed'].map(mode => populateMavenMediation(path.join(root, mode), mode)));
  const databases = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
  host = headlessHost(root, projects, tools);
  const checks = [];
  await assert.rejects(host.service.inspect({ projectUri: projects[0].uri }), /before executing project code/u);
  for (const [index, mode] of ['nearest', 'managed'].entries()) {
    const project = projects[index], pomFile = path.join(project.root, 'pom.xml');
    const inspect = () => host.service.inspect({ projectUri: project.uri, allowProjectExecution: true });
    const original = await fs.readFile(pomFile, 'utf8');
    const report = await inspect();
    const { selected, omitted, sourceKind } = resolutionAssertion(report, mode);
    const anchor = await host.service.openPom(report.id, selected.id);
    assert.equal(anchor.kind, sourceKind);
    assert.equal(fileURLToPath(anchor.uri), pomFile);
    const line = original.split('\n')[anchor.range.start.line];
    assert.match(line, /<groupId>org\.jspecify<\/groupId><artifactId>jspecify<\/artifactId><version>1\.0\.0<\/version>/u);
    const visual = await host.service.showReport(report.id, omitted?.id || selected.id);
    assert.match(visual.document.getText(), /jspecify:jar:1\.0\.0:compile/u);
    if (omitted) assert.match(visual.document.getText(), /omitted · conflict with 1\.0\.0/u);
    else assert.match(visual.document.getText(), /version managed from 1\.0\.1/u);
    const classpath = await compileMavenProbe(project, tools);
    const actual = await Promise.all(databases.map(([engine, database]) =>
      runMavenProbe({ project, tools, classpath, database, engine })));
    await fs.appendFile(pomFile, '<!-- changed after observing -->\n');
    await assert.rejects(host.service.openPom(report.id, selected.id), /descriptors changed/u);
    await fs.writeFile(pomFile, original);
    checks.push({ mode, winner: selected.version, omitted: omitted?.version || null, managedFrom: selected.managedFrom || null,
      sourceKind, actual });
  }
  if (process.env.ROCKETBRAIN_MVN_MEDIATION_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_MVN_MEDIATION_RECEIPT,
    JSON.stringify({ maven: '3.9.11', plugin: '3.11.0', checks, stalePomRejected: true }, null, 2) + '\n');
});
