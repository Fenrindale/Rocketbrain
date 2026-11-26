'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {validIdentifier} = require('./file-templates');
const {analyzeJavaSources} = require('./signature-compiler');
const {exactEntries} = require('./java-type-rename');
const {attributedFiles, verifyBindings, clauses, enforceContracts} = require('./java-package-rename');
const {bindModuleDescriptor, verifyModuleProjection, reconcileModuleText} = require('./package-rename-module');
const {scalarService} = require('./package-services');
const {observeServiceMove, bindServiceMove} = require('./package-move-service-scope');
const {editedText} = require('./refactoring');
const S = require('./move-scope');
const P = require('./package-resources');

function packageName(root, folder) {
  const parts = path.relative(root, fs.realpathSync(folder)).split(path.sep);
  if (!parts.every(validIdentifier)) throw Error('Choose an existing named package in the service module main source root.');
  return parts.join('.');
}

function verifyEngine(response, java, entries, oldPackage, newPackage, selected, modules) {
  const edits = S.textEntries(response, [...java.values()]);
  const expected = new Map(entries.map(entry => [entry.textDocument.uri, entry]));
  let declared = false;
  for (const entry of edits) {
    const uri = entry.textDocument.uri, source = [...java.values()].find(item => item.uri === uri);
    const exact = expected.get(uri);
    const preview = editedText(source.text, entry.edits);
    const module = modules.get(S.key(source.file));
    if (!exact && preview !== source.text) throw Error('JDT proposed unrelated Java or module edits for Service Package Move.');
    if (module) {
      reconcileModuleText(source.text, preview, module.spans, oldPackage, newPackage);
      continue;
    }
    const actual = clauses(preview);
    const checked = clauses(editedText(source.text, exact?.edits || []));
    if (actual.code !== checked.code) throw Error('JDT proposed source changes outside the exact Javac service package edits.');
    if (uri === selected.uri && actual.packageClause?.name === newPackage) declared = true;
  }
  if (!declared) throw Error('JDT did not confirm the selected interface package declaration.');
  return {editedFiles: edits.length, selectedDeclarationConfirmed: true};
}

function verifyServiceCalls(before, lookups, java, service, proof) {
  const calls = lookups.bindings.filter(binding => binding.methodKey ===
    'java.util.ServiceLoader#load(java.lang.ModuleLayer,java.lang.Class<S>)');
  if (calls.length !== lookups.serviceCalls.length || !calls.length) {
    throw Error('The reviewed service requires exact boot-layer consumers.');
  }
  const observed = new Set();
  for (const call of calls) {
    const source = java.find(item => item.uri === call.uri);
    const unit = before.get(S.key(source.file));
    if (unit.serviceReads?.filter(read => read.end === call.end && read.owner === service.owner &&
        read.service === service.service).length !== 1) {
      throw Error('Javac did not identify the boot-layer ServiceLoader call and selected source-owned service.');
    }
    const module = proof.sourceForCompile(source).moduleName;
    if (!proof.consumers.includes(module)) throw Error('The service loader runs outside a reviewed consumer module.');
    observed.add(module);
  }
  if (observed.size !== proof.consumers.length) throw Error('Each reviewed consumer module needs an exact Java ServiceLoader call.');
  return calls.length;
}

