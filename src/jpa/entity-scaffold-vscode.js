'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseJavaFile } = require('../spring/java');
const { checkPackage, contained, physicalDirectory, validIdentifier, writeTemplateFile } = require('../java/file-templates');
const { buildFingerprint, local } = require('../java/workbench-model');
const { analyzeJavaSources } = require('../java/signature-compiler');
const { defaultEntityName, inspectTable, planEntity } = require('./entity-scaffold');
const { MAX_RELATIONSHIPS } = require('./entity-relationships');
const { INVERSE, THROUGH, relationshipRequests } = require('./entity-collection-relationships');
const { captureRelationshipSources, chooseableDeclarations } = require('./entity-relationship-sources');

const GENERATE_ENTITY = 'rocketbrain.jpa.generateEntity';
const PREVIEW_SCHEME = 'rocketbrain-jpa-entity';
const REVIEW_TTL = 20 * 60 * 1000;
const MAX_REVIEWS = 12;
const BUILD_NAMES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties']);

function sameFile(left, right) { return path.relative(left, right) === ''; }
function lowercase(value) { return value.toLowerCase(); }

function sourceReview(vscode, project, packageName, name) {
  const parts = packageName.split('.');
  const directories = project.sourceRoots.filter(root => !root.unavailable).map(root => path.join(root.path, ...parts));
  const matchedName = lowercase(name + '.java');
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file') continue;
    const directory = path.dirname(doc.uri.fsPath);
    const base = path.basename(doc.uri.fsPath);
    if (directories.some(item => sameFile(item, directory))) {
      if (lowercase(base) === matchedName) throw Error('A Java editor already uses the file name ' + name + '.java.');
      if (doc.isDirty && doc.languageId === 'java') throw Error('Save Java edits in the destination package before generating an entity.');
    }
    if (doc.isDirty && sameFile(directory, project.root) && BUILD_NAMES.has(base)) {
      throw Error('Save Java project build edits before generating an entity.');
    }
  }

  const hash = createHash('sha256');
  let count = 0, bytes = 0;
  for (const directory of directories.sort()) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!sameFile(directory, fs.realpathSync(directory))) throw Error('Use a physical Java package directory.');
    hash.update(directory + '\0');
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (lowercase(entry.name) === matchedName) throw Error('A Java source file with this name already exists in the project package.');
      if (!/\.java$/i.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const info = fs.lstatSync(file);
      if (!info.isFile() || ++count > 256 || info.size > 1024 * 1024 || (bytes += info.size) > 8 * 1024 * 1024) {
        throw Error('Use a physical Java package with at most 256 Java sources and 8 MiB of source text.');
      }
      const content = fs.readFileSync(file);
      const parsed = parseJavaFile({ uri: vscode.Uri.file(file).toString(), text: content.toString('utf8') });
      if (parsed.packageName === packageName && parsed.types.some(type => type.name === name)) {
        throw Error('A Java type with this name already exists in the project package.');
      }
      hash.update(entry.name + '\0').update(content).update('\0');
    }
  }
  return hash.digest('hex');
}

