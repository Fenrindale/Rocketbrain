'use strict';

const { parseJavaFile, literal } = require('../spring/java');
const { exactTarget, jakartaAnnotation } = require('./entity-relationships');

const primitives = { Short:'short', Integer:'int', Long:'long' };
const qualifiedName = /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$/;

function embeddedIdentityType(source) {
  const parsed = parseJavaFile(source);
  const fields = parsed.types.flatMap(type => type.fields.filter(field => jakartaAnnotation(parsed, field, 'EmbeddedId')));
  if (!fields.length) return undefined;
  const [field] = fields;
  if (parsed.types.length !== 1 || fields.length !== 1 || field.type.name.length > 420 || !qualifiedName.test(field.type.name)) {
    throw Error('Use a single explicit local Jakarta EmbeddedId field.');
  }
  return field.type.name;
}

function explicitColumn(binding, parsed, field) {
  const column = binding.column;
  return field && binding.status === 'known' && column?.physicalName && !column.columnDefinition &&
    literal(jakartaAnnotation(parsed, field, 'Column'), 'name', null) === column.name;
}

function compatibleType(binding, column) {
  return [column.javaClass, primitives[column.type]].includes(binding.javaType) &&
    binding.column?.dbType?.source === 'basic' && binding.column.dbType.certainty === 'known';
}

function primaryKeyProof(source, role, mapping, database, entity, model, sources, requireCatalog = false) {
  if (entity?.identity?.kind !== 'embedded-id') {
    return { keys:exactTarget(source, role.type, role.table, mapping, database, requireCatalog) };
  }
  const targetName = embeddedIdentityType(source);
  const parsed = parseJavaFile(source), [type] = parsed.types;
  const [attribute, extraId] = entity.attributes.filter(field => field.id);
  if (parsed.issues.length || type?.fqn !== role.type || !jakartaAnnotation(parsed, type, 'Entity') ||
      typeof literal(jakartaAnnotation(parsed, type, 'Table'), 'name', null) !== 'string' ||
      entity.table.physicalName !== role.table || entity.table.schema ||
      entity.table.catalog !== '' && entity.table.catalog !== database || requireCatalog && entity.table.catalog !== database) {
    throw Error('The EmbeddedId entity needs an explicit Jakarta table mapping in the reviewed catalog.');
  }
  if (!targetName || extraId || jakartaAnnotation(parsed, type, 'IdClass') || attribute?.kind !== 'embedded' ||
      attribute.targetFqn !== targetName || entity.derivedIdentityUnknown || entity.mappingState !== 'supported') {
    throw Error('Use one explicit Jakarta EmbeddedId without a derived identity or IdClass.');
  }
  const keyType = model.embeddables.find(item => item.fqn === targetName);
  const keySource = sources.find(item => item.uri === keyType?.uri);
  if (!keySource || keySource.uri === source.uri || keyType.access !== 'FIELD' || !keyType.attributesComplete ||
      keyType.mappingState !== 'supported' || keyType.superFqn || !keyType.attributes.length) {
    throw Error('Observe the standalone Jakarta Embeddable key source with basic field mappings.');
  }
  const parsedKey = parseJavaFile(keySource);
  const [declaration] = parsedKey.types;
  if (parsedKey.issues.length || parsedKey.types.length !== 1 || declaration.fqn !== targetName ||
      declaration.kind !== 'class' || !jakartaAnnotation(parsedKey, declaration, 'Embeddable') ||
      keyType.attributes.some(field => field.kind !== 'basic' || field.status !== 'known' || field.id)) {
    throw Error('Use a local Jakarta Embeddable class with explicit basic key columns.');
  }
  const leaves = new Map();
  for (const field of keyType.attributes) {
    const property = attribute.name + '.' + field.name;
    const candidates = entity.columnMappings.filter(item => item.property === property);
    const [binding] = candidates;
    const declarationField = declaration.fields.find(item => item.name === field.name);
    if (candidates.length !== 1 || !explicitColumn(binding, parsedKey, declarationField) || !binding.column.primaryKey ||
        binding.storageTable?.physicalName !== role.table || leaves.has(binding.column.physicalName)) {
      throw Error('EmbeddedId columns must be explicit, unmodified and unique in the primary table.');
    }
    leaves.set(binding.column.physicalName, binding);
  }
  if (leaves.size !== mapping.keys.length) throw Error('EmbeddedId must cover the complete observed primary key.');
  const keys = mapping.keys.map(column => {
    const binding = leaves.get(column.sql);
    if (!binding || !compatibleType(binding, column) ||
        entity.columnMappings.some(item => item !== binding && item.column?.physicalName === column.sql)) {
      throw Error('EmbeddedId columns and types must match the observed primary key without duplicate bindings.');
    }
    return { ...column, declared:binding.column.name };
  });
  return { keys, embedded:attribute.name, properties:new Set([...leaves.values()].map(binding => binding.property)) };
}

function referencedKey(foreignKey, table, mapping, keys, entity) {
  const columns = [...foreignKey.columns].sort((a, b) => a.ordinal - b.ordinal).map(column => column.referencedColumn);
  if (columns.length === keys.length && columns.every(name => keys.some(key => key.sql === name))) {
    return { columns:keys };
  }
  const indexes = table.indexes.filter(index => {
    if (!index.unique || index.primaryKey || index.columns.length !== columns.length) return false;
    const indexed = [...index.columns].sort((a, b) => a.ordinal - b.ordinal);
    return indexed.every((column, position) => column.ordinal === position + 1 &&
      column.prefixLength == null && column.name === columns[position]);
  });
  if (!indexes.length || !columns.length || new Set(columns).size !== columns.length) {
    throw Error('The foreign key must cover a complete ordered non-prefix primary or unique key.');
  }
  const alternate = columns.map(name => {
    const column = mapping.fields.find(item => item.sql === name);
    const bindings = entity.columnMappings.filter(item => item.column?.physicalName === name &&
      item.storageTable?.physicalName === table.name);
    const [binding] = bindings;
    if (!column || column.nullable || column.identity || !['Short','Integer','Long','String'].includes(column.type) ||
        bindings.length !== 1 || binding.column.primaryKey || !compatibleType(binding, column)) {
      throw Error('The unique key needs non-null explicit matching basic Java columns on the referenced table.');
    }
    return { ...column, declared:binding.column.name };
  });
  return { columns:alternate, indexes };
}

module.exports = { embeddedIdentityType, explicitColumn, primaryKeyProof, referencedKey };
