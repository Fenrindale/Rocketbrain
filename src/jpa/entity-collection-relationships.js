'use strict';

const { createHash } = require('node:crypto');
const { validIdentifier } = require('../java/file-templates');
const { parseJavaFile, literal } = require('../spring/java');
const { analyzeJPA } = require('./model');
const { nested } = require('./mapping');
const { MAX_RELATIONSHIPS, associationRequests, targetRequest, exactTarget, jakartaAnnotation } = require('./entity-relationships');

const INVERSE = 'inverseOneToMany';
const THROUGH = 'joinTableManyToMany';
const databaseName = name => typeof name === 'string' && name.length > 0 && name.length <= 64;
const quoted = name => '"' + name + '"';

function relationshipRequests(value = []) {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) throw Error('Review up to eight relationships per generated entity.');
  return value.map(request => {
    const { kind, foreignKey, childTable, mappedBy, joinTable, ownerForeignKey, targetForeignKey } = request ?? {};
    if (kind === undefined) return associationRequests([request])[0];
    if (kind === INVERSE && databaseName(foreignKey) && databaseName(childTable) && validIdentifier(mappedBy)) {
      return { kind, ...targetRequest(request), foreignKey, childTable, mappedBy };
    }
    if (kind === THROUGH && databaseName(joinTable) && databaseName(ownerForeignKey) && databaseName(targetForeignKey) &&
        ownerForeignKey !== targetForeignKey) {
      return { kind, ...targetRequest(request), joinTable, ownerForeignKey, targetForeignKey };
    }
    throw Error('Choose a supported explicit collection relationship and its foreign keys.');
  });
}

function findTable(catalog, name) {
  const matches = catalog.tables.filter(table => table.kind === 'table' && table.name === name);
  if (matches.length !== 1) throw Error('Use a base table visible in the current catalog.');
  return matches[0];
}

function findFk(table, name, database) {
  const matches = table.foreignKeys.filter(key => key.name === name);
  if (matches.length !== 1 || matches[0].referencedSchema !== database) {
    throw Error('Use an exact foreign key in the current catalog.');
  }
  return matches[0];
}

function matchForeignKey(key, fields, ids) {
  const columns = [...key.columns].sort((a, b) => a.ordinal - b.ordinal);
  if (columns.length !== ids.length || new Set(columns.map(column => column.name)).size !== columns.length) {
    throw Error('The foreign key must cover the exact referenced primary key.');
  }
  return columns.map((column, index) => {
    const field = fields.find(item => item.sql === column.name);
    const target = ids[index];
    if (column.ordinal !== index + 1 || !field || column.referencedColumn !== target.sql || field.type !== target.type) {
      throw Error('Foreign key types and order must match the referenced primary key.');
    }
    return { name: field.sql, reference: target.declared, physicalReference: target.sql, nullable: field.nullable };
  });
}

function physicalReference(name) {
  const marker = name?.at(0);
  return ['"', '`'].includes(marker) && name.at(-1) === marker ? name.slice(1, -1) : name;
}

function makesUnique(index, names) {
  return index.unique && index.columns.length && index.columns.every(column =>
    column.prefixLength == null && names.includes(column.name));
}

function inverse(request, context, source) {
  const { catalog, table, owner, ownerSource, ownerKeys, inspectTable } = context;
  const { childTable, targetType, mappedBy } = request;
  const child = findTable(catalog, childTable);
  const key = findFk(child, request.foreignKey, catalog.database);
  if (key.referencedTable !== table || childTable === table) throw Error('Choose a child foreign key that references the generated entity table.');
  const childMapping = inspectTable(catalog, childTable);
  exactTarget(source, targetType, childTable, childMapping, catalog.database);
  const columns = matchForeignKey(key, childMapping.fields, ownerKeys);
  const names = columns.map(column => column.name);
  if (child.indexes.some(index => makesUnique(index, names))) throw Error('An inverse one-to-many requires a child foreign key without a uniqueness constraint.');
  const parsed = parseJavaFile(source);
  const declaration = parsed.types.find(type => type.fqn === targetType);
  const field = declaration.fields.find(member => member.name === mappedBy);
  if (!field || !jakartaAnnotation(parsed, field, 'ManyToOne')) throw Error('mappedBy must name the child’s explicit @ManyToOne field.');
  const single = jakartaAnnotation(parsed, field, 'JoinColumn');
  const plural = jakartaAnnotation(parsed, field, 'JoinColumns');
  const declarations = single && !plural ? [single] : plural && !single ? nested(plural.attributes.value, parsed) : [];
  if (declarations.length !== columns.length || declarations.some((join, index) =>
    physicalReference(literal(join, 'name', null)) !== columns[index].name ||
    physicalReference(literal(join, 'referencedColumnName', null)) !== columns[index].physicalReference)) {
    throw Error('The mappedBy field needs explicit join names matching the verified foreign key in order.');
  }
  const model = analyzeJPA([ownerSource, source], { physicalNaming: 'standard' });
  const entity = model.entities.find(entity => entity.fqn === targetType);
  const mapped = entity?.attributes.find(attribute => attribute.name === mappedBy && attribute.kind === 'manyToOne');
  const bindings = entity?.columnMappings.filter(binding => binding.property === mappedBy);
  if (!mapped || mapped.status !== 'known' || mapped.targetFqn !== owner || mapped.id || bindings?.length !== columns.length ||
      columns.some(column => !bindings.some(binding => binding.status === 'known' && binding.storageTable?.physicalName === childTable &&
        binding.column.physicalName === column.name && binding.column.insertable === true && binding.column.updatable === true)) ||
      entity.columnMappings.some(binding => binding.property !== mappedBy && binding.storageTable?.physicalName === childTable &&
        names.includes(binding.column?.physicalName) && (binding.column.insertable !== false || binding.column.updatable !== false))) {
    throw Error('mappedBy must bind the generated entity through the child’s only writable foreign-key mapping.');
  }
  return { ...request, cardinality: 'OneToMany', mode: 'inverse', columns, targetFingerprint: childMapping.fingerprint };
}

