'use strict';

const { createHash } = require('node:crypto');
const { checkPackage, renderJavaFile, validIdentifier } = require('../java/file-templates');
const { analyzeJPA, compareCatalog } = require('./model');
const { associationRequests, planRelationships } = require('./entity-relationships');

const SQL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const KEY_TYPES = new Set(['Short', 'Integer', 'Long']);
const SCALAR_TYPES = {
  smallint: 'Short', int: 'Integer', bigint: 'Long', date: 'LocalDate', double: 'Double',
  'bit(1)': 'Boolean'
};
const TYPE_IMPORTS = {
  BigDecimal: 'java.math.BigDecimal', LocalDate: 'java.time.LocalDate', LocalDateTime: 'java.time.LocalDateTime'
};
const FIELD_LIMIT = 64;

const cap = word => word[0].toUpperCase() + word.slice(1);
const words = name => name.split('_').filter(Boolean);
const defaultEntityName = table => typeof table === 'string' && SQL_NAME.test(table) ? words(table).map(cap).join('') : '';
const literal = value => JSON.stringify(value);
const delimited = value => literal('"' + value + '"');

function scalar(type) {
  const spelling = typeof type === 'string' ? type.toLowerCase() : '';
  const integer = /^(smallint|int|bigint)(?:\(\d{1,3}\))?$/.exec(spelling);
  const direct = SCALAR_TYPES[integer?.[1] ?? spelling];
  if (typeof direct === 'string') return { java: direct, arguments: [] };
  const chars = /^(?:var)?char\(([1-9]\d{0,4})\)$/.exec(spelling);
  if (chars) return { java: 'String', arguments: ['length = ' + chars[1]] };
  const decimal = /^decimal\(([1-9]\d?),(\d{1,2})\)$/.exec(spelling);
  if (decimal && Number(decimal[1]) <= 65 && Number(decimal[2]) <= Number(decimal[1])) {
    return { java: 'BigDecimal', arguments: ['precision = ' + decimal[1], 'scale = ' + decimal[2]] };
  }
  if (/^datetime(?:\([0-6]\))?$/.test(spelling)) return { java: 'LocalDateTime', arguments: [] };
  return null;
}

function inspectTable(catalog, name) {
  if (catalog?.scope !== 'database' || !catalog.database ||
      !['tables', 'columns', 'indexes'].every(area => catalog.coverage?.[area] === 'loaded')) {
    throw Error('Generation requires a visible MySQL or MariaDB catalog with table, column and index metadata.');
  }
  const [table, duplicate] = catalog.tables.filter(item => item.kind === 'table' && item.name === name);
  if (!table || duplicate || !SQL_NAME.test(name)) {
    throw Error('Choose a visible base table with a lower-case ASCII SQL identifier.');
  }
  if (!table.columns.length || table.columns.length > FIELD_LIMIT) {
    throw Error('Generation supports tables with 1 to ' + FIELD_LIMIT + ' columns.');
  }
  const fields = [], javaNames = new Set(), sqlNames = new Set();
  const columns = [...table.columns].sort((left, right) => left.ordinal - right.ordinal);
  for (const [index, column] of columns.entries()) {
    if (typeof column.name !== 'string' || !SQL_NAME.test(column.name) || sqlNames.has(column.name) ||
        column.ordinal !== index + 1 || typeof column.nullable !== 'boolean') {
      throw Error('The column identifiers or catalog order are unsupported.');
    }
    sqlNames.add(column.name);
    const [first, ...rest] = words(column.name);
    const camel = first + rest.map(cap).join('');
    const property = validIdentifier(camel) ? camel : camel + 'Value';
    if (javaNames.has(property) || !validIdentifier(property)) {
      throw Error('Several SQL columns map to the same or invalid Java field near ' + column.name + '.');
    }
    javaNames.add(property);
    const type = scalar(column.type);
    if (!type) throw Error('Unsupported type for ' + column.name + ': ' + column.type + '.');
    const extra = String(column.extra ?? '').toLowerCase().trim();
    if (!['', 'auto_increment', 'default_generated'].includes(extra)) {
      throw Error('Unsupported generated or special column ' + column.name + '.');
    }
    fields.push({ sql: column.name, property, accessor: cap(property), type: type.java,
      javaClass: TYPE_IMPORTS[type.java] ?? 'java.lang.' + type.java, arguments: type.arguments,
      nullable: column.nullable, id: column.primaryKey === true, identity: extra === 'auto_increment',
      defaultValue: column.defaultValue, ordinal: column.ordinal, sqlType: column.type, extra });
  }
  const [primary, second] = table.indexes.filter(index => index.primaryKey);
  if (!primary || second || !primary.unique || !primary.columns.length) {
    throw Error('Generation requires an observed primary key.');
  }
  const keys = [...primary.columns].sort((left, right) => left.ordinal - right.ordinal).map((column, index) => {
    const field = fields.find(item => item.sql === column.name);
    if (!field?.id || field.nullable !== false || column.ordinal !== index + 1 || column.prefixLength != null) {
      throw Error('The primary-key column and index metadata do not agree. Refresh the catalog.');
    }
    if (!KEY_TYPES.has(field.type)) throw Error('Primary keys must use signed SMALLINT, INT or BIGINT columns.');
    return field;
  });
  if (new Set(keys).size !== keys.length || fields.filter(field => field.id).length !== keys.length) {
    throw Error('The primary-key column and index metadata do not agree. Refresh the catalog.');
  }
  if (fields.some(field => field.identity && (!field.id || keys.length !== 1 || field.type === 'Short'))) {
    throw Error('AUTO_INCREMENT requires a single signed INT or BIGINT primary key.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ database: catalog.database, name,
    engine: table.engine, fields, keys: keys.map(key => key.sql), foreignKeys: table.foreignKeys,
    foreignKeysCoverage: catalog.coverage.foreignKeys })).digest('hex');
  const notes = ['The entity uses the datasource’s default database. The reviewed catalog is ' + catalog.database + '.',
    'The class maps existing columns. Review application naming, persistence-unit and database-default settings before using it.'];
  if (table.foreignKeys?.length) notes.push('Foreign-key columns are scalar fields. Review associations separately.');
  if (catalog.coverage.foreignKeys !== 'loaded') notes.push('Foreign-key metadata was unavailable to the current account.');
  return { fields, keys, fingerprint, notes };
}

