'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isPlainQualifiedCall } = require('../src/java/definition-position');
const { registerSemanticSpring } = require('../src/spring/vscode');
const { registerJPAFeatures } = require('../src/jpa/vscode');

function sourceDocument(text, uri) {
  const lines = text.split('\n');
  return {
    uri,
    languageId: 'java',
    getText: () => text,
    lineAt: line => ({ text: lines[line] }),
    offsetAt: position => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
    positionOf(needle, shift = 0) {
      const index = text.indexOf(needle);
      assert.notEqual(index, -1, needle);
      const prefix = text.slice(0, index + shift);
      return { line: prefix.split('\n').length - 1, character: prefix.length - prefix.lastIndexOf('\n') - 1 };
    }
  };
}

test('the ordinary Java call guard retains annotations, query text and method declarations', () => {
  const document = sourceDocument([
    '@example.Inject(value = helper.inAnnotation()) class Demo {',
    '  Object run() { return this.service.load(); }',
    '  int countByName(String name);',
    '  Object build() { return new packages.Widget(); }',
    '  String quoted = "service.inString()";',
    '  String block = """',
    '     service.inBlock()',
    '     """;',
    '  // service.inComment()',
    '}'
  ].join('\r\n'));
  assert.equal(isPlainQualifiedCall(document, document.positionOf('load()')), true);
  for (const needle of ['Inject(', 'inAnnotation()', 'countByName(', 'Widget()', 'inString()', 'inBlock()', 'inComment()']) {
    assert.equal(isPlainQualifiedCall(document, document.positionOf(needle)), false, needle);
  }
  const escaped = sourceDocument('class T { int f() { return this.service.load(); } } // \\u000a');
  assert.equal(isPlainQualifiedCall(escaped, escaped.positionOf('load()')), false);
});

function mockHost(files, pending) {
  const providers = [], calls = [], disposable = () => ({ dispose() {} });
  class EventEmitter {
    event = disposable;
    fire() {}
    dispose() {}
  }
  class Range {
    constructor(sl, sc, el, ec) {
      this.start = { line: sl, character: sc };
      this.end = { line: el, character: ec };
    }
  }
  const output = { appendLine() {}, show() {}, dispose() {} };
  const uri = value => ({ path: value.replace(/^file:\/\//, ''), toString: () => value });
  const vscode = {
    EventEmitter, Range, CodeActionKind: { QuickFix: 'quickfix' },
    Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
    Diagnostic: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Uri: { parse: uri },
    commands: { registerCommand: disposable },
    window: { createOutputChannel: () => output },
    languages: {
      createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }),
      registerDefinitionProvider: (_selector, provider) => { providers.push(provider); return disposable(); },
      registerHoverProvider: disposable, registerCompletionItemProvider: disposable,
      registerWorkspaceSymbolProvider: disposable, registerCodeActionsProvider: disposable
    },
    workspace: {
      isTrusted: true, textDocuments: [],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      findFiles: async pattern => {
        calls.push(pattern);
        if (pattern === '**/*.java') await pending;
        const suffix = pattern === '**/*.java' ? '.java' : pattern.startsWith('**/application') ? '.properties' : '.xml';
        return Object.keys(files).filter(value => value.endsWith(suffix)).map(uri);
      },
      fs: {
        stat: async value => ({ size: Buffer.byteLength(files[value.toString()]) }),
        readFile: async value => Buffer.from(files[value.toString()])
      },
      createFileSystemWatcher: () => ({ ...disposable(), onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
      registerTextDocumentContentProvider: disposable, onDidChangeTextDocument: disposable,
      onDidCreateFiles: disposable, onDidDeleteFiles: disposable, onDidRenameFiles: disposable,
      onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable
    }
  };
  return { vscode, output, uri, providers, calls };
}

const sourceUri = 'file:///fixture/Source.java';
const propertiesUri = 'file:///fixture/application.properties';
const source = [
  'package fixture;',
  'import jakarta.persistence.*;',
  'import org.springframework.stereotype.Service;',
  'import org.springframework.data.jpa.repository.JpaRepository;',
  'import org.springframework.data.jpa.repository.Query;',
  '@Service class ServiceBean {',
  '  @org.springframework.beans.factory.annotation.Value("${app.port}") String port;',
  '  String call() { return port.trim(); }',
  '}',
  '@Entity class Person { @Id long id; String displayName; }',
  'interface People extends JpaRepository<Person, Long> {',
  '  Person findByDisplayName(String value);',
  '  @Query("select p from Person p where p.displayName = :value") Person named(String value);',
  '}'
].join('\n');

test('ordinary definition and canceled requests return while JPA source indexing is pending', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = mockHost({ [sourceUri]: source }, pending);
  const spring = registerSemanticSpring(h.vscode, { subscriptions: [] }, h.output);
  const jpa = registerJPAFeatures({ subscriptions: [] }, h.vscode);
  try {
    const document = sourceDocument(source, h.uri(sourceUri));
    const before = h.calls.length;
    const responses = Promise.all(h.providers.flatMap(provider => [
      provider.provideDefinition(document, document.positionOf('trim()'), { isCancellationRequested: false }),
      provider.provideDefinition(document, document.positionOf('findByDisplayName'), { isCancellationRequested: true })
    ]));
    const result = await Promise.race([responses, new Promise(resolve => setImmediate(() => resolve('blocked')))]);
    assert.deepEqual(result, [[], [], [], []]);
    assert.equal(h.calls.length, before, 'The navigation request did not start a Spring scan.');
  } finally {
    spring.dispose();
    jpa.dispose();
    release();
  }
});

test('Spring annotation and JPA declaration or query links still open their intended sources', async t => {
  const h = mockHost({ [sourceUri]: source, [propertiesUri]: 'app.port=4100\n' });
  const spring = registerSemanticSpring(h.vscode, { subscriptions: [] }, h.output);
  const jpa = registerJPAFeatures({ subscriptions: [] }, h.vscode);
  t.after(() => { spring.dispose(); jpa.dispose(); });
  const [springProvider, jpaProvider] = h.providers;
  const document = sourceDocument(source, h.uri(sourceUri));
  const token = { isCancellationRequested: false };

  const springTargets = await springProvider.provideDefinition(document, document.positionOf('Value('), token);
  assert.ok(springTargets.some(target => target.uri.toString() === propertiesUri));
  const attribute = document.positionOf('displayName;');
  for (const position of [document.positionOf('findByDisplayName', 'findBy'.length), document.positionOf('p.displayName', 2)]) {
    const targets = await jpaProvider.provideDefinition(document, position, token);
    assert.ok(targets.some(target => target.uri.toString() === sourceUri && target.range.start.line === attribute.line));
  }
});
