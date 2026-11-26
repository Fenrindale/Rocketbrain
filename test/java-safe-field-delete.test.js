'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { test } = require('node:test');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { registerJavaSafeDelete } = require('../src/java/safe-delete');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { rangeAt } = require('../src/spring/java');
const { execute } = require('../src/java/testing/provision');
const { jdbcOptions } = require('./helpers/coroutine-watch-fixture');
const { StdioLsp, until, positionOf } = require('./helpers/stdio-lsp');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SAFE_FIELD_JDBC_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_SAFE_FIELD_' + engine.toUpperCase() + '_CONFIG']]);
const qualifiedOwner = 'fixture.fielddelete.FieldDeleteService';
const fixturePath = path.join(__dirname, 'fixtures/java/safe-field-delete/FieldDeleteService.java');

function editorHarness(root, lsp) {
  const documents = new Map(), commands = new Map();
  const uri = file => ({ scheme: 'file', fsPath: file, query: '', fragment: '', toString: () => pathToFileURL(file).href });
  const parse = value => value.startsWith('file:') ? uri(fileURLToPath(value)) : new URL(value);
  const at = (text, position) => text.split('\n').slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
  const workspace = {
    isTrusted: true,
    get textDocuments() { return [...documents.values()]; },
    getWorkspaceFolder: value => value?.scheme === 'file' && (value.fsPath === root || value.fsPath.startsWith(root + path.sep)) ? { uri: uri(root) } : undefined,
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    async openTextDocument(value) {
      if (value.scheme !== 'file') return { uri: value, getText: () => '' };
      if (!documents.has(value.fsPath)) {
        const text = await fs.readFile(value.fsPath, 'utf8');
        const doc = { uri: value, languageId: value.fsPath.endsWith('.java') ? 'java' : 'plaintext',
          version: 1, isDirty: false, isClosed: false, text,
          getText() { return this.text; },
          async save() { await fs.writeFile(value.fsPath, this.text); this.isDirty = false; return true; }
        };
        documents.set(value.fsPath, doc);
        if (doc.languageId === 'java') lsp.notify('textDocument/didOpen', { textDocument: {
          uri: value.toString(), languageId: doc.languageId, version: doc.version, text
        } });
      }
      return documents.get(value.fsPath);
    },
    async applyEdit(edit) {
      for (const [value, changes] of edit.entries) {
        const doc = await workspace.openTextDocument(value);
        assert.equal(changes.length, 1);
        const change = changes[0];
        doc.text = doc.text.slice(0, at(doc.text, change.range.start)) + change.newText + doc.text.slice(at(doc.text, change.range.end));
        doc.version++;
        doc.isDirty = true;
        lsp.notify('textDocument/didChange', { textDocument: { uri: value.toString(), version: doc.version }, contentChanges: [{ text: doc.text }] });
      }
      return true;
    }
  };
  const vscode = { workspace, Uri: { file: uri, parse },
    Range: class { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
    TextEdit: class { constructor(range, newText) { Object.assign(this, { range, newText }); } },
    WorkspaceEdit: class { entries = []; set(value, edits) { this.entries.push([value, edits]); } },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name); } }; },
      async executeCommand(name) { assert.equal(name, 'vscode.diff'); } },
    window: { async showTextDocument() {}, async showInformationMessage(_message, _options, action) { return action; },
      showErrorMessage(message) { throw Error(message); } }
  };
  return { vscode, commands };
}

const reader = [
  'package fixture.fielddelete;',
  'import java.util.Map;',
  'import org.springframework.context.annotation.AnnotationConfigApplicationContext;',
  'import org.springframework.core.env.MapPropertySource;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class SpringFieldRuntime {',
  '    public static void main(String[] args) throws Exception {',
  '        try (var context = new AnnotationConfigApplicationContext()) {',
  '            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test",',
  '                Map.of("rocketbrain.safe-field.binding", 71)));',
  '            context.register(FieldDeleteService.class);',
  '            context.refresh();',
  '            var service = context.getBean(FieldDeleteService.class);',
  '            var injected = FieldDeleteService.class.getDeclaredField("injectedOnlyBySpring");',
  '            if (!injected.trySetAccessible()) throw new AssertionError("test fixture field unavailable");',
  '            var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_COROUTINE_JDBC_URL"),',
  '                System.getenv("RB_COROUTINE_JDBC_USER"), System.getenv("RB_COROUTINE_JDBC_PASSWORD")));',
  '            String vendor = jdbc.queryForObject("SELECT VERSION()", String.class);',
  '            int people = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);',
  '            boolean obsolete = java.util.Arrays.stream(FieldDeleteService.class.getDeclaredFields())',
  '                .anyMatch(field -> field.getName().startsWith("obsolete"));',
  '            System.out.println("FIELD_JDBC:" + vendor + "|" + people + "|" + service.currentValue() + "|"',
  '                + service.initializationEffects() + "|" + injected.getInt(service) + "|" + obsolete);',
  '        }',
  '    }',
  '}',
  ''
].join('\n');

