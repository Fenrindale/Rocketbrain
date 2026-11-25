'use strict';

const { identifier } = require('./schema-rename');

const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_GENERATED_COLUMN' });
const quote = name => '`' + identifier(name).replaceAll('`', '``') + '`';
const numberType = /^(?:(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(?:\(\d{1,3}\))?|(?:DECIMAL|NUMERIC)\(\d{1,2},\d{1,2}\))$/iu;
const generatedKind = /^(VIRTUAL|STORED|PERSISTENT) GENERATED$/iu;
const operators = new Map([['+', 1], ['-', 1], ['*', 2]]);
const tokenPattern = /^(\s+|`(?:[^`]|\x60\x60)+`|\d{1,38}(?:\.\d{1,18})?|[A-Za-z_$][\w$]*|[()+*-])/u;

function mode(column) {
  if (!column?.generationExpression && !generatedKind.test(column?.extra ?? '')) return null;
  const match = generatedKind.exec(column.extra ?? '');
  if (!match || typeof column.generationExpression !== 'string' || !column.generationExpression.trim()) {
    throw fail('The generation expression and the observed storage kind must both be present.');
  }
  return match[1].toUpperCase() === 'VIRTUAL' ? 'virtual' : 'stored';
}

function parsed(expression, available) {
  if (typeof expression !== 'string' || !expression.trim() || Buffer.byteLength(expression) > 1024) {
    throw fail('Enter a generation expression of at most 1024 UTF-8 bytes.');
  }
  const tokens = [];
  let rest = expression;
  while (rest.length) {
    const next = tokenPattern.exec(rest)?.[0];
    if (!next) throw fail('Use signed numeric column names, numeric constants, parentheses, +, - and * for generated columns.');
    rest = rest.slice(next.length);
    if (!/^\s+$/u.test(next)) tokens.push(next);
    if (tokens.length > 96) throw fail('Generated expressions support up to 96 tokens.');
  }
  const references = new Set();
  let at = 0;
  function operand(depth) {
    if (depth > 12) throw fail('Generated-expression nesting exceeds twelve levels.');
    const token = tokens[at++];
    if (token === '(') {
      const inner = arithmetic(0, depth + 1);
      if (tokens[at++] !== ')') throw fail('Generated-expression parentheses are unbalanced.');
      return inner;
    }
    if (token === '+' || token === '-') return '(' + token + operand(depth + 1) + ')';
    if (/^\d/u.test(token ?? '')) return token;
    if (!token || !/^(?:`|[A-Za-z_$])/u.test(token)) throw fail('An exact numeric operand is required.');
    const label = token.startsWith('`') ? token.slice(1, -1).replaceAll('``', '`') : token;
    const column = available.get(label.toLowerCase());
    if (!column || mode(column) || /auto_increment/iu.test(column.extra ?? '') || !numberType.test(column.type)) {
      throw fail('Generated expressions require earlier signed numeric base columns without AUTO_INCREMENT.');
    }
    references.add(column.name);
    return quote(column.name);
  }
  function arithmetic(minimum, depth) {
    let left = operand(depth);
    for (let precedence = operators.get(tokens[at]); precedence >= minimum; precedence = operators.get(tokens[at])) {
      const operator = tokens[at++];
      const right = arithmetic(precedence + 1, depth + 1);
      left = '(' + left + ' ' + operator + ' ' + right + ')';
    }
    return left;
  }
  const sql = arithmetic(0, 0);
  if (at !== tokens.length || !references.size) throw fail('Use a fully resolved numeric expression with at least one base column.');
  return { expression: sql, references };
}

function withColumns(expression, columns) {
  return parsed(expression, new Map(columns.map(column => [column.name.toLowerCase(), column])));
}

function numericExpression(expression, columns) {
  return withColumns(expression, columns).expression;
}

function described(column, columns) {
  const generation = mode(column);
  if (!generation) return null;
  if (!numberType.test(column.type) || column.nullable !== true || column.defaultValue !== null ||
      column.charset || column.collation || column.srsId != null) {
    throw fail('Use a nullable signed integer or DECIMAL generated column without a default, character collation or SRID.');
  }
  const at = columns.indexOf(column);
  if (at < 0) throw fail('The generated column must belong to the reviewed table.');
  return { generation, ...withColumns(column.generationExpression, columns.slice(0, at)) };
}

function definition(column, columns) {
  const value = described(column, columns);
  return value && { generation: value.generation, expression: value.expression };
}

function validate(table, { dialect } = {}) {
  const generated = new Map(), storedInputs = new Set();
  for (const column of table.columns) {
    const value = described(column, table.columns);
    if (!value) continue;
    generated.set(column.name, value.generation);
    if (value.generation === 'stored') for (const input of value.references) storedInputs.add(input);
  }
  const indexed = table.indexes.filter(index => index.columns.some(column => generated.has(column.name)));
  for (const index of indexed) {
    if (index.type !== 'BTREE' || index.unique || index.primaryKey ||
        index.columns.some(column => column.prefixLength != null || ![null, 'A'].includes(column.collation))) {
      throw fail('Generated columns support non-unique ascending BTREE indexes without prefixes.');
    }
  }
  for (const key of table.foreignKeys) {
    const modes = key.columns.map(column => generated.get(column.name));
    if (key.referencedTable === table.name && key.columns.some(column => generated.has(column.referencedColumn))) {
      throw fail('The reviewed foreign-key parent must use ordinary columns.');
    }
    if (modes.includes('virtual')) throw fail('Use stored generated child columns for a reviewed foreign key.');
    const updatesChild = key.onUpdate === 'CASCADE' || key.onUpdate === 'SET NULL' || key.onDelete === 'SET NULL';
    if (modes.includes('stored') && updatesChild) {
      throw fail('Stored generated foreign-key columns require restrictive updates and restrictive or cascading deletes.');
    }
    if (key.columns.some(column => storedInputs.has(column.name)) &&
        (updatesChild || (dialect !== 'mariadb' && key.onDelete === 'CASCADE'))) {
      throw fail('The foreign-key action is unsupported for a child input used by a stored generated column on this server.');
    }
  }
  return new Set(generated.keys());
}

function clause(value, dialect) {
  return ' GENERATED ALWAYS AS (' + value.expression + ') ' + (value.generation === 'virtual' ? 'VIRTUAL' : dialect === 'mariadb' ? 'PERSISTENT' : 'STORED');
}

module.exports = { mode, definition, validate, clause, numericExpression };
