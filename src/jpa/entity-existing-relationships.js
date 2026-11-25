'use strict';

const { createHash } = require('node:crypto');
const { validIdentifier } = require('../java/file-templates');
const { lexJava, literal, parseJavaFile } = require('../spring/java');
const { inspectTable } = require('./entity-scaffold');
const { exactTarget, jakartaAnnotation, targetRequest } = require('./entity-relationships');
const { analyzeJPA } = require('./model');

function entitySelection(selection) {
  const { uri, type, table, property } = selection ?? {};
  const request = targetRequest({ targetUri:uri, targetType:type, property });
  if (typeof table !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(table)) {
    throw Error('Choose an existing entity with an explicit lower-case table name.');
  }
  return { uri:request.targetUri, type:request.targetType, table, property:request.property };
}

function existingRelationshipSelection(options = {}) {
  const { foreignKey, projectUri } = options;
  const child = entitySelection(options.child), parent = entitySelection(options.parent);
  if (child.uri === parent.uri || child.type === parent.type || child.table === parent.table ||
      typeof foreignKey !== 'string' || !foreignKey.length || foreignKey.length > 64 || foreignKey.includes('\0') ||
      typeof projectUri !== 'string' || projectUri.length > 4096) {
    throw Error('Choose two distinct entity files and the child’s exact foreign key in one project.');
  }
  return { child, parent, foreignKey, projectUri };
}

function inspectEntity(source, target, entity) {
  const parsed = parseJavaFile(source);
  const [type] = parsed.types;
  if (parsed.issues.length || parsed.types.length !== 1 || type.fqn !== target.type || type.superTypes.length ||
      !entity || entity.mappingState !== 'supported' || !entity.attributesComplete ||
      entity.access !== 'FIELD' || !type.fields.some(field => jakartaAnnotation(parsed, field, 'Id')) ||
      entity.attributes.some(field => field.kind !== 'basic' || field.status !== 'known') ||
      entity.columnMappings.some(binding => {
        const field = type.fields.find(item => item.name === binding.property);
        return !field || binding.status !== 'known' || binding.storageTable?.physicalName !== target.table ||
          !binding.column?.physicalName || binding.column.columnDefinition ||
          literal(jakartaAnnotation(parsed, field, 'Column'), 'name', null) !== binding.column.name;
      })) {
    throw Error('Both entities need unambiguous Jakarta field access and explicit basic columns on their own table.');
  }
  const tokens = lexJava(source.text).tokens;
  const declaredAt = tokens.findIndex(token => token.start === type.start);
  if (tokens[declaredAt + 1]?.text !== '{' || ['final', 'sealed', 'abstract'].some(modifier =>
    tokens.slice(0, declaredAt - 1).reverse().slice(0, 3).some(token => token.text === modifier))) {
    throw Error('Use a plain concrete top-level entity class.');
  }
  const property = target.property;
  const stem = property[0].toUpperCase() + property.slice(1);
  const names = [property, 'get' + stem, 'set' + stem, 'is' + stem];
  if (!names.every(validIdentifier) || stem === 'Class' || tokens.some(token => token.kind === 'id' && names.includes(token.text))) {
    throw Error('The relationship field or accessor would collide with an existing Java name.');
  }
  const closing = tokens.at(-1);
  if (closing.text !== '}') throw Error('Use an entity with a directly editable class body.');
  // Insert before the existing closing brace line so its indentation stays untouched.
  const base = source.text.lastIndexOf('\n', closing.start - 1) + 1;
  const offset = /^[\t ]*$/.test(source.text.slice(base, closing.start)) ? base : closing.start;
  return { offset, stem };
}

const keyTypes = { Short:'short', Integer:'int', Long:'long' };
const quoteSql = name => JSON.stringify('"' + name + '"');
const jakarta = 'jakarta.persistence.';

