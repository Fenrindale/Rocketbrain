'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { parseDescriptor, reviewPackageServices } = require('../src/java/package-services');
const { proveClasspathPaths, proveLocalBuildMapping } = require('../src/java/package-classpath');
const P = require('../src/java/package-resources');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { zip } = require('./helpers/spring-project-tools-fixture');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const service = 'sample.spi.SampleValue';
const oldPackage = 'sample.payload';
const newPackage = 'sample.relocated';
const oldName = oldPackage + '.Provider';
const newName = newPackage + '.Provider';
const firstName = 'sample.peers.Earlier';
const descriptorPath = 'META-INF/services/' + service;
const original = '# scalar providers\r\n  ' + oldName + ' \t# local provider\r\n' + firstName + '\r\n';
const after = original.replace(oldName, newName);
const uri = file => pathToFileURL(file).href;
const load = 'java.util.ServiceLoader.load(SampleValue.class, SampleValue.class.getClassLoader()).findFirst().orElseThrow().value()';
function fixture() {
  const scratch = path.resolve('test-output/package-services-v25-unit');
  fs.mkdirSync(scratch, { recursive: true });
  const project = fs.mkdtempSync(path.join(scratch, 'case-'));
  const sourceRoot = path.join(project, 'src/main/java');
  const roots = [path.join(project, 'src/main/resources'), path.join(project, 'src/additional')];
  const descriptor = path.join(roots[0], descriptorPath);
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return { file, uri: uri(file), text: contents };
  };
  const java = (name, contents) => write(path.join(sourceRoot, ...name.split('.')) + '.java',
    'package ' + name.slice(0, name.lastIndexOf('.')) + ';\n' + contents + '\n');
  const spi = java(service, 'public interface SampleValue { int value(); }');
  const provider = java(oldName, 'import sample.spi.SampleValue; public final class Provider implements SampleValue { public int value() { return 42; } }');
  const earlier = java(firstName, 'public final class Earlier implements sample.spi.SampleValue { public Earlier() {} public int value() { return 13; } }');
  const client = java('sample.consumer.Client', 'import sample.spi.SampleValue; import sample.payload.Provider; public class Client { public int read() { return ' + load + '; } }');
  const sources = [spi, provider, earlier, client];
  const moved = new Map([[provider.uri, provider]]);
  const review = () => reviewPackageServices({ project, roots, directoryExists: P.resourceDirectoryInsideProject, sources, moved, oldPackage, newPackage, uriFor: uri });
  const rootFile = write(path.join(roots[0], 'sample/payload/root.txt'), 'lifted');
  write(path.join(roots[0], 'sample/relocated/marker.txt'), 'destination');
  write(path.join(sourceRoot, 'sample/relocated/Marker.java'), 'package sample.relocated; public class Marker {}');
  const trees = () => ({
    javaTree: P.collectTree(path.join(sourceRoot, 'sample/payload'), path.join(sourceRoot, 'sample/relocated')),
    resources: P.resourceTree(project, sourceRoot, sourceRoot, oldPackage, newPackage, { expanded: true, formats: 'v24' })
  });
  write(descriptor, original);
  return { project, sourceRoot, roots, descriptor, provider, client, spi, sources, review, trees, write, rootFile };
}

test('service descriptor edits replace only the moved provider name with stable order, comments and CRLF', () => {
  const f = fixture(), plan = f.review();
  assert.equal(plan.providers.get(f.provider.uri), service);
  assert.deepEqual(plan.services.get(service).providers, [oldName, firstName]);
  assert.deepEqual(plan.services.get(service).rewrites, [{ from: oldName, to: newName }]);
  assert.deepEqual(plan.permissions, [{ uri: uri(f.descriptor), beforeSha256: sha(original), afterSha256: sha(after) }]);
  assert.deepEqual(plan.edits[0].edits, [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 + oldName.length } }, newText: newName }]);
  assert.equal(fs.readFileSync(f.descriptor, 'utf8'), original);
  const rename = { oldUri: f.provider.uri, newUri: f.provider.uri.replace('/payload/', '/relocated/') };
  const transformed = { uri: rename.newUri, text: f.provider.text.replace(oldPackage, newPackage) };
  plan.verifyProviders([transformed], [rename]);
  assert.throws(() => plan.verifyProviders([{ ...transformed, text: transformed.text.replace('return 42', 'return 15') }], [rename]), /changed a reviewed service provider/);
  plan.validate();
  fs.appendFileSync(f.descriptor, '# later\r\n');
  assert.throws(plan.validate, /membership or bytes changed/);
});

