'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { analyzeJavaSources, visitJar } = require('./signature-compiler');
const { validIdentifier } = require('./file-templates');
const { editedText } = require('./refactoring');
const { exactEntries } = require('./java-type-rename');
const { lexJava, rangeAt } = require('../spring/java');
const { inside } = require('./testing-projects');
const scopeApi = require('./move-scope');
const { planBootImports, conventionalRoots, autoConfiguration } = require('./package-boot-imports');
const { reviewRenamedPackageServices } = require('./package-rename-services');
const { bindModuleDescriptor, verifyModuleProjection, reconcileModuleText } = require('./package-rename-module');
const { qualifiedPackageScope, bindQualifiedPackageScope } = require('./package-rename-qualified-scope');

const kind = 'refactor.rename.java.package';
const dynamic = new Set(['forName', 'loadClass', 'ClassLoader', 'getResource', 'getResourceAsStream', 'ServiceLoader',
  'ResourceBundle', 'ComponentScan', 'SpringBootApplication', 'EntityScan', 'EnableJpaRepositories', 'MapperScan']);
const benignAnnotations = new Set(['Override', 'Deprecated', 'SuppressWarnings', 'SafeVarargs', 'FunctionalInterface']);
const packageContains = (prefix, namespace) => namespace === prefix || namespace.startsWith(prefix + '.');
const boundedSources = ['.project', '.classpath', '.settings/org.eclipse.jdt.core.prefs', 'gradle/libs.versions.toml'];

function physicalDirectory(folder) {
  const stat = fs.lstatSync(folder, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || scopeApi.key(fs.realpathSync(folder)) !== scopeApi.key(folder)) {
    throw Error('Package Rename requires local physical directories without symbolic links or junctions.');
  }
  return { ino: stat.ino.toString(), dev: stat.dev.toString() };
}

function siblingTree(oldFolder, newFolder) {
  const parent = path.dirname(oldFolder);
  if (scopeApi.key(path.dirname(newFolder)) !== scopeApi.key(parent)) throw Error('Rename to a sibling Java package.');
  const parentIdentity = physicalDirectory(parent);
  if (fs.readdirSync(parent).some(name => name.toLowerCase() === path.basename(newFolder).toLowerCase())) {
    throw Error('The destination package already exists or collides by case.');
  }
  const directories = [], files = [];
  function walk(folder, depth) {
    if (depth > 20 || directories.length >= 250) throw Error('The Java package tree exceeds its directory limit.');
    directories.push({ folder, ...physicalDirectory(folder) });
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), type = fs.lstatSync(file);
      if (type.isDirectory() && !type.isSymbolicLink() && validIdentifier(name)) walk(file, depth + 1);
      else if (type.isFile() && !type.isSymbolicLink() && /^[A-Za-z_$][\w$]*\.java$/u.test(name)) files.push(file);
      else throw Error('The Java package contains resources, nonstandard names or symbolic links. Review those contracts separately.');
      if (files.length > 30) throw Error('Package Rename can review at most 30 moved Java files.');
    }
  }
  walk(oldFolder, 0);
  if (!files.length) throw Error('Choose an existing Java package with saved source files.');
  return { parent: parentIdentity, directories, files };
}

function uriKey(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' || parsed.host || parsed.search || parsed.hash) {
    throw Error('Package Rename returned a non-local source or edit.');
  }
  return scopeApi.key(fileURLToPath(parsed));
}

function clauses(text) {
  const { tokens, issues } = lexJava(text);
  if (issues.length) throw Error('Package Rename requires ordinary Java tokens without Unicode escapes.');
  const body = [], imports = [];
  let packageClause, header = true;
  for (let index = 0; index < tokens.length; index++) {
    const candidate = tokens[index];
    if (header && candidate.text === 'import') {
      const end = tokens.findIndex((token, cursor) => cursor > index && token.text === ';');
      if (end < 0) throw Error('A Java import has no exact terminator.');
      imports.push(tokens.slice(index, end + 1).map(token => token.text).join(' '));
      index = end;
    } else {
      if (header && candidate.text === 'package') {
        const end = tokens.findIndex((token, cursor) => cursor > index && token.text === ';');
        if (end < index + 2) throw Error('A Java package declaration has no exact qualified name.');
        packageClause = { name: tokens.slice(index + 1, end).map(token => token.text).join(''),
          start: tokens[index + 1].start, end: tokens[end - 1].end };
      }
      if (header && ['class', 'record', 'interface', 'enum', '{'].includes(candidate.text)) header = false;
      body.push(candidate.text);
    }
  }
  return { packageClause, code: JSON.stringify([body, imports.sort()]) };
}

