'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { analyzeJavaSources } = require('./signature-compiler');
const { validIdentifier } = require('./file-templates');
const { editedText } = require('./refactoring');
const { lexJava, parseJavaFile, rangeAt } = require('../spring/java');
const { beanClassEdits } = require('./java-type-rename-xml');
const { commentGroups, withCommentGroups } = require('./type-rename-comments');
const { hasKotlinMentions, mixedJavaClasspath, boundKotlinSites, validateKotlinProjection } = require('./java-kotlin-type-rename');
const scopeApi = require('./move-scope');

const KIND = 'refactor.rename.java.type';
const SAFE_ANNOTATIONS = new Set(['java.lang.Deprecated', 'java.lang.SuppressWarnings']);
const escapeQualifiedName = name => name.replaceAll('$', '\\$').replaceAll('.', '\\.');

function declaration(source, name) {
  const { types, packageName } = parseJavaFile(source);
  const selected = types.find(type => type.name === name && type.kind === 'class');
  if (!selected || !packageName || !packageName.split('.').every(validIdentifier)) {
    throw Error('Select a top-level class in a named Java package.');
  }
  return selected;
}

function localPath(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' || parsed.search || parsed.hash || parsed.host) {
    throw Error('A Java rename edit returned an unexpected file identity.');
  }
  return scopeApi.key(fileURLToPath(parsed));
}

function compilerSpans(result, sources, owner, name) {
  const { typeRename } = result;
  if (!typeRename?.supported || localPath(typeRename.declaration.uri) !== localPath(owner.uri)) {
    throw Error('Javac did not resolve the selected public top-level Java class.');
  }
  if (typeRename.declaration.annotations.some(annotation => !SAFE_ANNOTATIONS.has(annotation))) {
    throw Error('The selected class has annotations that can define an external name contract.');
  }
  const selected = declaration(owner, name);
  if (selected.start < typeRename.declaration.start || selected.end > typeRename.declaration.end) {
    throw Error('The selected declaration differs from the class attributed by Javac.');
  }
  const spans = typeRename.spans.map(span => {
    const source = sources.find(item => localPath(item.uri) === localPath(span.uri));
    if (!source || source.text.slice(span.start, span.end) !== name) {
      throw Error('A compiler-attributed reference has an unexpected source identity.');
    }
    return { ...span, uri: source.uri };
  });
  const resultSpans = [...spans, { uri: owner.uri, start: selected.start, end: selected.end, role: 'declaration' }];
  if (new Set(resultSpans.map(span => span.uri + ':' + span.start)).size !== resultSpans.length) {
    throw Error('Repeated compiler-attributed name ranges require a separate review.');
  }
  return resultSpans;
}

function exactEntries(sources, spans, newName) {
  return sources.flatMap(source => {
    const edits = spans.filter(span => span.uri === source.uri).sort((a, b) => a.start - b.start)
      .map(span => ({ range: rangeAt(source.text, span.start, span.end), newText: newName }));
    return edits.length ? [{ textDocument: { uri: source.uri, version: source.version ?? null }, edits }] : [];
  });
}

function verifiedEngineEdits(edit, sources, expectedEntries, rename) {
  const resources = (edit?.documentChanges || []).filter(change => change.kind);
  if (resources.length > 1 || resources.some(change => change.kind !== 'rename' || change.annotationId !== undefined ||
      localPath(change.oldUri) !== localPath(rename.oldUri) || localPath(change.newUri) !== localPath(rename.newUri) ||
      Object.values(change.options || {}).some(Boolean))) {
    throw Error('JDT proposed an unexpected file operation for Java type rename.');
  }
  const engineEntries = scopeApi.textEntries(edit && {
    ...edit, documentChanges: (edit.documentChanges || []).filter(change => !change.kind)
  }, sources);
  const expectedPaths = new Set(expectedEntries.map(entry => entry.textDocument.uri));
  const enginePaths = new Set(engineEntries.map(entry => entry.textDocument.uri));
  const difference = (source, other) => [...source].filter(uri => !other.has(uri));
  const missing = difference(expectedPaths, enginePaths), unexpected = difference(enginePaths, expectedPaths);
  if (engineEntries.length !== expectedEntries.length || missing.length || unexpected.length) {
    const fileNames = values => values.slice(0, 4).map(uri => path.basename(fileURLToPath(uri))).join(', ');
    const details = [
      missing.length && `JDT omitted ${missing.length} reviewed Java file${missing.length === 1 ? '' : 's'} (${fileNames(missing)}).`,
      unexpected.length && `JDT returned ${unexpected.length} additional Java file${unexpected.length === 1 ? '' : 's'} (${fileNames(unexpected)}).`
    ].filter(Boolean).join(' ');
    throw Error('JDT and Javac disagree on the Java files that need renaming. ' + details);
  }
  for (const expected of expectedEntries) {
    const source = sources.find(value => value.uri === expected.textDocument.uri);
    const actual = engineEntries.find(entry => entry.textDocument.uri === source.uri);
    if (!actual || actual.edits.some(change => change.annotationId !== undefined) ||
        (actual.textDocument.version != null && actual.textDocument.version !== source.version) ||
        editedText(source.text, actual.edits) !== editedText(source.text, expected.edits)) {
      throw Error('JDT proposed text that differs from the exact Javac type-name changes.');
    }
  }
  return { files: engineEntries.length, fileRenameFromEngine: resources.length === 1 };
}