function idClass(keys) {
  const fields = keys.map(field => '        public ' + field.type + ' ' + field.property + ';');
  const args = keys.map(field => field.type + ' ' + field.property).join(', ');
  const assigns = keys.map(field => '            this.' + field.property + ' = ' + field.property + ';');
  const equality = keys.map(field => 'Objects.equals(this.' + field.property + ', key.' + field.property + ')');
  return [
    '    public static class PrimaryKey implements Serializable {',
    '        private static final long serialVersionUID = 1L;', '', ...fields, '',
    '        public PrimaryKey() {', '        }', '', '        public PrimaryKey(' + args + ') {', ...assigns, '        }', '',
    '        @Override', '        public boolean equals(Object other) {',
    '            if (!(other instanceof PrimaryKey)) return false;', '            PrimaryKey key = (PrimaryKey) other;',
    '            return ' + equality.join('\n                && ') + ';', '        }', '',
    '        @Override', '        public int hashCode() {',
    '            return Objects.hash(' + keys.map(field => field.property).join(', ') + ');', '        }', '    }', ''
  ];
}

function associationLines(relation) {
  const annotations = relation.columns.map(column => {
    const args = ['name = ' + delimited(column.name), 'referencedColumnName = ' + literal(column.reference), 'nullable = ' + column.nullable];
    if (relation.mode === 'scalar') args.push('insertable = false', 'updatable = false');
    return '@JoinColumn(' + args.join(', ') + ')';
  });
  const join = annotations.length === 1 ? ['    ' + annotations[0]] :
    ['    @JoinColumns({', '        ' + annotations.join(',\n        '), '    })'];
  return ['    @' + relation.cardinality + '(fetch = FetchType.LAZY, optional = ' + relation.optional + ')', ...join,
    '    private ' + relation.targetType + ' ' + relation.property + ';', ''];
}