function reconciledEngineEdits(edit, sources, expected, oldPackage, newPackage, moved, module) {
  if (!edit || Object.keys(edit.changeAnnotations || {}).length) throw Error('JDT did not return a plain Java package edit.');
  const grouped = new Map();
  const entries = [...Object.entries(edit.changes || {}).map(([uri, edits]) =>
    ({ textDocument: { uri }, edits })), ...(edit.documentChanges || [])];
  for (const entry of entries) {
    if (entry.kind || !Array.isArray(entry.edits) || entry.edits.some(change => change.annotationId !== undefined)) {
      throw Error('JDT proposed unsupported Java package conflicts or file operations.');
    }
    const id = uriKey(entry.textDocument?.uri), previous = grouped.get(id), doc = sources.get(id);
    if (!doc || (entry.textDocument.version != null && entry.textDocument.version !== doc.version)) {
      throw Error('JDT proposed stale edits or Java sources outside the imported project.');
    }
    grouped.set(id, [...(previous || []), ...entry.edits]);
  }
  const expectedByFile = new Map(expected.map(entry => [uriKey(entry.textDocument.uri), entry]));
  if (!grouped.size || [...grouped.keys()].some(key => !expectedByFile.has(key))) {
    throw Error('JDT and Javac disagree about the sources affected by Package Rename.');
  }
  let supplemented = 0, engineModuleDirectives = 0;
  for (const [id, entry] of expectedByFile) {
    const doc = sources.get(id), proposed = grouped.get(id) || [];
    let actual = editedText(doc.text, proposed);
    if (id === module?.id) {
      engineModuleDirectives = reconcileModuleText(doc.text, actual, module.spans, oldPackage, newPackage);
      continue;
    }
    const original = clauses(actual).packageClause;
    if (moved.has(id) && original && packageContains(oldPackage, original.name)) {
      const exact = original.name;
      if (actual.slice(original.start, original.end) !== exact) throw Error('JDT returned an unsupported package declaration.');
      actual = actual.slice(0, original.start) + newPackage + exact.slice(oldPackage.length) + actual.slice(original.end);
      supplemented++;
    }
    if (clauses(actual).code !== clauses(editedText(doc.text, entry.edits)).code) {
      throw Error('JDT proposed source changes that differ from the exact Javac package references.');
    }
  }
  if (module && ![...grouped.keys()].some(id => id !== module.id)) {
    throw Error('JDT did not verify the ordinary source edits for this named module.');
  }
  return { engineFiles: grouped.size, supplemented, ...(module && { engineModuleDirectives }) };
}