function verifyProspectiveSpans(before, after, rename, delta) {
  const spanKey = ({ uri, start, end }) => uri + ':' + start + ':' + end;
  const observed = new Set(after.map(spanKey));
  const expected = new Set();
  const fileOffsets = new Map();
  for (const span of [...before].sort((a, b) => a.start - b.start)) {
    const shift = fileOffsets.get(span.uri) || 0;
    expected.add(spanKey({
      uri: span.uri === rename.oldUri ? rename.newUri : span.uri,
      start: span.start + shift, end: span.end + shift + delta
    }));
    fileOffsets.set(span.uri, shift + delta);
  }
  if (expected.size !== observed.size || [...expected].some(item => !observed.has(item))) {
    throw Error('The renamed class would bind a different set of Java references.');
  }
}

function classContracts(sources, oldFqn, newFqn, { kotlinReview = false } = {}) {
  const oldName = oldFqn.split('.').at(-1);
  const entries = [];
  const permissions = [];
  const literalClass = new RegExp('(?<![\\p{L}\\p{N}_.$])' + escapeQualifiedName(oldFqn) + '(?![\\p{L}\\p{N}_])', 'u');
  const sourceType = new RegExp('(?<![\\p{L}\\p{N}_$])' + escapeQualifiedName(oldName) + '(?![\\p{L}\\p{N}_])', 'u');
  for (const source of sources) {
    const extension = path.extname(source.file).toLowerCase();
    if (extension === '.java') {
      const { tokens } = lexJava(source.text);
      if (tokens.some(token => ['string', 'text-block'].includes(token.kind) && literalClass.test(token.value ?? token.text))) {
        throw Error('A Java string refers to the old class name. Review reflective and configured callers separately.');
      }
      continue;
    }
    if (extension === '.xml') {
      const edits = beanClassEdits(source, oldFqn, newFqn);
      if (!edits.length) continue;
      const after = editedText(source.text, edits);
      entries.push({ textDocument: { uri: source.uri, version: source.version }, edits });
      permissions.push({ uri: source.uri, beforeSha256: source.diskHash, afterSha256: scopeApi.digest(after) });
      continue;
    }
    if (extension === '.kt' && kotlinReview) continue;
    if (path.basename(source.file) === oldFqn || literalClass.test(source.text) ||
        ['.kt', '.groovy', '.scala'].includes(extension) && sourceType.test(source.text)) {
      throw Error('A class registration, configuration or non-Java source needs a separate rename review.');
    }
  }
  return { entries, permissions };
}