function registerEntityScaffolding(context, vscode, { database, java }) {
  const previews = new Map();
  const storagePath = path.join((context.storageUri || context.globalStorageUri).fsPath, 'jpa-entity-generation');
  let disposed = false, preparing = false;

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the open workspace before generating a JPA entity.');
    if (cancellation?.isCancellationRequested) throw Error('JPA entity generation was cancelled.');
  }

  async function observedProjects(cancellation) {
    trusted(cancellation);
    const runtime = await java.start();
    trusted(cancellation);
    if (runtime.state !== 'running' || !runtime.javaHome || !java.workbench) {
      throw Error('Start the independent Java engine and import a Jakarta Persistence project first.');
    }
    const { projects } = await java.workbench.refresh({ cancellation });
    trusted(cancellation);
    return { runtime, projects };
  }

  async function projectScope(options) {
    const { projectUri, sourceRootId, packageName, name, cancellation } = options;
    if (!validIdentifier(name)) throw Error('Use a valid Java class name.');
    if (!checkPackage(packageName)) throw Error('Choose a named Java package.');
    const { runtime, projects } = await observedProjects(cancellation);
    const project = projects.find(item => item.uri === projectUri);
    const root = project?.sourceRoots.find(item => item.id === sourceRootId && !item.unavailable);
    const folder = root && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root.path));
    if (!folder || folder.uri.scheme !== 'file' || !contained(project.root, root.path) ||
        !contained(folder.uri.fsPath, project.root)) throw Error('Choose a currently imported local Java project and source root.');
    const directory = path.join(root.path, ...packageName.split('.'));
    await physicalDirectory(directory).catch(() => { throw Error('Choose an existing physical Java package in the selected source root.'); });
    const file = path.join(directory, name + '.java');
    const classpaths = await java.requestWorkspaceCommand('java.project.getClasspaths', [project.uri, { scope: 'runtime' }], cancellation);
    trusted(cancellation);
    if (!Array.isArray(classpaths?.classpaths) || !Array.isArray(classpaths.modulepaths) || classpaths.modulepaths.length) {
      throw Error('JPA entity generation supports Jakarta Persistence projects on a local classpath.');
    }
    // Generated entities use only JDK and Jakarta API types. Build output
    // directories can be rewritten by JDT during this independent validation.
    const classpath = [...new Set(classpaths.classpaths.map(local).filter(item =>
      path.extname(item).toLowerCase() === '.jar' && fs.statSync(item, { throwIfNoEntry: false })?.isFile()))];
    const release = /^(?:1\.)?(\d+)$/.exec(String(project.compliance ?? ''));
    if (!release || Number(release[1]) < 8 || Number(release[1]) > 25) throw Error('Use a project with observed Java 8–25 compiler settings.');
    const fingerprint = JSON.stringify({ workspace: folder.uri.toString(), root: root.path, javaHome: runtime.javaHome,
      project: project.root, build: buildFingerprint(project.root), classpath, release: release[1],
      sourceRoots: project.sourceRoots.map(item => [item.path, Boolean(item.unavailable)]) });
    return { project, root, folder, file, directory, fingerprint, classpath, javaHome: runtime.javaHome,
      release: Number(release[1]), sourceFingerprint: sourceReview(vscode, project, packageName, name) };
  }

  function assertTarget(target, cancellation) {
    trusted(cancellation);
    const active = database.savedQueryTarget();
    if (active.key !== target.key || active.connectionEpoch !== target.connectionEpoch) {
      throw Error('The active database changed after review. Generate a new preview.');
    }
  }

  function getPreview(id) {
    const record = previews.get(id);
    return record && (record.applying || Date.now() - record.createdAt <= REVIEW_TTL) ? record : undefined;
  }

  async function prepare(options = {}) {
    const { table, name, packageName, projectUri, sourceRootId, cancellation } = options;
    const relationships = relationshipRequests(options.relationships);
    trusted(cancellation);
    if (preparing) throw Error('Wait for the current entity preview to finish.');
    preparing = true;
    try {
      const target = database.savedQueryTarget();
      const catalog = await database.databaseCatalog();
      assertTarget(target, cancellation);
      const selection = { table, name, packageName, projectUri, sourceRootId, relationships };
      const scope = await projectScope({ ...selection, cancellation });
      const fileUri = vscode.Uri.file(scope.file).toString();
      const targets = captureRelationshipSources(vscode, scope.project, relationships);
      const plan = planEntity({ catalog, table, name, packageName, uri: fileUri, relationships, targetSources: targets.sources });
      const compiler = await analyzeJavaSources({ javaHome: scope.javaHome, classpath: scope.classpath,
        release: scope.release, storagePath, sources: [{ uri: fileUri, text: plan.text }, ...targets.sources], cancellation,
        manifestLimit: 256 * 1024 });
      if (compiler.errors.length) throw Error('Generated Java source failed compiler validation: ' + compiler.errors[0].message);
      const owner = packageName + '.' + name;
      const generated = [...plan.relationshipPlan.fields, ...plan.relationshipPlan.relations.map(relation =>
        ({ accessor: relation.accessor, javaClass: relation.javaClass ?? relation.targetType }))];
      if (generated.some(field => !compiler.methods.some(method => method.owner === owner &&
          method.name === 'get' + field.accessor && method.returnType === field.javaClass))) {
        throw Error('The compiler could not confirm every generated Java field type.');
      }
      assertTarget(target, cancellation);
      targets.verify();
      if (scope.sourceFingerprint !== sourceReview(vscode, scope.project, packageName, name)) {
        throw Error('A Java source changed while preparing the preview. Generate again.');
      }
      for (const [id, record] of previews) if (!record.applying && !getPreview(id)) previews.delete(id);
      if (previews.size >= MAX_REVIEWS) throw Error('Apply or discard earlier JPA entity previews before generating more.');
      const id = randomUUID();
      const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: '/' + id + '/' + name + '.java' }).toString();
      const output = { id, uri, fileUri, database: catalog.database, table, name, packageName, text: plan.text,
        notes: plan.mapping.notes, comparison: plan.comparison, keyColumns: plan.mapping.keys.map(field => field.sql),
        relationships: plan.relationshipPlan.relations.map(({ property, cardinality, optional, columns, mode, foreignKey, targetType,
          kind, targetColumns, mappedBy, childTable, joinTable, ownerForeignKey, targetForeignKey }) =>
          ({ property, cardinality, optional, columns, mode, foreignKey, targetType,
            ...(kind === INVERSE ? { kind, childTable, mappedBy } : {}),
            ...(kind === THROUGH ? { kind, joinTable, ownerForeignKey, targetForeignKey, targetColumns } : {}) })) };
      previews.set(id, { createdAt: Date.now(), output, selection, scope, target, targets, plan, compiler, applying: false });
      return structuredClone(output);
    } finally { preparing = false; }
  }

  async function apply(id, cancellation) {
    trusted(cancellation);
    const record = getPreview(id);
    if (!record || record.applying) throw Error('Review a current JPA entity preview before applying it.');
    record.applying = true;
    try {
      const { selection, plan, target, targets } = record;
      assertTarget(target, cancellation);
      targets.verify();
      const current = await projectScope({ ...selection, cancellation });
      if (current.fingerprint !== record.scope.fingerprint || current.sourceFingerprint !== record.scope.sourceFingerprint) {
        throw Error('The Java source or project changed after review. Generate a new preview.');
      }
      record.compiler.validateClasspath();
      const catalog = await database.databaseCatalog();
      assertTarget(target, cancellation);
      if (inspectTable(catalog, selection.table).fingerprint !== plan.mapping.fingerprint) {
        throw Error('The database table changed after review. Generate a new preview.');
      }
      if (selection.relationships.length) {
        let next;
        try { next = planEntity({ ...selection, catalog, uri: record.output.fileUri, targetSources: targets.sources }); } catch {}
        if (next?.relationshipPlan.fingerprint !== plan.relationshipPlan.fingerprint) {
          throw Error('Relationship metadata changed after review. Generate a new preview.');
        }
      }
      return await writeTemplateFile({ workspaceRoot: current.folder.uri.fsPath, sourceRoot: current.root.path,
        template: plan.template, name: selection.name, packageName: selection.packageName,
        assertTrusted: () => assertTarget(target, cancellation),
        assertTarget: file => {
          targets.verify();
          if (!sameFile(file, current.file) || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) ||
              buildFingerprint(current.project.root) !== current.project.buildFingerprint ||
              sourceReview(vscode, current.project, selection.packageName, selection.name) !== current.sourceFingerprint) {
            throw Error('The Java source or project changed after review. Generate a new preview.');
          }
        } });
    } finally { previews.delete(id); }
  }

  function discard(id) { if (!previews.get(id)?.applying) return previews.delete(id); return false; }

  const pick = (items, title) => vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  const progress = (title, run) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_, token) => run(token));

  async function chooseRelationships(catalog, name, project) {
    if (catalog.coverage.foreignKeys !== 'loaded') return [];
    const options = [];
    const sameSchema = key => key.referencedSchema === catalog.database;
    for (const table of catalog.tables.filter(item => item.kind === 'table')) {
      const keys = table.foreignKeys.filter(sameSchema);
      if (table.name === name) {
        for (const key of keys.filter(item => item.referencedTable !== name)) {
          options.push({ label: key.name, description: 'Owning association · ' + key.referencedTable,
            targetTable: key.referencedTable, request: { foreignKey: key.name } });
        }
        continue;
      }
      for (const key of keys.filter(item => item.referencedTable === name)) {
        options.push({ label: key.name, description: 'Inverse one-to-many · ' + table.name, targetTable: table.name,
          request: { kind: INVERSE, foreignKey: key.name, childTable: table.name } });
        const other = keys.length === 2 && table.foreignKeys.length === 2 ? keys.find(item => item !== key && item.referencedTable !== name) : undefined;
        if (other && key.columns.length + other.columns.length === table.columns.length) {
          options.push({ label: table.name, description: 'Many-to-many join table · ' + other.referencedTable, targetTable: other.referencedTable,
            request: { kind: THROUGH, joinTable: table.name, ownerForeignKey: key.name, targetForeignKey: other.name } });
        }
      }
    }
    if (!options.length) return [];
    const declarations = chooseableDeclarations(vscode, project, new Set(options.map(item => item.targetTable)));
    const items = options.filter(item => declarations.some(declaration => declaration.table === item.targetTable));
    if (!items.length) return [];
    const selected = await vscode.window.showQuickPick(items, { title: 'JPA Entity · Relationships', canPickMany: true,
      placeHolder: 'Confirm with no selection to keep the foreign-key fields scalar' });
    if (!selected) return undefined;
    if (selected.length > MAX_RELATIONSHIPS) throw Error('Review up to eight owning relationships per generated entity.');
    const relations = [];
    for (const { label, targetTable, request } of selected) {
      const target = await pick(declarations.filter(item => item.table === targetTable).map(item =>
        ({ label: item.targetType, description: item.table, item })), 'Relationship target · ' + label);
      if (!target) return undefined;
      const simple = target.item.targetType.split('.').at(-1);
      const property = await vscode.window.showInputBox({ title: 'Relationship field · ' + label,
        value: simple[0].toLowerCase() + simple.slice(1) + (request.kind ? 'Items' : 'Reference'),
        validateInput: value => validIdentifier(value) ? undefined : 'Enter a valid Java field name.' });
      if (property === undefined) return undefined;
      const relation = { ...request, targetType: target.item.targetType, targetUri: target.item.targetUri, property };
      if (request.kind === INVERSE) {
        relation.mappedBy = await vscode.window.showInputBox({ title: 'Existing child @ManyToOne field · ' + label,
          prompt: 'Field declared on the child with explicit join columns',
          validateInput: value => validIdentifier(value) ? undefined : 'Enter a valid child field name.' });
        if (relation.mappedBy === undefined) return undefined;
      } else if (request.kind !== THROUGH) {
        const ownership = await pick([{ label: 'Scalar fields own writes', mode: 'scalar' },
          { label: 'Association owns writes', mode: 'association' }], 'Foreign key writes · ' + label);
        if (!ownership) return undefined;
        relation.mode = ownership.mode;
      }
      relations.push(relation);
    }
    return relations;
  }

  async function generate(argument) {
    trusted();
    const startingTarget = database.savedQueryTarget();
    const catalog = await database.databaseCatalog();
    const contextTable = typeof argument === 'string' ? argument : argument?.table?.name;
    const table = contextTable || (await pick(catalog.tables.filter(item => item.kind === 'table' && defaultEntityName(item.name))
      .map(item => ({ label: item.name, description: catalog.database })), 'JPA Entity · Database table'))?.label;
    if (!table) return;
    inspectTable(catalog, table);
    const { projects } = await progress('Read Java projects', observedProjects);
    const source = await pick(projects.flatMap(project => project.sourceRoots.filter(root => !root.unavailable &&
      contained(project.root, root.path) && root.packages.some(pkg => !pkg.unresolved && pkg.name !== '(default package)'))
      .map(root => ({ label: root.name, description: project.name, project, root }))), 'JPA Entity · Java source root');
    if (!source) return;
    const pkg = await pick(source.root.packages.filter(item => !item.unresolved && item.name !== '(default package)')
      .map(item => ({ label: item.name })), 'JPA Entity · Java package');
    if (!pkg) return;
    const name = await vscode.window.showInputBox({ title: 'JPA Entity · Class name', value: defaultEntityName(table),
      validateInput: value => validIdentifier(value) ? undefined : 'Enter a valid Java class name.' });
    if (name === undefined) return;
    const relationships = await chooseRelationships(catalog, table, source.project);
    if (relationships === undefined) return;
    assertTarget(startingTarget);
    const preview = await progress('Validate JPA entity source', cancellation => prepare({ table, name, packageName: pkg.label,
      projectUri: source.project.uri, sourceRootId: source.root.id, relationships, cancellation }));
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(preview.uri));
      await vscode.window.showTextDocument(document, { preview: false });
      const button = 'Create Java File';
      const confirmed = await vscode.window.showWarningMessage('Create ' + name + '.java from this reviewed preview?',
        { modal: true, detail: vscode.Uri.parse(preview.fileUri).fsPath + '\n\n' + preview.notes.join('\n') }, button);
      if (confirmed !== button) return;
      const created = await progress('Create reviewed JPA entity', token => apply(preview.id, token));
      await vscode.window.showTextDocument(vscode.Uri.file(created.path));
      return created;
    } finally { discard(preview.id); }
  }

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
    provideTextDocumentContent(uri) {
      const record = getPreview(uri.path.split('/')[1]);
      if (!record || uri.toString() !== record.output.uri) throw Error('This JPA entity preview has expired.');
      return record.output.text;
    }
  }), vscode.commands.registerCommand(GENERATE_ENTITY, async argument => {
    try { return await generate(argument); }
    catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  return { prepare, apply, discard, dispose() { disposed = true; previews.clear(); } };
}

module.exports = { registerEntityScaffolding, GENERATE_ENTITY };