function classBody(table, mapping, relationshipPlan) {
  const { keys } = mapping;
  const { fields, relations } = relationshipPlan;
  const composite = keys.length > 1;
  const imports = new Set(['jakarta.persistence.Column', 'jakarta.persistence.Entity', 'jakarta.persistence.Id', 'jakarta.persistence.Table']);
  if (fields.some(field => field.identity)) {
    imports.add('jakarta.persistence.GeneratedValue');
    imports.add('jakarta.persistence.GenerationType');
  }
  if (composite) {
    imports.add('jakarta.persistence.IdClass');
    imports.add('java.io.Serializable');
    imports.add('java.util.Objects');
  }
  for (const field of fields) if (TYPE_IMPORTS[field.type]) imports.add(TYPE_IMPORTS[field.type]);
  if (relations.length) {
    imports.add('jakarta.persistence.FetchType');
    imports.add('jakarta.persistence.JoinColumn');
    for (const relation of relations) {
      imports.add('jakarta.persistence.' + relation.cardinality);
      if (relation.columns.length > 1) imports.add('jakarta.persistence.JoinColumns');
    }
  }
  const lines = [...imports].sort().map(name => 'import ' + name + ';');
  lines.push('', '@Entity', '@Table(name = ' + delimited(table) + ')');
  if (composite) lines.push('@IdClass(${name}.PrimaryKey.class)');
  lines.push('public class ${name} {');
  const orderedFields = [...keys, ...fields.filter(field => !field.id)];
  for (const field of orderedFields) {
    if (field.id) lines.push('    @Id');
    if (field.identity) lines.push('    @GeneratedValue(strategy = GenerationType.IDENTITY)');
    const args = ['name = ' + delimited(field.sql), 'nullable = ' + String(field.nullable), ...field.arguments];
    lines.push('    @Column(' + args.join(', ') + ')', '    private ' + field.type + ' ' + field.property + ';', '');
  }
  for (const relation of relations) lines.push(...associationLines(relation));
  lines.push('    public ${name}() {', '    }', '');
  for (const field of orderedFields) {
    const getter = field.accessor;
    lines.push('    public ' + field.type + ' get' + getter + '() {', '        return ' + field.property + ';', '    }', '');
    if (!field.identity) lines.push('    public void set' + getter + '(' + field.type + ' value) {',
      '        this.' + field.property + ' = value;', '    }', '');
  }
  for (const relation of relations) {
    lines.push('    public ' + relation.targetType + ' get' + relation.accessor + '() {',
      '        return ' + relation.property + ';', '    }', '');
    if (relation.mode === 'association') lines.push('    public void set' + relation.accessor + '(' + relation.targetType + ' value) {',
      '        this.' + relation.property + ' = value;', '    }', '');
  }
  if (composite) lines.push(...idClass(keys));
  lines.pop();
  lines.push('}', '');
  return lines.join('\n');
}

function planEntity({ catalog, table, name, packageName, uri, relationships, targetSources = [] }) {
  if (!validIdentifier(name)) throw Error('Use a valid Java class name.');
  if (!checkPackage(packageName)) throw Error('Choose a named Java package.');
  const mapping = inspectTable(catalog, table);
  if (name === 'PrimaryKey' && mapping.keys.length > 1) throw Error('Choose a class name other than PrimaryKey for a composite-key entity.');
  const owner = packageName + '.' + name;
  const relationshipPlan = planRelationships({ catalog, table, mapping, owner, requests: associationRequests(relationships),
    sources: targetSources, inspectTable });
  const template = { name: 'JPA entity from database table', source: 'any', template: '${packageDeclaration}' + classBody(table, mapping, relationshipPlan) };
  const text = renderJavaFile(template, name, packageName);
  const model = analyzeJPA([{ uri, text }, ...targetSources], { physicalNaming: 'standard' });
  const entity = model.entities.find(item => item.fqn === owner);
  const comparison = compareCatalog({ ...model, entities: entity ? [entity] : [] }, catalog);
  const ids = entity?.identity?.attributes;
  if (!entity || entity.table.physicalName !== table || ids?.length !== mapping.keys.length ||
      mapping.keys.some((field, index) => ids[index] !== field.property) || comparison.mismatches.length ||
      new Set(comparison.matches.map(match => match.column)).size !== mapping.fields.length) {
    throw Error('The local JPA mapping check could not confirm the generated table, columns and primary key.');
  }
  for (const relation of relationshipPlan.relations) {
    const bindings = entity.columnMappings.filter(binding => binding.property === relation.property && binding.status === 'known');
    const writable = relation.mode === 'association';
    if (bindings.length !== relation.columns.length || relation.columns.some(column => !bindings.some(binding =>
      binding.column.physicalName === column.name && binding.column.referencedColumnName === column.reference &&
      binding.column.insertable === writable && binding.column.updatable === writable))) {
      throw Error('The local JPA mapping check could not confirm every reviewed relationship column and ownership rule.');
    }
  }
  if (relationshipPlan.relations.length) {
    mapping.notes = mapping.notes.filter(note => !note.startsWith('Foreign-key columns are scalar fields.'));
    mapping.notes.push('Only the selected foreign keys become associations. Other columns remain scalar fields.');
    for (const relation of relationshipPlan.relations) {
      mapping.notes.push(relation.property + ' · ' + relation.cardinality + ' · ' +
        (relation.mode === 'scalar' ? 'Scalar fields own writes' : 'The association owns writes') + '.');
    }
  }
  return { text, template, mapping, relationshipPlan, comparison: comparison.summary };
}

module.exports = { defaultEntityName, inspectTable, planEntity };