async function prepareServicePackageMove(deps, candidate, sourceUri, targetUri, tree, {cancellation} = {}) {
  const {vscode, send, trusted, refactoring, runtime, synchronizeFiles} = deps;
  const selectedFile = tree.files[0], anchor = vscode.Uri.file(selectedFile.file);
  const scope = await observeServiceMove(vscode, send, candidate, anchor, targetUri, cancellation);
  const oldPackage = packageName(scope.source.sourceRoot, sourceUri.fsPath);
  const newPackage = packageName(scope.source.sourceRoot, targetUri.fsPath);
  const sources = await S.snapshotScope(scope, vscode, trusted, cancellation);
  const java = new Map(sources.filter(source => source.file.endsWith('.java')).map(source => [S.key(source.file), source]));
  const state = runtime();
  if (!state?.javaHome || !state.storagePath) throw Error('Configure the independent Java compiler before reviewing Service Package Move.');
  const proof = bindServiceMove(scope, sources, tree, state.javaHome, oldPackage, newPackage);
  const selected = java.get(S.key(selectedFile.file));
  const contract = scalarService(selected);
  const nextService = newPackage + proof.service.slice(oldPackage.length);
  const service = {service: proof.service, nextService, method: contract.method, moduleName: proof.owner, owner: proof.owner};
  const services = new Map([[proof.service, service]]);
  const lookups = P.reviewLookups(sources, tree, {files: []}, oldPackage, newPackage, services);
  const rename = {
    kind: 'rename', oldUri: anchor.toString(), newUri: vscode.Uri.file(selectedFile.newFile).toString(),
    options: {overwrite: false, ignoreIfExists: false}
  };
  const moved = new Map([[S.key(selected.file), {...rename, packageName: oldPackage, nextKey: S.key(selectedFile.newFile)}]]);
  enforceContracts(sources, oldPackage, moved, {reviewedFiles: new Set(), allowedAnnotations: new Map()}, {
    reviewedFiles: new Set(), reviewedModuleUris: proof.descriptors.map(item => item.uri),
    reviewedClients: new Set(lookups.serviceCalls.map(call => call.uri))
  });
  const guard = S.scopeGuards(scope, sources, vscode, trusted, cancellation);
  function verify() {
    guard();
    P.verifyTree(tree);
    proof.validate();
  }
  const analyze = (inputs, fqn, other) => analyzeJavaSources({
    javaHome: state.javaHome, storagePath: state.storagePath, cancellation, namedModule: true,
    sources: inputs.map(proof.sourceForCompile),
    inspection: {kind: 'packageRenameServiceModules', fqn, other}
  });
  verify();
  const first = await analyze([...java.values()], oldPackage, newPackage);
  if (first.errors.length) throw Error('Resolve existing Java module errors before Move: ' + first.errors[0].message);
  const before = attributedFiles(first, java, oldPackage, moved);
  const modules = new Map(proof.descriptors.map(item => [S.key(item.file), bindModuleDescriptor(before.get(S.key(item.file)), item, oldPackage)]));
  const checkedCalls = verifyServiceCalls(before, lookups, [...java.values()], service, proof);
  const entries = exactEntries([...java.values()], [...before].flatMap(([id, unit]) =>
    unit.spans.map(span => ({...span, uri: java.get(id).uri}))), newPackage);
  if (synchronizeFiles) await synchronizeFiles([{uri: rename.oldUri, type: 1}, {uri: rename.newUri, type: 3}]);
  verify();
  const response = await send('workspace/willRenameFiles', {files: [{oldUri: rename.oldUri, newUri: rename.newUri}]}, cancellation);
  const engine = verifyEngine(response, java, entries, oldPackage, newPackage, selected, modules);
  const prospective = S.transformed(sources, entries, rename);
  const second = await analyze(prospective, newPackage, oldPackage);
  if (second.errors.length) throw Error('Service Package Move would introduce a Java module error: ' + second.errors[0].message);
  const after = attributedFiles(second, new Map(prospective.map(item => [S.key(vscode.Uri.parse(item.uri).fsPath), item])),
    newPackage, new Map([[S.key(selectedFile.newFile), {packageName: newPackage}]]));
  for (const [id, module] of modules) verifyModuleProjection(module, after.get(id), oldPackage, newPackage);
  const checkedBindings = verifyBindings(before, after, moved, oldPackage, newPackage);
  P.verifyServiceClients(lookups.serviceCalls, prospective, [rename], services);
  const preApply = () => {
    verify();
    first.validateClasspath();
    second.validateClasspath();
  };
  preApply();
  const plan = await refactoring.previewWorkspaceEdit({documentChanges: [...entries, rename]}, {
    title: 'Move service package ' + oldPackage + ' to ' + newPackage,
    kind: 'refactor.move.package', anchorDocument: await vscode.workspace.openTextDocument(anchor),
    cancellation, allowedResourceOperations: ['rename'], guards: sources.map(source => ({uri: source.uri})),
    validate: async token => {
      const fresh = await observeServiceMove(vscode, send, candidate, anchor, targetUri, token || cancellation);
      if (fresh.metadata !== scope.metadata) throw Error('The imported service module graph changed after review.');
      preApply();
    },
    preApply,
    warnings: ['Review the exported package and its source references, provider declarations and boot-layer consumers together.',
      'The service retains its original module. Recompile external clients against the moved service package.']
  });
  return {...plan, move: {
    kind: 'package', source: sourceUri.toString(), destination: targetUri.toString(),
    oldPackage, newPackage, movedFiles: 1, movedJavaFiles: 1, reviewedFiles: sources.length,
    semantic: {beforeErrors: 0, afterErrors: 0, checkedBindings, independentNamedModuleCompilation: true},
    moduleServices: {owner: proof.owner, service: proof.service, nextService, providers: proof.providers,
      consumers: proof.consumers, checkedCalls, modules: scope.projects.map(project => project.name), engine}
  }};
}

module.exports = {prepareServicePackageMove};
