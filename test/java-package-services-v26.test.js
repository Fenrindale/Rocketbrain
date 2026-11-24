'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const resources = require('../src/java/package-resources');
const { reviewPackageServices } = require('../src/java/package-services');
const { registerJavaRefactoring } = require('../src/java/refactoring');

const oldPackage = 'fixture.payload', newPackage = 'fixture.relocated';
const service = oldPackage + '.Values', nextService = newPackage + '.Values';
const first = oldPackage + '.First', second = oldPackage + '.nested.Second', outside = 'fixture.peers.Outside';
const uriFor = file => pathToFileURL(file).href;
const sha = value => createHash('sha256').update(value).digest('hex');
const stream = 'java.util.ServiceLoader.load(Values.class, Values.class.getClassLoader()).stream().map(provider -> provider.get().value()).toList()';
const original = '# three providers with CRLF\r\n  ' + first + ' # one\r\n\r\n' + outside + '\t# kept\r\n' + second + '\r\n';

function fixture({ interfaceOnly = false } = {}) {
  const tmp = path.resolve('test-output/package-services-v26-unit');
  fs.mkdirSync(tmp, { recursive: true });
  const project = fs.mkdtempSync(path.join(tmp, 'fixture-'));
  const java = path.join(project, 'src/main/java');
  const main = path.join(project, 'src/main/resources');
  const root = pkg => path.join(java, ...pkg.split('.'));
  const fileFor = type => path.join(java, ...type.split('.')) + '.java';
  const descriptor = path.join(main, 'META-INF/services', service);
  const destination = path.join(path.dirname(descriptor), nextService);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return { file, text, uri: uriFor(file) };
  };
  const source = (type, body) => write(fileFor(type), 'package ' + type.slice(0, type.lastIndexOf('.')) + ';\n' + body + '\n');
  const provider = (name, value) => source(name, 'import ' + service + '; public final class ' + name.split('.').at(-1) +
    ' implements Values { public int value() { return ' + value + '; } }');
  const spi = source(service, 'public interface Values { int value(); }');
  const external = provider(outside, 17);
  const client = source('fixture.client.Client', 'import ' + service + '; public class Client { public java.util.List<Integer> read() { return ' + stream + '; } }');
  const movedProviders = interfaceOnly ? [] : [provider(first, 29), provider(second, 41)];
  const moved = new Map([spi, ...movedProviders].map(item => [item.uri, item]));
  const sources = [spi, external, client, ...movedProviders];
  write(descriptor, interfaceOnly ? outside + '\r\n' : original);
  source(newPackage + '.Marker', 'public final class Marker {}');
  fs.mkdirSync(root(newPackage + '.nested'), { recursive: true });
  const review = () => reviewPackageServices({ project, roots: [main], directoryExists: resources.resourceDirectoryInsideProject,
    sources, moved, oldPackage, newPackage, uriFor });
  const tree = () => resources.collectTree(root(oldPackage), root(newPackage));
  const renames = [...moved.values()].map(value => ({ oldUri: value.uri, newUri: uriFor(value.file.replace(root(oldPackage), root(newPackage))) }));
  const transformed = sources.map(value => ({
    uri: renames.find(rename => rename.oldUri === value.uri)?.newUri || value.uri,
    text: value.text.replaceAll(oldPackage, newPackage)
  }));
  return { project, descriptor, destination, review, tree, renames, transformed, write, sources, external };
}

test('service interface move plans its descriptor rename and only the moved provider-name spans', () => {
  const f = fixture(), plan = f.review(), proof = plan.services.get(service);
  const expected = original.replaceAll(oldPackage, newPackage);
  assert.deepEqual(proof.providers, [first, outside, second]);
  assert.deepEqual(proof.newProviders, [first.replace(oldPackage, newPackage), outside, second.replace(oldPackage, newPackage)]);
  assert.equal(proof.nextService, nextService);
  assert.equal(plan.compilerContractCount, 4);
  assert.deepEqual(plan.permissions, [{
    uri: uriFor(f.descriptor), newUri: uriFor(f.destination), beforeSha256: sha(original), afterSha256: sha(expected)
  }]);
  assert.deepEqual(plan.edits[0].edits.map(edit => [edit.range.start.line, edit.newText]), [
    [1, first.replace(oldPackage, newPackage)], [4, second.replace(oldPackage, newPackage)]
  ]);
  plan.verifyProviders(f.transformed, f.renames);
  const altered = f.transformed.map(item => item.uri === f.external.uri ? { ...item, text: item.text.replace('return 17', 'return 18') } : item);
  assert.throws(() => plan.verifyProviders(altered, f.renames), /changed a reviewed service provider/);
  assert.equal(fs.readFileSync(f.descriptor, 'utf8'), original);
  assert.equal(fs.existsSync(f.destination), false);
  f.write(f.destination, outside + '\n');
  assert.throws(plan.validate, /membership or bytes changed/);
  assert.throws(f.review, /destination service interface or descriptor identity/);
});

