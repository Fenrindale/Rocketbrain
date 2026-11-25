'use strict';

const { createHash } = require('node:crypto');
const { scopedName } = require('../db/metadata');
const { validIdentifier } = require('../java/file-templates');
const { lexJava, parseJavaFile } = require('../spring/java');
const { inspectTable } = require('./entity-scaffold');
const { matchForeignKey, makesUnique } = require('./entity-collection-relationships');
const { jakartaAnnotation, targetRequest } = require('./entity-relationships');
const { explicitColumn, primaryKeyProof, referencedKey } = require('./entity-existing-keys');
const { analyzeJPA } = require('./model');

function entitySelection(selection) {
  const { uri, type, table, property, schema } = selection ?? {};
  const request = targetRequest({ targetUri:uri, targetType:type, property });
  if (!scopedName(table) || schema !== undefined && !scopedName(schema)) {
    throw Error('Choose an existing entity with explicit lower-case table and schema identifiers.');
  }
  return { uri:request.targetUri, type:request.targetType, table, property:request.property, ...(schema && { schema }) };
}

const constraintName = name => typeof name === 'string' && name.length > 0 && name.length <= 64 && !name.includes('\0');
const sameEntity = (left, right) => left.uri === right.uri || left.type === right.type;
const relationshipEntities = selection => selection.kind === 'manyToMany' ? [selection.owner, selection.target] : [selection.child, selection.parent];

function existingRelationshipSelection(options = {}) {
  const { kind, foreignKey, projectUri } = options;
  if (typeof projectUri !== 'string' || !projectUri || projectUri.length > 4096) throw Error('Choose one observed Java project.');
  if (kind === 'manyToMany') {
    const { joinSchema, joinTable, ownerForeignKey, targetForeignKey } = options;
    const owner = entitySelection(options.owner), target = entitySelection(options.target);
    if (sameEntity(owner, target) || owner.schema === target.schema && owner.table === target.table ||
        ![joinSchema, joinTable, owner.schema, target.schema].every(scopedName) ||
        ![ownerForeignKey, targetForeignKey].every(constraintName) || ownerForeignKey === targetForeignKey) {
      throw Error('Choose two distinct existing entities and the two exact foreign keys of a qualified join table.');
    }
    return { kind, projectUri, owner, target, joinSchema, joinTable, ownerForeignKey, targetForeignKey };
  }
  const child = entitySelection(options.child), parent = entitySelection(options.parent);
  if (kind !== undefined || sameEntity(child, parent) || child.table === parent.table ||
      child.schema || parent.schema || !constraintName(foreignKey)) {
    throw Error('Choose two distinct entity files and the child’s exact foreign key in one project.');
  }
  return { child, parent, foreignKey, projectUri };
}

function nestedIdentity(source, parsed, type, entity) {
  const identity = entity?.identity;
  if (identity?.kind !== 'id-class' || !identity.className || parsed.issues.length !== 1 ||
      parsed.issues[0] !== 'Nested types are excluded from the Spring model') return false;
  const names = identity.className.split('.');
  const keyName = names.pop();
  if (![type.name, type.fqn].includes(names.join('.'))) return false;
  const tokens = lexJava(source.text).tokens;
  const open = tokens.findIndex(token => token.start === type.start) + 1;
  let depth = 1, nested;
  for (let i = open + 1; i < tokens.length && depth; i++) {
    const word = tokens[i].text;
    if (word === '{') depth++;
    else if (word === '}') depth--;
    if (depth !== 1 || !['class', 'record', 'enum', 'interface'].includes(word) ||
        tokens[i - 1]?.text === '.' || tokens[i + 1]?.kind !== 'id') continue;
    if (nested !== undefined || word !== 'class' || tokens[i + 1].text !== keyName ||
        !['public', 'static'].every(modifier => tokens.slice(i - 2, i).some(token => token.text === modifier))) return false;
    nested = i;
  }
  if (nested === undefined) return false;
  const body = tokens.findIndex((token, i) => i > nested && token.text === '{');
  if (body < 0) return false;
  let end = body, braces = 0;
  do {
    if (tokens[end].text === '{') braces++;
    else if (tokens[end].text === '}') braces--;
    end++;
  } while (braces && end < tokens.length);
  const snippet = source.text.slice(tokens[nested].start, tokens[end - 1].end);
  const key = parseJavaFile({ uri:source.uri, text:snippet });
  if (braces || key.issues.length || key.types.length !== 1) return false;
  const [declaration] = key.types;
  const unqualified = name => name.replace(/^java\.lang\./, '');
  return type.fields.filter(field => jakartaAnnotation(parsed, field, 'Id')).every(field =>
    declaration.fields.some(member => member.name === field.name && unqualified(member.type.raw) === unqualified(field.type.raw)));
}