test('descriptor encoding, ambiguous provider syntax and metadata bounds fail closed', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('\uFEFF' + original), Buffer.from('sample.Provider\n' + 'sample.Provider\n'),
    Buffer.from('sample.Outer$Inner'), Buffer.from('prefix ${provider}'), Buffer.from('sample.One\r\nsample.Two\n'),
    Buffer.alloc(8193, 0x20)]) {
    assert.throws(() => parseDescriptor(bytes), /UTF-8|registration|bound|line endings/);
  }
});

test('service interfaces outside production, duplicate descriptors and mutable providers are refused', () => {
  const testOnly = fixture();
  testOnly.spi.file = testOnly.spi.file.replace(path.sep + 'main' + path.sep, path.sep + 'test' + path.sep);
  assert.throws(testOnly.review, /main source set/);
  const duplicate = fixture();
  duplicate.write(path.join(duplicate.project, 'src/test/resources', descriptorPath), original);
  assert.throws(duplicate.review, /Competing service descriptors/);
  const stateful = fixture();
  stateful.provider.text = stateful.provider.text.replace('{ public int', '{ private int counter; public int');
  assert.throws(stateful.review, /no state|initialization/);
  const movedInterface = fixture();
  movedInterface.write(path.join(movedInterface.roots[0], 'META-INF/services/sample.payload.SomeService'), original);
  assert.throws(movedInterface.review, /interface requires a separate/);
});

test('explicit Java system and pinned Spring source-classloader paths produce only the reviewed string and call spans', () => {
  const f = fixture(), trees = f.trees(), services = f.review();
  f.client.text += '\nclass Resources { void read() { ' +
    'java.lang.ClassLoader.getSystemResourceAsStream("sample/payload/root.txt"); ' +
    'new org.springframework.core.io.ClassPathResource("sample/payload/root.txt", Provider.class.getClassLoader()).getInputStream(); } }';
  const proof = P.reviewLookups(f.sources, trees.javaTree, trees.resources, oldPackage, newPackage, services.services);
  assert.deepEqual(proof.lookup.map(item => item.loader), ['system-classloader', 'spring-classloader']);
  assert.equal(proof.bindings.length, 7);
  assert.deepEqual(proof.entries[0].edits.map(item => item.newText), ['"sample/relocated/root.txt"', '"sample/relocated/root.txt"']);
  assert.equal(proof.serviceCalls[0].service, service);
  assert.equal(proof.springProviderRequired, true);
  f.client.text = f.client.text.replace('SampleValue.class, SampleValue.class.getClassLoader()', 'SampleValue.class');
  assert.throws(() => P.reviewLookups(f.sources, trees.javaTree, trees.resources, oldPackage, newPackage, services.services), /reviewed service interface|explicit classloader/);
});

test('compiler checks distinguish matching source sites from shadowed, stale and retargeted methods', () => {
  const source = { uri: 'file:///Owner.java', text: 'java.lang.ClassLoader.getSystemResource("source")' };
  const binding = { uri: source.uri, end: source.text.length, methodKey: 'java.lang.ClassLoader#getSystemResource(java.lang.String)' };
  const quote = source.text.indexOf('"');
  const entries = [{ textDocument: { uri: source.uri }, edits: [{ range: { start: { line: 0, character: quote }, end: { line: 0, character: quote + 8 } }, newText: '"elsewhere"' }] }];
  const before = { calls: [binding] }, rename = { oldUri: source.uri, newUri: 'file:///Relocated.java' };
  const compiled = { ...binding, uri: rename.newUri, end: binding.end + 3 };
  P.verifyResourceBindings([binding], [source], entries, [rename], before, { calls: [compiled] });
  assert.throws(() => P.verifyResourceBindings([binding], [source], entries, [rename], before,
    { calls: [{ ...compiled, methodKey: 'demo.fake.ClassLoader#getSystemResource(java.lang.String)' }] }), /change a verified/);
  assert.throws(() => P.verifyResourceBindings([binding], [source], entries, [rename], { calls: [{ ...binding, end: 0 }] },
    { calls: [compiled] }), /did not bind/);
});