test('a descriptor follows the interface unchanged when every provider stays put', () => {
  const f = fixture({ interfaceOnly: true }), proof = f.review();
  assert.deepEqual(proof.edits, []);
  assert.equal(proof.permissions[0].beforeSha256, proof.permissions[0].afterSha256);
  assert.equal(proof.permissions[0].newUri, uriFor(f.destination));
  assert.equal(proof.renames.length, 1);
  proof.verifyProviders(f.transformed, f.renames);
});

test('ordered service clients retarget exact compiler bindings to the new interface and reject a changed pipeline', () => {
  const f = fixture(), plan = f.review();
  const proof = resources.reviewLookups(f.sources, f.tree(), { files: [] }, oldPackage, newPackage, plan.services);
  assert.equal(proof.serviceCalls[0].consumption, 'ordered-list');
  assert.equal(proof.bindings.length, 7);
  assert.deepEqual(proof.bindings.filter(binding => binding.after?.methodKey).map(binding => binding.after.methodKey), [nextService + '#value()']);
  resources.verifyServiceClients(proof.serviceCalls, f.transformed, f.renames, plan.services);
  assert.throws(() => resources.verifyServiceClients(proof.serviceCalls,
    f.transformed.map(item => ({ ...item, text: item.text.replace('provider.get().value()', 'provider.get().value() + 1') })),
    f.renames, plan.services), /immediate scalar consumption/);
});

test('module service declarations fail closed', () => {
  const f = fixture();
  f.sources.push(f.write(path.join(f.project, 'src/main/java/module-info.java'), 'module unrelated { }'));
  assert.throws(f.review, /Module service declarations/);
});

test('refactoring only applies the exact authorized text edits before the descriptor filename change', async () => {
  const f = fixture(), proof = f.review();
  const makeUri = file => ({ scheme: 'file', fsPath: file, query: '', fragment: '', toString: () => uriFor(file) });
  const edits = [];
  const fake = {
    Uri: { parse: value => makeUri(fileURLToPath(value)) }, Range: class {},
    TextEdit: class { constructor(_range, text) { this.text = text; } },
    WorkspaceEdit: class {
      set(uri, changes) { edits.push(['set', uri.toString(), changes.map(change => change.text)]); }
      renameFile(source, target) { edits.push(['rename', source.toString(), target.toString()]); }
    },
    workspace: {
      isTrusted: true, textDocuments: [], getWorkspaceFolder: () => ({ uri: makeUri(f.project) }),
      openTextDocument: async () => ({ isClosed: false, isDirty: false, version: 1, getText: () => original }),
      applyEdit: async () => true,
      registerTextDocumentContentProvider: () => ({ dispose() {} })
    },
    commands: { registerCommand: () => ({ dispose() {} }) }
  };
  const api = registerJavaRefactoring({}, fake);
  try {
    const options = { kind: 'refactor.move.package', allowedServiceEdits: proof.permissions, allowedResourceOperations: ['rename'] };
    const request = { documentChanges: [...proof.edits, ...proof.renames] };
    await assert.rejects(api.previewWorkspaceEdit({ documentChanges: proof.edits }, options), /approved filename operation/);
    const spoofed = structuredClone(request);
    spoofed.documentChanges.at(-1).newUri = uriFor(path.join(path.dirname(f.destination), 'fixture.relocated.Other'));
    await assert.rejects(api.previewWorkspaceEdit(spoofed, options), /exact approved destination/);
    const plan = await api.previewWorkspaceEdit(request, options);
    assert.equal(plan.documents[0].resourceOperation, 'rename');
    assert.equal(plan.documents[0].after, original.replaceAll(oldPackage, newPackage));
    f.write(f.destination, 'late collision');
    await assert.rejects(api.apply(plan.id), /move destination changed/);
    fs.unlinkSync(f.destination);
    assert.equal((await api.apply(plan.id)).state, 'applied');
    assert.deepEqual(edits, [
      ['set', uriFor(f.descriptor), [first.replace(oldPackage, newPackage), second.replace(oldPackage, newPackage)]],
      ['rename', uriFor(f.descriptor), uriFor(f.destination)]
    ]);
  } finally {
    await api.dispose();
  }
});