function planExistingRelationship({ catalog, selection, sources }) {
  const { child, parent, foreignKey } = selection;
  if (catalog?.coverage?.foreignKeys !== 'loaded') throw Error('Review a catalog with observed foreign keys.');
  const bindings = new Map(sources.map(source => [source.uri, source]));
  const childSource = bindings.get(child.uri), parentSource = bindings.get(parent.uri);
  if (!childSource || !parentSource) throw Error('Both reviewed Java sources are required.');
  const childMapping = inspectTable(catalog, child.table), parentMapping = inspectTable(catalog, parent.table);
  if (childMapping.keys.length !== 1 || parentMapping.keys.length !== 1) {
    throw Error('The existing-entity review requires two direct single-column primary keys.');
  }
  exactTarget(childSource, child.type, child.table, childMapping, catalog.database);
  const [parentId] = exactTarget(parentSource, parent.type, parent.table, parentMapping, catalog.database);
  const sourceTable = catalog.tables.find(table => table.name === child.table);
  const keys = sourceTable.foreignKeys.filter(key => key.name === foreignKey);
  const [key] = keys, [join] = key?.columns ?? [];
  if (keys.length !== 1 || key.referencedSchema !== catalog.database || key.referencedTable !== parent.table ||
      key.columns.length !== 1 || join.ordinal !== 1 || join.referencedColumn !== parentId.sql) {
    throw Error('The selected foreign key must reference the parent’s exact primary key in the active schema.');
  }
  const field = childMapping.fields.find(item => item.sql === join.name);
  if (!field || field.id || field.type !== parentId.type ||
      sourceTable.indexes.some(index => index.unique && index.columns.length === 1 && index.columns[0].name === field.sql)) {
    throw Error('Use a non-unique, non-identity child foreign key with the same signed type as the parent primary key.');
  }
  const model = analyzeJPA(sources, { physicalNaming:'standard' });
  const childEntity = model.entities.find(entity => entity.fqn === child.type);
  const parentEntity = model.entities.find(entity => entity.fqn === parent.type);
  const childPlacement = inspectEntity(childSource, child, childEntity);
  const parentPlacement = inspectEntity(parentSource, parent, parentEntity);
  const scalar = childEntity.columnMappings.filter(binding => binding.column.physicalName === field.sql);
  if (scalar.length > 1 || scalar.some(binding => ![field.javaClass, keyTypes[field.type]].includes(binding.javaType) ||
    binding.column.insertable !== true || binding.column.updatable !== true || binding.id)) {
    throw Error('An existing foreign-key scalar must be a single compatible writable column.');
  }
  const scalarOwned = scalar.length === 1;
  const ownerLines = [
    '@' + jakarta + 'ManyToOne(fetch = ' + jakarta + 'FetchType.LAZY, optional = ' + field.nullable + ')',
    '@' + jakarta + 'JoinColumn(name = ' + (scalarOwned ? JSON.stringify(scalar[0].column.name) : quoteSql(field.sql)) +
      ', referencedColumnName = ' + JSON.stringify(parentId.declared) + ', nullable = ' + field.nullable +
      (scalarOwned ? ', insertable = false, updatable = false)' : ')'),
    'private ' + parent.type + ' ' + child.property + ';',
    '',
    'public ' + parent.type + ' get' + childPlacement.stem + '() { return ' + child.property + '; }',
    ...scalarOwned ? [] : ['', 'public void set' + childPlacement.stem + '(' + parent.type + ' value) { this.' + child.property + ' = value; }']
  ];
  const list = 'java.util.List<' + child.type + '>';
  const inverseLines = [
    '@' + jakarta + 'OneToMany(mappedBy = ' + JSON.stringify(child.property) + ', fetch = ' + jakarta + 'FetchType.LAZY)',
    'private ' + list + ' ' + parent.property + ' = new java.util.ArrayList<>();',
    '',
    'public ' + list + ' get' + parentPlacement.stem + '() { return ' + parent.property + '; }'
  ];
  function edit(source, placement, lines, returnType) {
    const eol = source.text.includes('\r\n') ? '\r\n' : '\n';
    const indent = /\n([\t ]+)(?:@|private |public |protected )/.exec(source.text)?.[1] ?? '    ';
    const text = eol + lines.map(line => line ? indent + line : '').join(eol) + eol;
    return { uri:source.uri, offset:placement.offset, text, getter:'get' + placement.stem, returnType };
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    childMapping:childMapping.fingerprint, parentMapping:parentMapping.fingerprint, childIndexes:sourceTable.indexes
  })).digest('hex');
  return { fingerprint, ownership:scalarOwned ? 'scalar' : 'association',
    edits:[edit(childSource, childPlacement, ownerLines, parent.type), edit(parentSource, parentPlacement, inverseLines, list)] };
}

module.exports = { existingRelationshipSelection, planExistingRelationship };
