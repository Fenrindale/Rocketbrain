'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { projectFiles } = require('../src/java/move');
const { transformed } = require('../src/java/move-scope');
const { reviewPackageServices } = require('../src/java/package-services');
const { collectTree, resourceDirectoryInsideProject, reviewLookups, verifyServiceClients } = require('../src/java/package-resources');

const project = path.resolve(__dirname, 'fixtures/refactoring-v27-package');
const java = path.join(project, 'src/main/java/fixture/packagev27');
const oldPackage = 'fixture.packagev27.payload';
const newPackage = 'fixture.packagev27.relocated';
const uriFor = file => pathToFileURL(file).href;

function fixture(change = source => source) {
  const roots = [path.join(project, 'src/main/resources')];
  const sources = projectFiles(project).filter(file => file.endsWith('.java')).map(file =>
    change({ file, uri: uriFor(file), text: fs.readFileSync(file, 'utf8') }));
  const tree = collectTree(path.join(java, 'payload'), path.join(java, 'relocated'));
  const renames = tree.files.map(item => ({ oldUri: uriFor(item.file), newUri: uriFor(item.newFile) }));
  const moved = new Map(tree.files.map(item => [uriFor(item.file), item]));
  const review = () => reviewPackageServices({ project, roots, directoryExists: resourceDirectoryInsideProject,
    sources, moved, oldPackage, newPackage, uriFor });
  return { review, sources, tree, renames };
}

test('named service registrations preserve comments and provider order without moving the module descriptor', () => {
  const { review, sources, renames } = fixture();
  const plan = review();
  const source = sources.find(item => path.basename(item.file) === 'module-info.java');
  assert.equal(plan.module.directiveEdits, 3);
  assert.equal(plan.module.name, 'fixture.packagev27');
  assert.deepEqual(plan.permissions, []);
  assert.deepEqual(plan.renames, []);
  assert.equal(plan.compilerContractCount, 4);
  assert.equal(plan.factories.size, 1);
  const [service] = plan.services.values();
  assert.deepEqual(service.newProviders, [newPackage + '.FactoryProvider', 'fixture.packagev27.peers.DirectValue']);
  assert.equal(service.providerFactories[0].nextImplementation, newPackage + '.FactoryValue');
  const descriptor = transformed(sources, [plan.moduleEntry], []).find(item => item.uri === source.uri);
  assert.equal(descriptor.text, source.text.replaceAll(oldPackage, newPackage));
  const after = sources.map(item => ({
    uri: renames.find(rename => rename.oldUri === item.uri)?.newUri || item.uri,
    text: item.text.replaceAll(oldPackage, newPackage)
  }));
  assert.doesNotThrow(() => plan.verifyProviders(after, renames));
  assert.throws(() => plan.verifyProviders(after.map(item => ({
    ...item, text: item.text.replace('new FactoryValue()', 'null')
  })), renames), /provider factory/);
});

test('named consumers bind the exact boot-layer overload and retain their ordered consumption', () => {
  const { review, sources, tree, renames } = fixture();
  const { services } = review();
  const proof = reviewLookups(sources, tree, { files: [] }, oldPackage, newPackage, services);
  assert.equal(proof.serviceCalls[0].loader, 'named-module-boot-layer');
  assert.equal(proof.bindings.length, 7);
  assert.ok(proof.bindings.some(binding => binding.methodKey === 'java.util.ServiceLoader#load(java.lang.ModuleLayer,java.lang.Class<S>)'));
  const after = sources.map(item => ({
    uri: renames.find(rename => rename.oldUri === item.uri)?.newUri || item.uri,
    text: item.text.replaceAll(oldPackage, newPackage)
  }));
  assert.doesNotThrow(() => verifyServiceClients(proof.serviceCalls, after, renames, services));
  const context = sources.map(item => ({ ...item, text: item.text.replace('java.lang.ModuleLayer.boot(), ', '') }));
  assert.throws(() => reviewLookups(context, tree, { files: [] }, oldPackage, newPackage, services), /exact reviewed interface/);
});

test('module exports, dependencies, missing uses and non-literal factory allocations fail closed', () => {
  function changeFile(name, transform) {
    return source => path.basename(source.file) === name ? { ...source, text: transform(source.text) } : source;
  }
  for (const directive of ['exports ' + oldPackage + ';', 'requires java.sql;', 'opens ' + oldPackage + ';']) {
    const f = fixture(changeFile('module-info.java', text => text.replace('{', '{\n' + directive)));
    assert.throws(f.review, /closed named module/);
  }
  const missing = fixture(changeFile('module-info.java', text => text.replace('uses ' + oldPackage + '.PackageValue;', '')));
  assert.throws(missing.review, /exact uses directive/);
  const arbitrary = fixture(changeFile('FactoryProvider.java', text => text.replace('new FactoryValue()', 'null')));
  assert.throws(arbitrary.review, /provider factory/);
});
