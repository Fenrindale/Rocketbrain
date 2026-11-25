'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scopedName } = require('../db/metadata');
const { validIdentifier, contained } = require('../java/file-templates');
const { buildFingerprint } = require('../java/workbench-model');
const { analyzeJavaSources } = require('../java/signature-compiler');
const { captureRelationshipSources, chooseableDeclarations } = require('./entity-relationship-sources');
const { existingRelationshipSelection, planExistingRelationship, relationshipEntities } = require('./entity-existing-relationships');

const COMMAND = 'rocketbrain.jpa.reviewExistingRelationship';
const warnings = [
  'This review uses explicit Jakarta annotations and observed foreign keys. XML and provider remapping require a separate review.',
  'The inverse collection uses the owning relationship named by mappedBy. Review application lifecycle changes separately.'
];

function registerExistingEntityRelationships(context, vscode, dependencies) {
  const { database, java, observedProjects, compilerScope, storagePath, trusted, assertTarget } = dependencies;
  const reviews = new Map();
  let preparing = false;

  function guardBuild(project) {
    if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file' &&
        !path.relative(project.root, path.dirname(doc.uri.fsPath)) &&
        ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties']
          .includes(path.basename(doc.uri.fsPath)))) throw Error('Save the Java project build files before reviewing this relationship.');
    if (buildFingerprint(project.root) !== project.buildFingerprint) throw Error('The observed Java project changed. Import and review it again.');
  }

  async function prepareExistingRelationship(options) {
    const cancellation = options?.cancellation;
    trusted(cancellation);
    if (preparing) throw Error('Wait for the current JPA relationship review.');
    const selection = existingRelationshipSelection(options);
    preparing = true;
    try {
      const target = database.savedQueryTarget();
      const { runtime, projects } = await observedProjects(cancellation);
      const project = projects.find(item => item.uri === selection.projectUri);
      const folder = project && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
      if (!folder || folder.uri.scheme !== 'file' || !contained(folder.uri.fsPath, project.root)) {
        throw Error('Choose two existing entities in one imported local Java project.');
      }
      const parser = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true });
      const entities = relationshipEntities(selection);
      const files = entities.map(item => {
        const uri = vscode.Uri.parse(item.uri);
        const className = item.type.split('.').at(-1);
        if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
            uri.toString() !== vscode.Uri.file(uri.fsPath).toString() ||
            path.basename(uri.fsPath) !== className + '.java' ||
            vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
          throw Error('Choose canonical Java class files in the same local workspace folder.');
        }
        return uri;
      });
      const sources = captureRelationshipSources(vscode, project, files.map(uri => ({ targetUri:uri.toString() })));
      const docs = await Promise.all(files.map(uri => vscode.workspace.openTextDocument(uri)));
      function verifySources() {
        sources.verify();
        for (const [index, doc] of docs.entries()) {
          const saved = sources.sources[index].text;
          if (doc.isDirty || doc.isClosed || doc.getText() !== saved || parser.decode(fs.readFileSync(files[index].fsPath)) !== saved) {
            throw Error('An existing entity Java source changed or is not saved UTF-8. Review both sources again.');
          }
        }
      }
      guardBuild(project);
      verifySources();
      async function currentPlan(token) {
        assertTarget(target, token);
        const catalogs = selection.kind === 'manyToMany' ?
          { joinProof:await database.relationshipJoinCatalog({ joinSchema:selection.joinSchema, joinTable:selection.joinTable }) } :
          { catalog:await database.databaseCatalog() };
        assertTarget(target, token);
        return planExistingRelationship({ ...catalogs, selection, sources:sources.sources });
      }
      const planned = await currentPlan(cancellation);
      const compiler = await compilerScope(project, runtime, cancellation);
      const editedSources = sources.sources.map((source, index) => {
        const edit = planned.edits[index];
        return { uri:source.uri, text:source.text.slice(0, edit.offset) + edit.text + source.text.slice(edit.offset) };
      });
      const analyzed = await analyzeJavaSources({ ...compiler, storagePath, sources:editedSources,
        cancellation, manifestLimit:256 * 1024 });
      if (analyzed.errors.length) throw Error('The edited Java sources failed compiler validation: ' + analyzed.errors[0].message);
      if (planned.edits.some((edit, index) => !analyzed.methods.some(method => method.owner === entities[index].type &&
          method.name === edit.getter && method.returnType === edit.returnType))) {
        throw Error('The compiler could not confirm the generated relationship types.');
      }
      const preApply = token => {
        assertTarget(target, token);
        guardBuild(project);
        verifySources();
        analyzed.validateClasspath();
      };
      const validate = async token => {
        let next;
        try { next = await currentPlan(token); } catch { assertTarget(target, token); }
        if (next?.fingerprint !== planned.fingerprint) throw Error('The relationship metadata changed after review. Generate new previews.');
        preApply(token);
      };
      preApply(cancellation);
      const plan = await java.refactoring.previewWorkspaceEdit({
        documentChanges:planned.edits.map((edit, index) => {
          const doc = docs[index], at = doc.positionAt(edit.offset);
          const point = { line:at.line, character:at.character };
          return { textDocument:{ uri:edit.uri, version:doc.version }, edits:[{ range:{ start:point, end:point }, newText:edit.text }] };
        })
      }, { title:'JPA relationship · ' + (selection.foreignKey || selection.joinSchema + '.' + selection.joinTable), kind:'refactor.jpa.bidirectional',
        anchorDocument:docs[0], cancellation, validate, preApply, warnings });
      for (const [id, expiresAt] of reviews) if (Date.now() >= expiresAt) reviews.delete(id);
      if (reviews.size >= 10) reviews.delete(reviews.keys().next().value);
      reviews.set(plan.id, plan.expiresAt);
      return { ...plan, relationship:{ ...selection, ownership:planned.ownership } };
    } finally { preparing = false; }
  }

  async function applyExistingRelationship(id, cancellation) {
    trusted(cancellation);
    if (!reviews.has(id)) throw Error('Review the two existing JPA entity changes before applying.');
    reviews.delete(id);
    return java.refactoring.apply(id, cancellation);
  }

  const pick = (items, title) => vscode.window.showQuickPick(items, { title, matchOnDescription:true });
  async function chooseEntity(candidates, table, schema, active, side, fallback) {
    const eligible = candidates.filter(item => item.table === table && (item.catalog || active) === schema);
    if (!eligible.length) throw Error('Choose a local Jakarta entity for ' + schema + '.' + table + '. Use an explicit catalog for cross-schema targets.');
    const candidate = (await pick(eligible.map(item => ({
      label:item.targetType, description:schema + '.' + item.table, item
    })), 'JPA Relationship · ' + side + ' entity'))?.item;
    if (!candidate) return;
    const property = await vscode.window.showInputBox({ title:'JPA Relationship · ' + side + ' field', value:fallback,
      validateInput:value => validIdentifier(value) ? undefined : 'Enter a valid Java field name.' });
    if (property !== undefined) return { uri:candidate.targetUri, type:candidate.targetType, table, property };
  }

  async function chooseChildRelationship(project, destination) {
    const catalog = await database.databaseCatalog();
    assertTarget(destination);
    if (catalog.coverage.foreignKeys !== 'loaded') throw Error('Refresh the active MySQL or MariaDB foreign-key catalog.');
    const tables = new Set(catalog.tables.map(table => table.name));
    const candidates = chooseableDeclarations(vscode, project, tables).filter(item => !item.catalog || item.catalog === catalog.database);
    const mapped = new Set(candidates.map(item => item.table));
    const choices = catalog.tables.filter(table => table.kind === 'table' && mapped.has(table.name)).flatMap(table =>
      table.foreignKeys.filter(key => key.referencedSchema === catalog.database && key.referencedTable !== table.name &&
        mapped.has(key.referencedTable) && key.columns.length > 0)
        .map(key => ({ label:key.name, description:table.name + ' → ' + key.referencedTable, table, key })));
    if (!choices.length) throw Error('No same-schema foreign key with two observed Jakarta entities was found.');
    const choice = await pick(choices, 'JPA Relationship · Child foreign key');
    if (!choice) return;
    const child = await chooseEntity(candidates, choice.table.name, catalog.database, catalog.database, 'Child', 'parentReference');
    if (!child) return;
    const parent = await chooseEntity(candidates, choice.key.referencedTable, catalog.database, catalog.database, 'Parent', 'relatedChildren');
    if (!parent) return;
    return { projectUri:project.uri, child, parent, foreignKey:choice.key.name };
  }

  async function chooseJoinRelationship(project, destination) {
    const qualified = await vscode.window.showInputBox({ title:'JPA Relationship · Join table',
      prompt:'Enter the qualified schema.table name on the current MySQL or MariaDB server',
      validateInput:value => value.split('.').length === 2 && value.split('.').every(scopedName) ?
        undefined : 'Enter lower-case schema.table identifiers.' });
    if (!qualified) return;
    const [joinSchema, joinTable] = qualified.split('.');
    assertTarget(destination);
    const proof = await database.relationshipJoinCatalog({ joinSchema, joinTable });
    assertTarget(destination);
    const { activeDatabase, join, targets } = proof;
    const keys = join.tables[0].foreignKeys;
    const candidates = chooseableDeclarations(vscode, project, new Set(targets.map(item => item.selectedTable)));
    const ownerKey = (await pick(keys.map(item => ({
      label:item.name, description:item.referencedSchema + '.' + item.referencedTable, item
    })), 'JPA Relationship · Owning foreign key'))?.item;
    if (!ownerKey) return;
    const targetKey = keys.find(item => item.name !== ownerKey.name);
    const owner = await chooseEntity(candidates, ownerKey.referencedTable, ownerKey.referencedSchema, activeDatabase, 'Owning', 'relatedEntities');
    if (!owner) return;
    const target = await chooseEntity(candidates, targetKey.referencedTable, targetKey.referencedSchema, activeDatabase, 'Inverse', 'relatedOwners');
    if (!target) return;
    return { kind:'manyToMany', projectUri:project.uri, joinSchema, joinTable,
      owner:{ ...owner, schema:ownerKey.referencedSchema }, target:{ ...target, schema:targetKey.referencedSchema },
      ownerForeignKey:ownerKey.name, targetForeignKey:targetKey.name };
  }

  async function chooseRelationship() {
    trusted();
    const target = database.savedQueryTarget();
    const style = await pick([{ label:'Many-to-one and one-to-many', kind:'direct' },
      { label:'Many-to-many through a qualified join table', kind:'join' }], 'JPA Relationship · Mapping');
    if (!style) return;
    const { projects } = await observedProjects();
    const project = (await pick(projects.map(item => ({ label:item.name, description:item.root, item })), 'JPA Relationship · Java project'))?.item;
    if (!project) return;
    const selection = style.kind === 'join' ? await chooseJoinRelationship(project, target) : await chooseChildRelationship(project, target);
    if (!selection) return;
    assertTarget(target);
    const review = await vscode.window.withProgress({ location:vscode.ProgressLocation.Notification,
      title:'Validate both JPA entity changes', cancellable:true }, (_, cancellation) =>
      prepareExistingRelationship({ ...selection, cancellation }));
    try { return await java.refactoring.review(review); } finally { reviews.delete(review.id); }
  }

  context.subscriptions.push(vscode.commands.registerCommand(COMMAND, async () => {
    try { return await chooseRelationship(); }
    catch (error) { await vscode.window.showErrorMessage(error.message); }
  }));
  return { prepareExistingRelationship, applyExistingRelationship, disposeExistingRelationships() { reviews.clear(); } };
}

module.exports = { COMMAND, registerExistingEntityRelationships };