function inspectEntity(source, target, entity, issues, identity) {
  const parsed = parseJavaFile(source);
  const [type] = parsed.types;
  const provenNestedKey = type && nestedIdentity(source, parsed, type, entity);
  const mappingSupported = entity?.mappingState === 'supported' || provenNestedKey && issues.length === 1 &&
    issues[0] === 'IdClass declaration is external or does not contain every declared identity attribute.';
  if ((parsed.issues.length && !provenNestedKey) || parsed.types.length !== 1 || type.fqn !== target.type || type.superTypes.length ||
      !mappingSupported || !entity.attributesComplete ||
      entity.access !== 'FIELD' || !type.fields.some(field => jakartaAnnotation(parsed, field, identity.embedded ? 'EmbeddedId' : 'Id')) ||
      entity.attributes.some(field => field.status !== 'known' ||
        (field.kind !== 'basic' && !(field.name === identity.embedded && field.kind === 'embedded'))) ||
      entity.columnMappings.some(binding => {
        if (identity.properties?.has(binding.property)) return false;
        const field = type.fields.find(item => item.name === binding.property);
        return !explicitColumn(binding, parsed, field) || binding.storageTable?.physicalName !== target.table;
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
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const joinColumn = (name, reference, nullable, readOnly = false) => '@' + jakarta +
  'JoinColumn(name = ' + name + ', referencedColumnName = ' + JSON.stringify(reference) + ', nullable = ' + nullable +
  (readOnly ? ', insertable = false, updatable = false)' : ')');

function edit(source, placement, lines, returnType) {
  const eol = source.text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([\t ]+)(?:@|private |public |protected )/.exec(source.text)?.[1] ?? '    ';
  const text = eol + lines.map(line => line ? indent + line : '').join(eol) + eol;
  return { uri:source.uri, offset:placement.offset, text, getter:'get' + placement.stem, returnType };
}

function derivedIdentityProof(columns, childMapping, childId, parentEntity, referenced, sourceTable, key) {
  const identityColumns = childMapping.fields.filter(field => field.id && columns.some(column => column.name === field.sql));
  if (!identityColumns.length) return undefined;
  const [column] = columns;
  const leaf = childId.leaves?.get(column.name);
  const [parentId, repeated] = parentEntity.columnMappings.filter(binding => binding.column?.physicalName === column.physicalReference);
  if (columns.length !== 1 || referenced.indexes || parentEntity.identity?.kind !== 'simple' || !leaf ||
      childId.keys.length < 2 || column.nullable || identityColumns[0].identity ||
      sourceTable.foreignKeys.some(other => other !== key && other.columns.some(member => member.name === column.name)) ||
      repeated || !parentId?.id || parentId.column.dbType?.source !== 'basic' || parentId.column.dbType.certainty !== 'known' ||
      leaf.binding.javaType !== parentId.javaType || !leaf.binding.column.insertable || !leaf.binding.column.updatable) {
    throw Error('A derived identity needs one writable EmbeddedId member matching a simple parent primary key and a separate local key member.');
  }
  if (leaf.overridden) throw Error('An EmbeddedId AttributeOverride cannot change the member supplied by MapsId.');
  return { embeddedId:childId.embedded, attribute:leaf.attribute, column:column.name, referencedColumn:column.physicalReference };
}

function embeddedKeyOverrides(roles, identities) {
  return identities.flatMap((identity, index) => identity.overrides?.length ? [{ entity:roles[index].type,
    embeddedId:identity.embedded, columns:identity.overrides }] : []);
}

function planChildRelationship(catalog, selection, [childSource, parentSource], [childEntity, parentEntity], issues, provePrimary) {
  const { child, parent, foreignKey } = selection;
  if (catalog?.coverage?.foreignKeys !== 'loaded') throw Error('Review a catalog with observed foreign keys.');
  const childMapping = inspectTable(catalog, child.table), parentMapping = inspectTable(catalog, parent.table);
  const sourceTable = catalog.tables.find(table => table.name === child.table);
  const targetTable = catalog.tables.find(table => table.name === parent.table);
  const [key, duplicate] = sourceTable.foreignKeys.filter(key => key.name === foreignKey);
  if (!key || duplicate || key.referencedSchema !== catalog.database || key.referencedTable !== parent.table) {
    throw Error('The selected foreign key must reference the parent’s exact primary key or unique key in the active schema.');
  }
  const childId = provePrimary(0, childMapping, catalog.database);
  const parentId = provePrimary(1, parentMapping, catalog.database);
  const childPlacement = inspectEntity(childSource, child, childEntity, issues[0], childId);
  const parentPlacement = inspectEntity(parentSource, parent, parentEntity, issues[1], parentId);
  const referenced = referencedKey(key, targetTable, parentMapping, parentId.keys, parentEntity);
  const columns = matchForeignKey(key, childMapping.fields, referenced.columns, referenced.indexes ? 'unique key' : 'primary key');
  const names = columns.map(column => column.name);
  const optional = columns[0].nullable;
  if (columns.some(column => column.nullable !== optional)) {
    throw Error('The composite foreign key needs the same nullability for each column.');
  }
  if (childMapping.fields.some(field => field.identity && names.includes(field.sql)) ||
      sourceTable.indexes.some(index => makesUnique(index, names))) {
    throw Error('Use a non-unique, non-generated child foreign key with types matching the parent key.');
  }
  const derivedIdentity = derivedIdentityProof(columns, childMapping, childId, parentEntity, referenced, sourceTable, key);
  const scalar = new Map();
  for (const binding of childEntity.columnMappings.filter(item => names.includes(item.column.physicalName) &&
    item.column.physicalName !== derivedIdentity?.column)) {
    const field = childMapping.fields.find(item => item.sql === binding.column.physicalName);
    if (scalar.has(field.sql) || ![field.javaClass, keyTypes[field.type]].includes(binding.javaType) ||
        binding.column.insertable !== true || binding.column.updatable !== true || binding.id) {
      throw Error('An existing foreign-key scalar must be a compatible writable column.');
    }
    scalar.set(field.sql, binding.column.name);
  }
  if (scalar.size && scalar.size !== columns.length) {
    throw Error('For a composite key, existing writable scalars must map all foreign-key columns.');
  }
  const scalarOwned = scalar.size > 0;
  const annotations = columns.map(column => {
    const name = scalar.get(column.name) ?? (derivedIdentity && childId.leaves.get(column.name).binding.column.name);
    return joinColumn(name ? JSON.stringify(name) : quoteSql(column.name), column.reference, column.nullable, scalarOwned);
  });
  const joins = annotations.length === 1 ? annotations :
    ['@' + jakarta + 'JoinColumns({', ...annotations.map((line, i) => '    ' + line + (i + 1 < annotations.length ? ',' : '')), '})'];
  const ownerLines = [
    '@' + jakarta + 'ManyToOne(fetch = ' + jakarta + 'FetchType.LAZY, optional = ' + optional + ')',
    ...(derivedIdentity ? ['@' + jakarta + 'MapsId(' + JSON.stringify(derivedIdentity.attribute) + ')'] : []),
    ...joins,
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
  return { fingerprint:fingerprint([childMapping.fingerprint, parentMapping.fingerprint, sourceTable.indexes, referenced.indexes]),
    referencedKey:referenced.indexes ? { kind:'unique', columns:referenced.columns.map(column => column.sql),
      indexes:referenced.indexes.map(index => index.name) } : { kind:'primary', columns:parentId.keys.map(column => column.sql) },
    ownership:derivedIdentity ? 'derived-identity' : scalarOwned ? 'scalar' : 'association', derivedIdentity,
    embeddedKeyOverrides:embeddedKeyOverrides([child, parent], [childId, parentId]),
    edits:[edit(childSource, childPlacement, ownerLines, parent.type), edit(parentSource, parentPlacement, inverseLines, list)] };
}

function planJoinRelationship(proof, selection, sources, entities, issues, provePrimary) {
  const { joinSchema, joinTable, ownerForeignKey, targetForeignKey, owner, target } = selection;
  const { activeDatabase, join, targets } = proof ?? {};
  if (!scopedName(activeDatabase) || join?.scope !== 'table' || join.selectedTable !== joinTable || join.database !== joinSchema ||
      join.coverage?.foreignKeys !== 'loaded' || !Array.isArray(targets) || targets.length !== 2 ||
      ![joinSchema, owner.schema, target.schema].includes(activeDatabase)) {
    throw Error('Inspect the exact join table and foreign-key endpoints on the active connection.');
  }
  const observed = inspectTable(join, joinTable);
  const table = join.tables.find(value => value.name === joinTable);
  if (table.foreignKeys.length !== 2 || (joinSchema === owner.schema && joinTable === owner.table) ||
      (joinSchema === target.schema && joinTable === target.table)) {
    throw Error('The join table needs exactly two foreign keys and two distinct endpoint tables.');
  }
  function endpoint(entity, keyName, position) {
    const [key, duplicate] = table.foreignKeys.filter(item => item.name === keyName);
    const [catalog, repeated] = targets.filter(item => item.database === entity.schema && item.selectedTable === entity.table);
    if (!key || duplicate || key.referencedSchema !== entity.schema || key.referencedTable !== entity.table ||
        catalog?.scope !== 'table' || repeated) {
      throw Error('Each reviewed Java entity must map the exact table referenced by its selected foreign key.');
    }
    const mapping = inspectTable(catalog, entity.table);
    const identity = provePrimary(position, mapping, entity.schema, entity.schema !== activeDatabase);
    return { mapping, identity, columns:matchForeignKey(key, observed.fields, identity.keys) };
  }
  const left = endpoint(owner, ownerForeignKey, 0);
  const right = endpoint(target, targetForeignKey, 1);
  const all = [...left.columns, ...right.columns];
  const names = all.map(column => column.name);
  if (all.length !== observed.fields.length || all.length !== observed.keys.length || new Set(names).size !== all.length ||
      all.some(column => column.nullable) || observed.fields.some(field => field.identity || field.extra || field.defaultValue != null) ||
      table.indexes.some(index => !index.primaryKey && index.columns.length < all.length && makesUnique(index, names))) {
    throw Error('The join table must contain only the two disjoint foreign keys as its non-null composite primary key without narrower uniqueness.');
  }
  const identities = [left.identity, right.identity];
  const placements = [owner, target].map((role, i) => inspectEntity(sources[i], role, entities[i], issues[i], identities[i]));
  const columns = values => values.map(column => joinColumn(quoteSql(column.name), column.reference, false));
  const accessors = [];
  for (const [i, role] of [owner, target].entries()) {
    const counterpart = i === 0 ? target : owner;
    const type = 'java.util.Set<' + counterpart.type + '>';
    const joins = i === 0 ? [
      '@' + jakarta + 'JoinTable(name = ' + quoteSql(joinTable) + ', catalog = ' + JSON.stringify(joinSchema) + ',',
      '    joinColumns = { ' + columns(left.columns).join(',\n        ') + ' },',
      '    inverseJoinColumns = { ' + columns(right.columns).join(',\n        ') + ' })'
    ].flatMap(line => line.split('\n')) : [];
    const annotation = '@' + jakarta + 'ManyToMany(' + (i === 0 ? '' : 'mappedBy = ' + JSON.stringify(owner.property) + ', ') +
      'fetch = ' + jakarta + 'FetchType.LAZY)';
    accessors.push(edit(sources[i], placements[i], [annotation, ...joins,
      'private ' + type + ' ' + role.property + ' = new java.util.LinkedHashSet<>();', '',
      'public ' + type + ' get' + placements[i].stem + '() { return ' + role.property + '; }'
    ], type));
  }
  return { fingerprint:fingerprint([observed.fingerprint, table.indexes, left.mapping.fingerprint, right.mapping.fingerprint]),
    ownership:'join-table', embeddedKeyOverrides:embeddedKeyOverrides([owner, target], identities), edits:accessors };
}

function planExistingRelationship({ catalog, joinProof, selection, sources }) {
  const roles = relationshipEntities(selection);
  const selected = roles.map(role => sources.find(source => source.uri === role.uri));
  if (selected.some(source => !source)) throw Error('Both reviewed Java sources are required.');
  const model = analyzeJPA(sources, { physicalNaming:'standard' });
  const entities = roles.map(role => model.entities.find(entity => entity.fqn === role.type));
  const issues = selected.map(source => model.issues.filter(issue => issue.uri === source.uri).map(issue => issue.message));
  const provePrimary = (role, mapping, database, requireCatalog) =>
    primaryKeyProof(selected[role], roles[role], mapping, database, entities[role], model, sources, requireCatalog);
  return selection.kind === 'manyToMany' ? planJoinRelationship(joinProof, selection, selected, entities, issues, provePrimary) :
    planChildRelationship(catalog, selection, selected, entities, issues, provePrimary);
}

module.exports = { existingRelationshipSelection, planExistingRelationship, relationshipEntities };