function through(request, context, source) {
  const { catalog, table, ownerKeys, inspectTable } = context;
  const join = findTable(catalog, request.joinTable);
  if (join.foreignKeys.length !== 2) throw Error('Choose a join table with exactly two foreign keys.');
  const ownerFk = findFk(join, request.ownerForeignKey, catalog.database);
  const targetFk = findFk(join, request.targetForeignKey, catalog.database);
  if (ownerFk.referencedTable !== table || targetFk.referencedTable === table || join.name === table || join.name === targetFk.referencedTable) {
    throw Error('Choose distinct owner, join and target tables for the many-to-many relationship.');
  }
  const target = inspectTable(catalog, targetFk.referencedTable);
  const targetKeys = exactTarget(source, request.targetType, targetFk.referencedTable, target, catalog.database);
  const observed = inspectTable(catalog, join.name);
  const columns = matchForeignKey(ownerFk, observed.fields, ownerKeys);
  const targetColumns = matchForeignKey(targetFk, observed.fields, targetKeys);
  const all = [...columns, ...targetColumns];
  if (all.length !== observed.fields.length || all.length !== observed.keys.length ||
      all.some(column => column.nullable) || new Set(all.map(column => column.name)).size !== all.length ||
      observed.fields.some(field => field.identity || field.extra || field.defaultValue != null)) {
    throw Error('The join table must contain exactly the two foreign keys as its non-null composite primary key.');
  }
  if (join.indexes.some(index => !index.primaryKey && index.unique && index.columns.length < all.length &&
      index.columns.every(column => all.some(field => field.name === column.name)))) {
    throw Error('The join table has a narrower uniqueness constraint that changes many-to-many cardinality.');
  }
  return { ...request, cardinality: 'ManyToMany', mode: 'join-table', columns, targetColumns,
    targetFingerprint: target.fingerprint, joinFingerprint: observed.fingerprint };
}

function planCollections({ requests, catalog, table, mapping, owner, ownerSource, sources, direct, inspectTable }) {
  if (!requests.length) return { relations: [], fingerprint: null };
  if (catalog.coverage.foreignKeys !== 'loaded') throw Error('Collection relationships require loaded foreign key metadata.');
  const occupied = new Set([...mapping.fields, ...direct].map(value => value.accessor));
  const used = new Set();
  const ownerKeys = mapping.keys.map(key => ({ ...key, declared: quoted(key.sql) }));
  const context = { catalog, table, owner, ownerKeys, ownerSource, inspectTable };
  const relations = requests.map(request => {
    const accessor = request.property[0].toUpperCase() + request.property.slice(1);
    const counterpart = request.kind === INVERSE ? [request.childTable, request.foreignKey] : [request.joinTable];
    const key = JSON.stringify(counterpart);
    if (occupied.has(accessor) || accessor === 'Class' || request.targetType === owner || used.has(key)) {
      throw Error('Choose distinct relationship names, target entities and foreign-key roles.');
    }
    occupied.add(accessor);
    used.add(key);
    const source = sources.find(item => item.uri === request.targetUri);
    if (!source) throw Error('The relationship target Java source is unavailable.');
    const relation = request.kind === INVERSE ? inverse(request, context, source) : through(request, context, source);
    const container = request.kind === INVERSE ? 'List' : 'Set';
    return { ...relation, accessor, container, javaClass: 'java.util.' + container + '<' + request.targetType + '>' };
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(relations)).digest('hex');
  return { relations, fingerprint };
}

module.exports = { INVERSE, THROUGH, relationshipRequests, planCollections };
