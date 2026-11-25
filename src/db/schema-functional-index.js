'use strict';

const { numericExpression } = require('./schema-generated-column');

const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_FUNCTIONAL_INDEX' });
const hasExpression = index => index.columns.some(part => part.expression !== undefined);

function supportsExpressionParts(server) {
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(server?.version ?? '');
  return server?.dialect === 'mysql' && Boolean(version && (
    Number(version[1]) > 8 || Number(version[1]) === 8 && (Number(version[2]) > 0 || Number(version[3]) >= 13)
  ));
}

function expressionPart(part, columns) {
  if (part.name !== null || part.prefixLength != null || ![null, 'A'].includes(part.collation) ||
      typeof part.expression !== 'string') throw fail('Use an ascending expression part without a column name or prefix.');
  let sql;
  try { sql = numericExpression(part.expression, columns); }
  catch { throw fail('Use signed numeric base columns, constants, parentheses, and +, - or * in the index expression.'); }
  if (!sql.startsWith('(')) throw fail('Use a calculated index expression with an arithmetic operator.');
  return sql;
}

function checkIndex(index, table, server) {
  const expressions = index.columns.filter(part => part.expression !== undefined);
  if (!expressions.length) return;
  if (!supportsExpressionParts(server)) throw fail('Native expression keys require MySQL 8.0.13 or later. MariaDB uses an indexed named generated column.');
  if (index.type !== 'BTREE' || index.unique || index.primaryKey || expressions.length !== 1) {
    throw fail('Use one calculated key part in a non-unique BTREE secondary index.');
  }
  expressionPart(expressions[0], table.columns);
}

module.exports = { hasExpression, supportsExpressionParts, expressionPart, checkIndex };
