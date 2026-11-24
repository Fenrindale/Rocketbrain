'use strict';

const { createHash } = require('node:crypto');
const { validIdentifier } = require('../java/file-templates');
const { parseJavaFile, literal } = require('../spring/java');
const { scopedName } = require('../db/metadata');
const { analyzeJPA } = require('./model');

const MAX_RELATIONSHIPS = 8;
const SELF = 'selfReference';
const CROSS = 'crossSchemaAssociation';
const KEY_PRIMITIVES = { 'java.lang.Long': 'long', 'java.lang.Integer': 'int', 'java.lang.Short': 'short' };
const directRelationship = request => request?.kind === undefined || request.kind === SELF || request.kind === CROSS;

function jakartaAnnotation(parsed, declaration, name) {
  return declaration.annotations.find(item => item.name === 'jakarta.persistence.' + name ||
    (parsed.wildcards.includes('jakarta.persistence') && !parsed.imports[name] && item.shortName === name &&
      item.name === parsed.packageName + '.' + name));
}

function targetDeclarations(source) {
  const parsed = parseJavaFile(source);
  return parsed.types.flatMap(type => {
    const table = jakartaAnnotation(parsed, type, 'Table');
    const name = literal(table, 'name', null);
    if (typeof name !== 'string' || !jakartaAnnotation(parsed, type, 'Entity') || type.kind !== 'class') return [];
    const quote = name.at(0);
    const physical = ['"', '`'].includes(quote) && name.at(-1) === quote ? name.slice(1, -1) : name;
    const catalog = literal(table, 'catalog', '');
    return [{ targetType: type.fqn, table: physical, targetUri: source.uri, ...(catalog ? { catalog } : {}) }];
  });
}

function targetRequest(request = {}) {
  const { targetUri, targetType, property } = request;
  if (typeof targetUri !== 'string' || !targetUri.startsWith('file:') || targetUri.length > 4096 ||
      typeof targetType !== 'string' || targetType.length > 420 || !targetType.includes('.') ||
      !targetType.split('.').every(validIdentifier) || !validIdentifier(property)) {
    throw Error('Choose an observed local Java target entity and its Java field name.');
  }
  return { targetUri, targetType, property };
}

function associationRequests(value = []) {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) throw Error('Review up to eight owning relationships per generated entity.');
  return value.map(request => {
    const { foreignKey, mode, kind, targetSchema, targetTable } = request ?? {};
    if (typeof foreignKey !== 'string' || !foreignKey || foreignKey.length > 64 || !['scalar', 'association'].includes(mode)) {
      throw Error('Choose an observed foreign key, a local Java target entity and its ownership mode.');
    }
    if (kind === SELF) return { kind, foreignKey, mode, property: validatedProperty(request.property) };
    if (kind === CROSS) {
      if (![targetSchema, targetTable].every(scopedName)) throw Error('Specify the exact target schema and table for a cross-schema relationship.');
      return { kind, foreignKey, targetSchema, targetTable, ...targetRequest(request), mode };
    }
    if (kind !== undefined) throw Error('Choose a supported owning relationship.');
    return { foreignKey, ...targetRequest(request), mode };
  });
}

function validatedProperty(property) {
  if (!validIdentifier(property)) throw Error('Choose a valid Java relationship field name.');
  return property;
}