async function verifySpringRuntime(owned, javaHome, target, phase, engine, configFile) {
  const directory = path.join(owned, engine + '-' + phase);
  await fs.mkdir(directory);
  const runner = path.join(directory, 'SpringFieldRuntime.java');
  await fs.writeFile(runner, reader, { flag: 'wx' });
  const { classpath, env } = await jdbcOptions({ engine, classpathFile, configFile });
  const dependencies = new Set(['spring-context-7.0.10.jar', 'spring-expression-7.0.10.jar', 'spring-aop-7.0.10.jar']);
  const context = (await fs.readFile(classpathFile, 'utf8')).trim().split(path.delimiter).filter(file => dependencies.has(path.basename(file)));
  assert.deepEqual(new Set(context.map(file => path.basename(file))), dependencies);
  const java = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const jars = [...classpath, ...context].join(path.delimiter);
  const result = await execute(java('javac'), ['-proc:none', '-encoding', 'UTF-8', '-classpath', jars, '-d', directory, runner, target],
    { timeoutMs: 30000 });
  assert.equal(result.code, 0, result.output);
  const run = await execute(java('java'), ['-classpath', directory + path.delimiter + jars, 'fixture.fielddelete.SpringFieldRuntime'],
    { timeoutMs: 30000, env: { ...process.env, ...env } });
  assert.equal(run.code, 0, run.output);
  const report = /FIELD_JDBC:([^|\r\n]+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(true|false)/u.exec(run.output);
  assert.ok(report, run.output);
  assert.match(report[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.deepEqual(report.slice(2), ['2', '42', '1', '71', phase === 'before' ? 'true' : 'false']);
  return { engine, server: report[1], people: 2, value: 42, initializerEffects: 1, injectedBySpring: 71,
    obsoleteFieldsPresent: report[6] === 'true' };
}

test('actual JDT Safe Delete removes only unused private fields and preserves Spring injection and JDBC', {
  skip: !(runtimeFile && classpathFile && dbFiles.every(([, file]) => file)) && 'Configure the owned Spring database fixtures and the JDT runtime.',
  timeout: 300000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-safe-field-delete-'));
  t.after(async () => {
    const physical = await fs.realpath(owned);
    assert.equal(path.relative(physical, owned), '');
    assert.equal(path.relative(path.dirname(physical), parent), '');
    assert.match(path.basename(physical), /^rb-safe-field-delete-/u);
    await fs.rm(physical, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  const root = path.join(owned, 'spring');
  const target = path.join(root, 'src/main/java/fixture/fielddelete/FieldDeleteService.java');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const original = await fs.readFile(fixturePath, 'utf8');
  await fs.writeFile(target, original, { flag: 'wx' });
  const pom = [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    '<modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>safe-field-delete</artifactId><version>1.0</version>',
    '<properties><maven.compiler.release>25</maven.compiler.release></properties>',
    '<dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-context</artifactId><version>7.0.10</version></dependency></dependencies>',
    '</project>'
  ].join('\n');
  await fs.writeFile(path.join(root, 'pom.xml'), pom, { flag: 'wx' });
  const before = await Promise.all(dbFiles.map(([engine, config]) => verifySpringRuntime(owned, runtime.javaHome, target, 'before', engine, config)));
  const uri = pathToFileURL(root).href;
  const settings = serverSettings([{ name: 'JavaSE-25', path: runtime.javaHome, default: true }]);
  const lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
  const { vscode, commands } = editorHarness(root, lsp);
  const request = (method, params) => lsp.request(method, params);
  let refactoring, safeDelete;
  try {
    await lsp.request('initialize', {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'owned-safe-field-delete' }],
      capabilities: { workspace: { configuration: true }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      initializationOptions: { bundles: [], workspaceFolders: [uri], settings }
    }, 75000);
    lsp.notify('initialized', {});
    await until(async () => {
      const result = await request('workspace/executeCommand', { command: 'java.project.getSettings',
        arguments: [vscode.Uri.file(target).toString(), ['org.eclipse.jdt.ls.core.sourcePaths']] });
      return result?.['org.eclipse.jdt.ls.core.sourcePaths']?.some(folder => path.basename(folder) === 'java');
    }, 60000);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    refactoring = registerJavaRefactoring({}, vscode, { request });
    safeDelete = registerJavaSafeDelete({}, vscode, { request, refactoring });
    const position = name => positionOf(doc.getText(), name, 1);
    const verifyRefusal = async (name, finding) => {
      const report = await safeDelete.inspect(doc, position(name));
      assert.equal(report.candidate.kind, 'field');
      const { springAnalysis: analysis } = report;
      assert.notEqual(analysis.verdict, 'allowed');
      const reason = [...analysis.conflicts, ...analysis.unknowns].find(item => item.kind === finding);
      assert.ok(reason, JSON.stringify({ name, conflicts: analysis.conflicts, unknowns: analysis.unknowns }));
      assert.equal(path.relative(fileURLToPath(reason.uri), target), '');
      assert.ok(reason.range && Number.isInteger(reason.range.start.line));
      await assert.rejects(safeDelete.prepare(doc, position(name)), { code: 'ROCKETBRAIN_SAFE_DELETE_CONFLICT' });
      assert.equal(doc.getText(), original);
      return { name, finding, javaReferences: analysis.javaReferences, sourceSpan: reason.range };
    };
    const denied = [
      await verifyRefusal('injectedOnlyBySpring', 'spring.framework-entrypoint'),
      await verifyRefusal('referencedCount', 'java.semantic-reference'),
      await verifyRefusal('adjacentFirst', 'declaration.contract'),
      await verifyRefusal('adjacentSecond', 'declaration.contract'),
      await verifyRefusal('effectfulField', 'declaration.contract')
    ];
    assert.equal(denied[0].javaReferences, 0);
    assert.ok(denied[1].javaReferences >= 2);
    assert.equal(denied[4].javaReferences, 0);
    const stale = await safeDelete.prepare(doc, position('obsoletePreviewCount'));
    await fs.appendFile(path.join(root, 'pom.xml'), '\n<!-- changed after review -->');
    await assert.rejects(safeDelete.apply(stale.id), /file set changed/);
    assert.deepEqual(await fs.readFile(target, 'utf8'), original);
    await fs.writeFile(path.join(root, 'pom.xml'), pom);

    const command = commands.get('rocketbrain.java.safeDelete');
    assert.equal(typeof command, 'function');
    let expected = original;
    for (const [name, declaration] of [['obsoletePreviewCount', 'private int obsoletePreviewCount;'],
      ['obsoleteStaticNote', 'private static String obsoleteStaticNote;']]) {
      const review = await safeDelete.inspect(doc, position(name));
      assert.deepEqual(review.springAnalysis.declaration, {
        uri: doc.uri.toString(), name, kind: 'field',
        range: rangeAt(expected, expected.indexOf(name), expected.indexOf(name) + name.length), owner: qualifiedOwner
      });
      assert.equal(review.springAnalysis.verdict, 'allowed', JSON.stringify(review.springAnalysis.unknowns));
      vscode.window.activeTextEditor = { document: doc, selection: { active: position(name) } };
      assert.equal((await command()).state, 'applied');
      expected = expected.replace(declaration, '');
      assert.equal(doc.getText(), expected);
      await doc.save();
    }
    assert.equal(await fs.readFile(target, 'utf8'), expected);
    const after = await Promise.all(dbFiles.map(([engine, config]) => verifySpringRuntime(owned, runtime.javaHome, target, 'after', engine, config)));
    if (process.env.ROCKETBRAIN_SAFE_FIELD_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SAFE_FIELD_RECEIPT, JSON.stringify({
      before, after, denied, removed: ['obsoletePreviewCount', 'obsoleteStaticNote'], oneReviewPerDeclaration: true,
      normalCommand: true, staleDiskRefused: true, exactRemainingSource: true
    }, null, 2) + '\n', { flag: 'wx' });
  } finally {
    await safeDelete?.dispose();
    await refactoring?.dispose();
    await lsp.close();
  }
});