async function prepareJavaTypeRename(deps, { document, position, newName, cancellation }) {
  const { vscode, request, refactoring, runtime, trusted, synchronizeFiles, beginKotlin } = deps;
  trusted(cancellation);
  if (document?.languageId !== 'java' || document.uri?.scheme !== 'file' || document.isDirty || document.isClosed ||
      !validIdentifier(newName)) {
    throw Error('Save a local Java source and enter a valid new class name.');
  }
  const uri = document.uri.toString();
  const oldName = path.basename(document.uri.fsPath, '.java');
  if (!validIdentifier(oldName) || oldName.toLowerCase() === newName.toLowerCase()) {
    throw Error('Choose a distinct valid class name. Case-only file renames require a separate review.');
  }
  const initial = document.getText();
  const initiallyOpen = new Set((vscode.workspace.textDocuments || []).filter(item => !item.isClosed &&
    item.uri.scheme === 'file').map(item => scopeApi.key(item.uri.fsPath)));
  const selected = declaration({ uri, text: initial }, oldName);
  const offset = position && document.offsetAt(position);
  if (!Number.isInteger(offset) || offset < selected.start || offset >= selected.end) {
    throw Error('Place the cursor on the name of the public class to rename.');
  }
  const destination = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), newName + '.java'));
  const rename = { kind: 'rename', oldUri: uri, newUri: destination.toString(), options: { overwrite: false, ignoreIfExists: false } };
  const target = () => {
    if (fs.readdirSync(path.dirname(destination.fsPath)).some(name => name.toLowerCase() === path.basename(destination.fsPath).toLowerCase())) {
      throw Error('The new Java type filename already exists or collides by case.');
    }
  };
  target();
  await synchronizeFiles?.([{ uri, type: 1 }]);
  const selectedRange = rangeAt(initial, selected.start, selected.end);
  const params = { textDocument: { uri }, position: selectedRange.start };
  const prepared = await request('textDocument/prepareRename', params, cancellation);
  const engineRange = prepared?.range || prepared;
  if (['start', 'end'].some(endpoint => ['line', 'character'].some(field =>
    engineRange?.[endpoint]?.[field] !== selectedRange[endpoint][field]))) {
    throw Error('JDT did not recognize the exact public class declaration. Wait for project import, then retry.');
  }
  const scope = await scopeApi.moveScope(vscode, request, document.uri, document.uri, cancellation, { classpathScope: 'test' });
  scope.includeClassRegistrations = true;
  const sources = await scopeApi.snapshotScope(scope, vscode, trusted, cancellation);
  const owner = sources.find(source => source.uri === uri);
  if (!owner || owner.text !== initial || document.isDirty || document.isClosed) throw Error('The Java class changed after selection.');
  const guard = scopeApi.scopeGuards(scope, sources, vscode, trusted, cancellation);
  const newFqn = selected.fqn.slice(0, -oldName.length) + newName;
  const state = runtime();
  if (!state?.javaHome || !state?.storagePath) throw Error('Configure the independent Java runtime before reviewing a type rename.');
  const java = sources.filter(source => source.file.endsWith('.java'));
  const kotlin = sources.filter(source=>source.file.endsWith('.kt'));
  const mixed = hasKotlinMentions(kotlin, oldName);
  if (mixed && typeof beginKotlin !== 'function') {
    throw Error('Start the pinned Kotlin editor for this Gradle project before reviewing Java type callers.');
  }
  const classpath = mixed ? mixedJavaClasspath(scope, sources, owner) :
    [...new Set(scope.source.classpaths.classpaths)].filter(file => fs.existsSync(file));
  const analyze = (sources, fqn, other) => analyzeJavaSources({
    ...state, sources, classpath, cancellation, manifestLimit: 256 * 1024, inspection: { kind: 'typeRename', fqn, other }
  });
  guard();
  const contracts = classContracts(sources, selected.fqn, newFqn, { kotlinReview:mixed });
  const before = await analyze(java, selected.fqn, newFqn);
  if (before.errors.length) throw Error('Resolve existing Java compile errors before type rename: ' + before.errors[0].message);
  if (before.typeRename?.destinationOccupied) throw Error('A Java class with the destination name is already resolvable.');
  const spans = compilerSpans(before, java, owner, oldName);
  const entries = exactEntries(java, spans, newName);
  const engine = verifiedEngineEdits(await request('textDocument/rename', { ...params, newName }, cancellation), java, entries, rename);
  const prospective = scopeApi.transformed(java, entries, rename);
  const after = await analyze(prospective, newFqn, selected.fqn);
  if (after.errors.length) throw Error('The rename introduces a Java compile error: ' + after.errors[0].message);
  if (before.classpathFingerprint !== after.classpathFingerprint) throw Error('The compiler classpath changed during type rename review.');
  verifyProspectiveSpans(spans, compilerSpans(after, prospective, prospective.find(source => source.uri === rename.newUri), newName),
    rename, newName.length - oldName.length);
  let kotlinReview;
  const kotlinEntries = [], kotlinPermissions = [];
  if (mixed) {
    const candidate = kotlin.find(source=>hasKotlinMentions([source],oldName));
    const kotlinDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(candidate.uri));
    const active = await beginKotlin(kotlinDocument, cancellation);
    if (!active?.root || fs.realpathSync.native(active.root) !== fs.realpathSync.native(scope.source.root)) {
      throw Error('The Kotlin engine resolved a different Java rename project.');
    }
    guard();
    const sites = await boundKotlinSites({ root:active.root, sources, owner, declaration:before.typeRename.declaration,
      fqn:selected.fqn, newName, runtime:active, cancellation });
    const changedSites = sites.filter(site=>!site.keepAlias);
    kotlinEntries.push(...exactEntries(kotlin,changedSites,newName));
    const validation = await validateKotlinProjection({ root:active.root, sources, rename, entries:[...entries,...kotlinEntries],
      fqn:selected.fqn, newFqn, classpath, runtime:active, sites, cancellation });
    kotlinReview = { sites, changedSites, validation, check:active.check };
    for (const entry of kotlinEntries) {
      const source = kotlin.find(value=>value.uri===entry.textDocument.uri);
      kotlinPermissions.push({ uri:source.uri, beforeSha256:source.diskHash,
        afterSha256:scopeApi.digest(editedText(source.text,entry.edits)) });
    }
  }
  const preApply = () => {
    guard();
    target();
    before.validateClasspath();
    after.validateClasspath();
    if (kotlinReview) mixedJavaClasspath(scope, sources, owner);
    kotlinReview?.check();
    kotlinReview?.validation.validateRuntime();
  };
  preApply();
  const options = {
    kind: KIND, title: 'Rename public Java class ' + oldName + ' to ' + newName,
    anchorDocument: document, cancellation, allowedResourceOperations: ['rename'], allowedBeanClassEdits: contracts.permissions,
    allowedJavaTypeKotlinEdits: kotlinPermissions,
    // Opening every dependency a second time can evict unchanged hidden
    // models. The compiler snapshot already pins those dependencies' bytes.
    guards: sources.map(source => initiallyOpen.has(scopeApi.key(source.file)) ? { uri: source.uri } : {
      uri: source.uri, diskGuard: { hash: source.hash, diskHash: source.diskHash }
    }),
    validate: async () => {
      await scopeApi.validateScope(scope, vscode, request, document.uri, document.uri, cancellation);
      preApply();
    },
    preApply,
    warnings: ['The public class name and filename change in this imported project, including the listed literal Spring XML bean classes. Review external consumers, binaries, reflection and generated sources separately.',
      ...(kotlinReview?['Kotlin edits cover exact main-source imports, explicit types, constructor calls and verified constructor references in one imported Gradle project. Import alias names are preserved.']:[])]
  };
  const candidates = commentGroups(java,entries,selected.fqn,newName,editedText);
  const publicGroups = candidates.map(group=>({ id:group.id, uri:group.uri, count:group.edits.length }));
  async function build(groups, token, offer) {
    const chosen = candidates.filter(group=>groups.includes(group.id));
    const javaEdits = withCommentGroups(entries,chosen);
    const changed = chosen.reduce((sum,group)=>sum+group.edits.length,0);
    return refactoring.previewWorkspaceEdit({ documentChanges:[...javaEdits,...kotlinEntries,...contracts.entries,rename] },{
      ...options, cancellation:token,
      warnings:[...options.warnings,...(changed?[changed+' optional TODO or NOTE comment name updates in '+chosen.length+' files.']:[])],
      ...(offer&&publicGroups.length&&{ commentChoices:{ groups:publicGroups,
        select:(selected,token)=>build(selected,token,false) } })
    });
  }
  const plan = await build([],cancellation,true);
  return {
    ...plan, typeRename: { oldFqn: selected.fqn, newFqn, attributedSpans: spans.length, ...engine,
      xmlFiles: contracts.entries.length, xmlBeanClasses: contracts.entries.reduce((count, entry) => count + entry.edits.length, 0),
      ...(kotlinReview&&{kotlinCallers:{files:kotlinEntries.length,sites:kotlinReview.changedSites.length,
        constructorBindings:kotlinReview.validation.constructors,compilerVerified:true,
        ...(kotlinReview.sites.some(site=>site.importAlias)&&{importAliases:kotlinReview.sites.filter(site=>site.importAlias).length,
          retainedAliasSites:kotlinReview.sites.filter(site=>site.keepAlias).length}),
        ...(kotlinReview.validation.callableReferences&&{constructorReferences:kotlinReview.validation.callableReferences})}}),
      sourceFiles: java.length, beforeErrors: 0, afterErrors: 0 }
  };
}

module.exports = { prepareJavaTypeRename, classContracts, verifiedEngineEdits, compilerSpans, exactEntries, verifyProspectiveSpans };