function exactTarget(source, targetType, targetTable, targetMapping, database, requireCatalog = false) {
  if (!source) throw Error('The selected relationship target Java source is unavailable.');
  const parsed = parseJavaFile(source);
  const selected = parsed.types.filter(type => type.fqn === targetType);
  const [declaration] = selected;
  const annotation = (type, name) => jakartaAnnotation(parsed, type, name);
  if (selected.length !== 1 || !annotation(declaration, 'Entity') || !annotation(declaration, 'Table') ||
      literal(annotation(declaration, 'Table'), 'name', null) == null || declaration.kind !== 'class') {
    throw Error('The target needs one explicit Jakarta @Entity class with a literal @Table declaration.');
  }
  const entity = analyzeJPA([source], { physicalNaming: 'standard' }).entities.find(item => item.fqn === targetType);
  if (requireCatalog && (entity?.table?.catalog !== database || entity?.table?.schema !== '')) {
    throw Error('A cross-schema target needs an explicit matching @Table(catalog = ...) declaration.');
  }
  if (!entity || entity.providerMappingUnknown || !entity.attributesComplete || entity.table.physicalName !== targetTable ||
      [entity.table.schema, entity.table.catalog].some(name => name !== '' && name !== database) ||
      entity.access !== 'FIELD' || entity.derivedIdentityUnknown ||
      entity.identity?.kind !== (targetMapping.keys.length > 1 ? 'id-class' : 'simple') ||
      targetMapping.keys.length > 1 && !annotation(declaration, 'IdClass')) {
    throw Error('The target entity mapping does not match the referenced table and supported primary-key layout.');
  }
  const attributes = entity.attributes.filter(field => field.id);
  if (attributes.length !== targetMapping.keys.length || attributes.some(field => field.kind !== 'basic')) {
    throw Error('The relationship requires direct basic target ID fields.');
  }
  return targetMapping.keys.map(key => {
    const candidates = entity.columnMappings.filter(binding => binding.status === 'known' && binding.id &&
      binding.storageTable?.physicalName === targetTable && binding.column?.physicalName === key.sql);
    const [binding] = candidates;
    const field = binding && declaration.fields.find(value => value.name === binding.property);
    const explicit = field && literal(annotation(field, 'Column'), 'name', null);
    if (candidates.length !== 1 || !field || !annotation(field, 'Id') || explicit !== binding.column.name || binding.column.columnDefinition ||
        ![key.javaClass, KEY_PRIMITIVES[key.javaClass]].includes(binding.javaType)) {
      throw Error('The target ID fields need explicit compatible column names and Java types.');
    }
    return { ...key, declared: explicit };
  });
}

function sameColumns(index, columnNames) {
  if (!index.unique || index.columns.length !== columnNames.length) return false;
  return index.columns.every(column => column.prefixLength == null && columnNames.includes(column.name)) &&
    new Set(index.columns.map(column => column.name)).size === columnNames.length;
}

function targetProof({ request, key, active, table, mapping, owner, sources, targets, inspectTable }) {
  const self = request.kind === SELF, cross = request.kind === CROSS;
  const { targetUri, targetType, targetSchema, targetTable } = request;
  if (self) {
    if (key.referencedSchema !== active.database || key.referencedTable !== table) {
      throw Error('An explicit self-reference must target the active table’s own primary key.');
    }
    return { targetType: owner, keys: mapping.keys.map(column => ({ ...column, declared: '"' + column.sql + '"' })),
      targetFingerprint: mapping.fingerprint };
  }
  let selected = active;
  if (cross) {
    const proof = targets.find(item => item.foreignKey === request.foreignKey && item.table === table);
    const columns = [...key.columns].sort((a, b) => a.ordinal - b.ordinal);
    if (targetSchema === active.database || key.referencedSchema !== targetSchema || key.referencedTable !== targetTable ||
        proof?.sourceDatabase !== active.database || proof.targetSchema !== targetSchema || proof.targetTable !== targetTable ||
        proof.catalog?.database !== targetSchema || proof.catalog?.scope !== 'table' || proof.catalog?.selectedTable !== targetTable ||
        proof.sourceColumns?.length !== columns.length || columns.some((column, index) => {
          const observed = proof.sourceColumns[index];
          return observed.name !== column.name || observed.ordinal !== column.ordinal || observed.referencedColumn !== column.referencedColumn;
        })) {
      throw Error('The same connection must prove the exact foreign key and referenced schema/table. Refresh the catalog.');
    }
    selected = proof.catalog;
  } else if (key.referencedSchema !== active.database || key.referencedTable === table) {
    throw Error('Choose a different table in the current catalog or select the explicit self-reference or cross-schema scope.');
  }
  if (targetType === owner) throw Error('A distinct table requires a different target Java entity type.');
  const target = inspectTable(selected, key.referencedTable);
  const keys = exactTarget(sources.find(item => item.uri === targetUri), targetType, key.referencedTable, target,
    selected.database, cross);
  return { targetType, keys, targetFingerprint: target.fingerprint };
}