function enforceContracts(sources, oldPackage, moved, boot, services, qualifiedModules) {
  const reviewedModules = new Set([services?.moduleDescriptor?.uri,qualifiedModules?.provider.uri,qualifiedModules?.client.uri]);
  const escaped = oldPackage.replace(/[$.]/gu, character => '\\' + character);
  const qualified = new RegExp('(?<![\\p{L}\\p{N}_$.])' + escaped + '(?=$|[^\\p{L}\\p{N}_$])', 'u');
  const slash = oldPackage.replaceAll('.', '/');
  for (const source of sources) {
    const id = scopeApi.key(source.file), permitted = boot.allowedAnnotations.get(id);
    if (!source.file.endsWith('.java')) {
      if (boot.reviewedFiles.has(id) || services?.reviewedFiles.has(source.uri)) continue;
      if (/\.(?:kt|scala|groovy)$/iu.test(source.file) || qualified.test(source.text) || source.text.includes(slash) ||
          qualified.test(path.basename(source.file))) {
        throw Error('A resource, build setting, registration or non-Java source refers to the package.');
      }
      continue;
    }
    const { tokens, issues } = lexJava(source.text);
    if (issues.length || path.basename(source.file) === 'module-info.java' && !reviewedModules.has(source.uri)) {
      throw Error('Use ordinary Java sources and only the reviewed named module descriptors.');
    }
    if (tokens.some((token, index) =>
      token.kind === 'id' && dynamic.has(token.text) &&
        (token.text !== 'ServiceLoader' || !services?.reviewedClients.has(source.uri)) ||
      ['string', 'text-block'].includes(token.kind) &&
        (qualified.test(token.value ?? token.text) || token.text.includes(slash)) ||
      moved.has(id) && token.text === '@' && !benignAnnotations.has(tokens[index + 1]?.text) && !permitted?.has(token.start))) {
      throw Error('A Java resource, reflection, annotation or framework package contract requires separate review.');
    }
    if ((source.text.match(/\/\*\*[\s\S]*?\*\//gu) || []).some(comment => qualified.test(comment))) {
      throw Error('A Javadoc package reference requires a separate review.');
    }
  }
}

function compilerClasspath(project) {
  const validOutputs = ['bin', 'bin/main', 'bin/test', 'target/classes', 'target/test-classes',
    'build/classes/java/main', 'build/classes/java/test', 'build/resources/main', 'build/resources/test'];
  const outputs = new Set(validOutputs.map(relative => scopeApi.key(path.join(project.root, relative))));
  const eclipse = new Set(validOutputs.map(relative => ('/' + path.basename(project.root) + '/' + relative).toLowerCase()));
  const classpath = [];
  for (const file of new Set(project.classpaths.classpaths)) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('The Java classpath returned a nonlocal input.');
    const spelt = file.replaceAll('\\', '/');
    if (outputs.has(scopeApi.key(file)) || process.platform === 'win32' && eclipse.has(spelt.toLowerCase())) continue;
    if (spelt.startsWith('//') || process.platform === 'win32' && spelt.startsWith('/') ||
        !file.toLowerCase().endsWith('.jar') || !fs.lstatSync(file).isFile() ||
        scopeApi.key(fs.realpathSync(file)) !== scopeApi.key(file)) throw Error('Review a local classpath with ordinary JARs and known project outputs.');
    classpath.push(file);
  }
  return classpath;
}

async function rejectBinaryPackages(classpath, oldPackage, newPackage, cancellation) {
  const namespaces = [oldPackage, newPackage].map(name => name.replaceAll('.', '/') + '/');
  for (const file of classpath) {
    if (cancellation?.isCancellationRequested) throw Error('Java Package Rename cancelled.');
    await visitJar(file, async entry => {
      const name = entry.fileName.replace(/^META-INF\/versions\/\d+\//u, '');
      if (name.endsWith('.class') && namespaces.some(prefix => name.startsWith(prefix))) {
        throw Error('An imported binary dependency contributes classes to the old or new package.');
      }
    });
  }
}

function attributedFiles(report, sources, oldPackage, moved) {
  if (!Array.isArray(report.packageRename) || report.packageRename.length !== sources.size) {
    throw Error('Javac did not attribute every Java source in the Package Rename review.');
  }
  const records = new Map();
  for (const unit of report.packageRename) {
    const id = uriKey(unit.uri), source = sources.get(id), move = moved.get(id);
    if (!source || records.has(id) || unit.competingNamespace || Boolean(move) !== packageContains(oldPackage, unit.name) ||
        move && move.packageName !== unit.name) throw Error('A Java package declaration differs from the reviewed tree or competes with the destination.');
    if (unit.spans.some(span => source.text.slice(span.start, span.end) !== oldPackage) ||
        unit.spans.filter(span => span.role === 'declaration').length !== Number(Boolean(move))) {
      throw Error('Javac provided unexpected Java package source spans.');
    }
    records.set(id, unit);
  }
  return records;
}

function verifyBindings(before, after, moved, oldPackage, newPackage) {
  const mapType = name => name.startsWith(oldPackage + '.') ? newPackage + name.slice(oldPackage.length) : name;
  const identity = ([kind, owner, name, ...types]) => kind === 'type' ? [kind, mapType(owner)] :
    [kind, mapType(owner), name, ...types.map(mapType)];
  let count = 0;
  for (const [id, unit] of before) {
    const next = after.get(moved.get(id)?.nextKey || id), delta = newPackage.length - oldPackage.length;
    if (!next) throw Error('A prospective Java source moved to an unexpected location.');
    const offset = point => point + delta * unit.spans.filter(span => point >= span.end).length;
    const expected = unit.bindings.map(([start, end, form, binding, ...owners]) =>
      JSON.stringify([offset(start), offset(end), form, identity(binding), ...owners])).sort();
    const observed = next.bindings.map(binding => JSON.stringify(binding)).sort();
    const spans = unit.spans.map(({start, end, role}) => [offset(start), offset(end), role]);
    if (JSON.stringify(expected) !== JSON.stringify(observed) ||
        JSON.stringify(spans) !== JSON.stringify(next.spans.map(({start, end, role}) => [start, end, role]))) {
      throw Error('Package Rename would change a resolved Java type, constructor, method, field or package binding.');
    }
    count += expected.length;
  }
  return count;
}

async function preparePackageRename({ vscode, send, trusted, refactoring, runtime, synchronizeFiles }, document, newLeaf, { cancellation } = {}) {
  trusted(cancellation);
  const uri = document?.uri, version = document?.version;
  if (document?.languageId !== 'java' || uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
      document.isDirty || document.isClosed || !validIdentifier(newLeaf)) {
    throw Error('Open a saved Java source and enter a valid new package segment.');
  }
  const oldFolder = path.dirname(uri.fsPath), newFolder = path.join(path.dirname(oldFolder), newLeaf);
  const tree = siblingTree(oldFolder, newFolder);
  const scope = await qualifiedPackageScope(vscode,send,uri,cancellation) ||
    await scopeApi.moveScope(vscode, send, uri, uri, cancellation, { classpathScope: 'test', allowPackageModule: true });
  const root = scope.source.sourceRoot, part = path.relative(root, oldFolder);
  const segments = part.split(path.sep);
  if (!part || !inside(root, oldFolder) || !segments.every(validIdentifier)) throw Error('Choose a named Java package inside an imported source root.');
  const oldPackage = segments.join('.'), newPackage = [...segments.slice(0, -1), newLeaf].join('.');
  scope.includeClassRegistrations = true;
  for (const relative of boundedSources) {
    const file = path.join(scope.source.root, relative);
    if (fs.existsSync(file)) scope.buildFiles.push(file);
  }
  const replacements = () => conventionalRoots.map(resources =>
    path.join(scope.source.root, resources, 'META-INF', 'spring', autoConfiguration + '.replacements'))
    .filter(file => fs.lstatSync(file, { throwIfNoEntry: false }));
  const bootReplacementFiles = replacements();
  scope.buildFiles.push(...bootReplacementFiles);
  function checkResources() {
    for (const resources of conventionalRoots) {
      if (fs.existsSync(path.join(scope.source.root, resources, ...segments))) {
        throw Error('A resource directory shares the Java package name. Review its resource contracts separately.');
      }
      const relative = path.join(resources, 'META-INF', 'spring', autoConfiguration + '.imports');
      const registry = path.join(scope.source.root, relative);
      if (fs.lstatSync(registry, { throwIfNoEntry: false }) &&
          path.relative(scope.source.root, fs.realpathSync(registry)) !== relative) {
        throw Error('Use the exact physical Spring Boot imports path and case.');
      }
    }
    if (JSON.stringify(replacements()) !== JSON.stringify(bootReplacementFiles)) {
      throw Error('The Spring Boot registration resource set changed after review.');
    }
  }
  checkResources();
  const sources = await scopeApi.snapshotScope(scope, vscode, trusted, cancellation);
  const java = new Map(sources.filter(source => source.file.endsWith('.java')).map(source => [scopeApi.key(source.file), source]));
  if ([...java.values()].some(source => !scope.projects.some(project => project.sourceRoots.some(root => inside(root, source.file))))) {
    throw Error('A Java source outside the imported main or test roots needs a separate review.');
  }
  const moved = new Map(), prospectiveNames = new Map();
  for (const file of tree.files) {
    const id = scopeApi.key(file), input = java.get(id);
    if (!input) throw Error('A moved file is outside the reviewed Java sources.');
    const relative = path.relative(oldFolder, file);
    const directories = path.dirname(relative) === '.' ? [] : path.dirname(relative).split(path.sep);
    const next = path.join(newFolder, relative), nextKey = scopeApi.key(next), newUri = vscode.Uri.file(next).toString();
    moved.set(id, { oldUri: input.uri, newUri, nextKey, packageName: [oldPackage, ...directories].join('.') });
    prospectiveNames.set(nextKey, { packageName: [newPackage, ...directories].join('.') });
  }
  const classpath = scope.namedPackageModule ? [] : compilerClasspath(scope.source);
  if (!scope.namedPackageModule) {
    const jars = new Set(classpath.map(scopeApi.key));
    scope.classpathIdentity = scope.classpathIdentity.filter(saved => jars.has(scopeApi.key(saved.file)));
  }
  const sourceGuard = scopeApi.scopeGuards(scope, sources, vscode, trusted, cancellation);
  const engine = runtime();
  if (!engine?.javaHome || !engine.storagePath) throw Error('Configure the independent Java runtime before reviewing Package Rename.');
  function checkTree() {
    trusted(cancellation);
    if (document.isClosed || document.isDirty || document.version !== version ||
        JSON.stringify(tree) !== JSON.stringify(siblingTree(oldFolder, newFolder))) {
      throw Error('The Java package source, directory or package membership changed after review.');
    }
    checkResources();
    scope.checkBuildFiles?.();
    sourceGuard();
  }
  const boot = planBootImports({ sources, moved, projectRoot: scope.source.root, oldPackage, newPackage });
  const qualified = scope.qualifiedPackageModules
    ? bindQualifiedPackageScope(scope,sources,engine.javaHome,oldPackage,newPackage)
    : undefined;
  const services = qualified ? undefined : await reviewRenamedPackageServices({ scope, sources, moved, tree, oldPackage, newPackage,
    uriFor: file => vscode.Uri.file(file).toString() });
  enforceContracts(sources, oldPackage, moved, boot, services, qualified);
  const analyze = (sources, fqn, other) => analyzeJavaSources({ ...engine,
    sources:qualified ? sources.map(qualified.sourceForCompile) : sources, classpath, cancellation,
    namedModule: scope.namedPackageModule, manifestLimit: 256 * 1024,
    inspection: { kind: qualified ? 'packageRenameModules' : services ? 'packageRenameServices' : 'packageRename', fqn, other } });
  const first = await analyze([...java.values()], oldPackage, newPackage);
  if (first.errors.length) throw Error('Resolve existing Java compiler errors before renaming the package: ' + first.errors[0].message);
  await rejectBinaryPackages(classpath, oldPackage, newPackage, cancellation);
  first.validateClasspath();
  const before = attributedFiles(first, java, oldPackage, moved);
  const descriptor = qualified?.provider || services?.moduleDescriptor;
  const module = descriptor && { id: uriKey(descriptor.uri),
    ...bindModuleDescriptor(before.get(uriKey(descriptor.uri)), descriptor, oldPackage) };
  const peerId = qualified && uriKey(qualified.client.uri);
  const peer = qualified && bindModuleDescriptor(before.get(peerId),qualified.client,oldPackage);
  const exact = exactEntries([...java.values()], [...before].flatMap(([id, unit]) =>
    unit.spans.map(span => ({ ...span, uri: java.get(id).uri }))), newPackage);
  const directory = { kind: 'rename', oldUri: vscode.Uri.file(oldFolder).toString(), newUri: vscode.Uri.file(newFolder).toString(),
    options: { overwrite: false, ignoreIfExists: false } };
  checkTree();
  if (synchronizeFiles) {
    for (let index = 0; index < tree.files.length; index += 2) {
      await synchronizeFiles(tree.files.slice(index, index + 2).map(file => ({ uri: vscode.Uri.file(file).toString(), type: 1 })));
    }
  }
  const raw = await send('workspace/willRenameFiles', { files: [{ oldUri: directory.oldUri, newUri: directory.newUri }] }, cancellation);
  checkTree();
  const observed = reconciledEngineEdits(raw, java, exact, oldPackage, newPackage, moved, module);
  const prospective = scopeApi.transformed(sources, exact, [...moved.values()]);
  const second = await analyze(prospective, newPackage, oldPackage);
  if (second.errors.length) throw Error('Package Rename would introduce a Java compiler error: ' + second.errors[0].message);
  const after = attributedFiles(second, new Map(prospective.map(source => [uriKey(source.uri), source])), newPackage, prospectiveNames);
  if (module) verifyModuleProjection(module, after.get(module.id), oldPackage, newPackage);
  if (peer) verifyModuleProjection(peer,after.get(peerId),oldPackage,newPackage);
  const bindings = verifyBindings(before, after, moved, oldPackage, newPackage);
  services?.verify(first, second, prospective, exact);
  const preApply = () => { checkTree(); first.validateClasspath(); second.validateClasspath(); services?.validate(); qualified?.validate(); };
  const validate = async token => {
    if (qualified) {
      const current = await qualifiedPackageScope(vscode,send,uri,token || cancellation);
      if (current?.metadata !== scope.metadata) throw Error('The reviewed named module graph changed after review.');
    } else await scopeApi.validateScope(scope, vscode, send, uri, uri, token || cancellation);
    preApply();
  };
  preApply();
  const plan = await refactoring.previewWorkspaceEdit({ documentChanges: [
    ...exact, ...boot.entries, ...(services?.edits || []), directory, ...(services?.renames || [])
  ] }, {
    title: 'Rename package ' + oldPackage + ' to ' + newPackage, kind, anchorDocument: document, cancellation,
    allowedResourceOperations: ['rename'], allowedDirectoryRename: directory, validate, preApply,
    allowedBootImportsEdits: boot.permissions,
    allowedServiceEdits: services?.permissions || [],
    warnings: ['Review the saved Java source tree and its nested packages. Binary and external callers require a separate review.',
      ...(boot.entries.length ? ['Review the exact Spring Boot imports alongside the Java package. External registrations and public compatibility require a separate review.'] : []),
      ...(qualified ? ['Review the provider’s qualified exports and opens alongside its consumer’s Java references. The named target modules are preserved.'] :
        module ? ['Review the exact module-info.java package and service edits. Provider order, the module name and unrelated directives are preserved.'] :
        services ? ['Review the exact ServiceLoader filenames and provider lines. Registration order, comments and line endings are preserved.'] : [])]
  });
  return { ...plan, packageRename: { oldPackage, newPackage, movedFiles: moved.size,
    editedFiles: exact.length + boot.entries.length + (services?.edits.length || 0),
    ...(boot.entries.length && { bootImports: { files: boot.entries.length, registrations: boot.registrations } }),
    ...(services && { services: services.receipt }),
    ...(qualified && {qualifiedNamedModules:{provider:module.name,consumer:peer.name,targets:qualified.provider.qualified,
      consumerFiles:exact.filter(entry => inside(scope.peer.sourceRoot,fileURLToPath(entry.textDocument.uri))).length}}),
    ...(module && { namedModule: { name: module.name, directiveNamesChanged: module.spans.length,
      directivesChecked: module.declarations.length, compilerVerified: true } }),
    bindings, ...observed } };
}

module.exports = { preparePackageRename, kind, siblingTree, reconciledEngineEdits };