test('observed classpath conflicts and drift are checked even when compiled Java remains usable', async () => {
  const f = fixture();
  const planned = new Map([[descriptorPath, { sha256: sha(original) }], ['sample/relocated/root.txt', null]]);
  const owned = path.join(f.project, 'bin/main');
  const copy = f.write(path.join(owned, descriptorPath), original);
  const stock = path.join(f.project, 'stock.jar');
  f.write(stock, zip([{ name: 'META-INF/INDEX.LIST', data: 'obsolete' }, { name: 'unrelated/data.txt', data: 'ok' }]));
  const proof = await proveClasspathPaths([owned, stock], f.project, f.roots, planned);
  assert.deepEqual(proof.proof, { directories: 1, jars: 1, identities: 2 });
  fs.appendFileSync(copy.file, '# adding a comment\r\n');
  assert.throws(proof.validate, /does not match|changed/);
  const shadow = path.join(f.project, 'shadow.jar');
  fs.writeFileSync(shadow, zip([{ name: 'META-INF/versions/25/sample/relocated/root.txt', data: 'shadow' }]));
  await assert.rejects(proveClasspathPaths([shadow], f.project, f.roots, planned), /competing service or resource identity/);
  fs.writeFileSync(shadow, zip([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nClass-Path: unknown.jar\r\n\r\n' }]));
  await assert.rejects(proveClasspathPaths([shadow], f.project, f.roots, planned), /Indirect JAR manifest/);
});

test('advanced classpath contracts refuse potentially customized Maven resource processing', () => {
  const f = fixture(), pom = path.join(f.project, 'pom.xml');
  const roots = { kind: 'standard-main-convention' };
  f.write(pom, '<project><artifactId>sample</artifactId></project>');
  proveLocalBuildMapping(f.project, roots, [pom]);
  f.write(pom, '<project><parent><artifactId>custom</artifactId></parent></project>');
  assert.throws(() => proveLocalBuildMapping(f.project, roots, [pom]), /custom or inherited mappings/);
});

test('refactoring admits only the exact reviewed service text edit and guards against late disk changes', async () => {
  const f = fixture(), proof = f.review();
  const fileUri = file => ({ scheme: 'file', fsPath: file, query: '', fragment: '', toString: () => uri(file) });
  const buffer = { isClosed: false, isDirty: false, version: 1, getText: () => original };
  const vscode = {
    Uri: { parse: value => fileUri(fileURLToPath(value)) },
    Range: class {},
    TextEdit: class { constructor(_range, text) { this.text = text; } },
    WorkspaceEdit: class { set(location, edits) { this.location = location; this.edits = edits; } },
    workspace: {
      isTrusted: true, textDocuments: [], getWorkspaceFolder: () => ({ uri: fileUri(f.project) }),
      openTextDocument: async () => buffer,
      applyEdit: async edit => {
        assert.equal(edit.location.toString(), uri(f.descriptor));
        assert.deepEqual(edit.edits.map(item => item.text), [newName]);
        return true;
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} })
    },
    commands: { registerCommand: () => ({ dispose() {} }) }
  };
  const api = registerJavaRefactoring({}, vscode);
  try {
    const edit = { documentChanges: proof.edits };
    const options = { kind: 'refactor.move.package', allowedServiceEdits: proof.permissions };
    await assert.rejects(api.previewWorkspaceEdit(edit, {}), /local Java/);
    const tampered = structuredClone(edit);
    tampered.documentChanges[0].edits[0].newText = 'sample.other.Invalid';
    await assert.rejects(api.previewWorkspaceEdit(tampered, options), /exact reviewed edit/);
    const late = await api.previewWorkspaceEdit(edit, options);
    fs.appendFileSync(f.descriptor, '# late\r\n');
    await assert.rejects(api.apply(late.id), /changed after review/);
    fs.writeFileSync(f.descriptor, original);
    const approved = await api.previewWorkspaceEdit(edit, options);
    assert.equal(approved.documents[0].after, after);
    assert.equal(approved.documents[0].serviceDescriptor, true);
    assert.equal((await api.apply(approved.id)).state, 'applied');
  } finally {
    await api.dispose();
  }
});