function planRelationships({ catalog, table, mapping, owner, requests, sources, targets = [], inspectTable }) {
  if (!requests.length) return { fields: mapping.fields, relations: [], fingerprint: null };
  if (catalog.coverage.foreignKeys !== 'loaded') throw Error('Relationship generation requires loaded foreign key metadata.');
  const sourceTable = catalog.tables.find(item => item.name === table && item.kind === 'table');
  const relations = [], usedKeys = new Set(), usedColumns = new Set();
  const occupied = new Set(mapping.fields.map(field => field.accessor));
  const trackedColumns = new Set();
  for (const request of requests) {
    const { foreignKey, property, mode } = request;
    const [key, duplicate] = sourceTable.foreignKeys.filter(item => item.name === foreignKey);
    if (!key || duplicate || usedKeys.has(foreignKey) || !key.columns.length) {
      throw Error('Choose a distinct verified foreign key from the current catalog.');
    }
    usedKeys.add(foreignKey);
    const accessor = property[0].toUpperCase() + property.slice(1);
    if (occupied.has(accessor) || accessor === 'Class') throw Error('Relationship field names must be distinct from each other and scalar fields.');
    occupied.add(accessor);
    const { targetType, keys, targetFingerprint } = targetProof({ request, key, active: catalog, table, mapping,
      owner, sources, targets, inspectTable });
    const joined = [...key.columns].sort((left, right) => left.ordinal - right.ordinal);
    if (joined.length !== keys.length || new Set(joined.map(column => column.referencedColumn)).size !== keys.length) {
      throw Error('The foreign key must cover the exact referenced primary key.');
    }
    const columns = joined.map((column, index) => {
      const field = mapping.fields.find(item => item.sql === column.name);
      const reference = keys.find(item => item.sql === column.referencedColumn);
      if (column.ordinal !== index + 1 || !field || !reference || field.type !== reference.type ||
          column.referencedColumn !== keys[index].sql) throw Error('The foreign key column order or signed types differ from the referenced primary key.');
      if (usedColumns.has(field.sql)) throw Error('Selected foreign keys share a source column. Choose one mapping for that column.');
      usedColumns.add(field.sql);
      if (mode === 'association') {
        if (field.id || field.identity) throw Error('Shared primary key columns require scalar ownership.');
        trackedColumns.add(field.sql);
      }
      return { name: field.sql, reference: reference.declared, physicalReference: reference.sql, nullable: field.nullable };
    });
    if (columns.some(column => column.nullable !== columns[0].nullable)) {
      throw Error('A composite relationship requires consistent nullability across the foreign key.');
    }
    const unique = sourceTable.indexes.filter(index => sameColumns(index, columns.map(column => column.name)))
      .map(index => index.name).sort();
    relations.push({ ...request, targetType, accessor, cardinality: unique.length ? 'OneToOne' : 'ManyToOne',
      optional: columns[0].nullable, columns, unique, targetFingerprint });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(relations)).digest('hex');
  return { fields: mapping.fields.filter(field => !trackedColumns.has(field.sql)), relations, fingerprint };
}

module.exports = { MAX_RELATIONSHIPS, SELF, CROSS, directRelationship, associationRequests, planRelationships, targetDeclarations, targetRequest,
  exactTarget, sameColumns, jakartaAnnotation };
