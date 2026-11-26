'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { viewProjection } = require('../src/db/object-editor-function-dependents');
const { observeRoleAccess, validateRoleAccess } = require('../src/db/object-editor-role-access');

const target = { schema: 'application', name: 'calculate_score', parameters: [{}, {}], sqlMode: '' };

test('a dependent projection binds the exact function and base columns across catalog qualification variants', () => {
  const normal = viewProjection('SELECT application.calculate_score(scores.points, -2) AS total FROM application.scores', target);
  const duringDrop = viewProjection('select `application`.`calculate_score`(`application`.`scores`.`points`,-2) as `total` from `scores`', target);
  assert.deepEqual(duringDrop, normal);
  assert.equal(normal.table, 'scores');
  assert.deepEqual(normal.operands, [{ column: 'points' }, { number: '-2' }]);
  assert.notDeepEqual(normal, viewProjection('SELECT application.calculate_score(points, 2) AS total FROM scores', target));
});

test('unproved view calls, cross-schema inputs, extra expressions and nested dependencies cannot enter the reviewed projection', () => {
  const rejected = [
    'SELECT other_schema.calculate_score(points, 2) AS total FROM application.scores',
    'SELECT application.calculate_score(points, 2) AS total FROM other_schema.scores',
    'SELECT application.calculate_score(unknown.points, 2) AS total FROM application.scores',
    'SELECT application.calculate_score(2, 3) AS total FROM application.scores AS tally WHERE points > 2',
    'SELECT application.calculate_score(points + 2, 3) AS total FROM application.scores',
    'SELECT application.calculate_score(2, 3) AS total, 4 AS additional'
  ];
  for (const sql of rejected) assert.throws(() => viewProjection(sql, target), /depend|target|input/iu);
});

function mysqlRoles(roles, edges, mandatory = '') {
  return async (sql, [user, host] = []) => {
    if (sql.includes('FROM mysql.user')) return roles.has(user) ? [[user, host, 'Y', 1]] : [[user, host, 'N', 0]];
    if (sql.includes('activate_all_roles_on_login')) return [[0, mandatory]];
    if (sql.includes('LEFT JOIN mysql.default_roles')) return edges.get(user) || [];
    if (sql.startsWith('SELECT 1 FROM mysql.role_edges')) return edges.get(user)?.length ? [[1]] : [];
    assert.fail('Unexpected role metadata query');
  };
}

test('the retained role graph binds exact members, defaults, authorization identities and activation policy', async () => {
  const roles = new Set(['base_role', 'nested_role']);
  const edges = new Map([['base_role', [['nested_role', '%', 'N', 0]]], ['nested_role', [['viewer', '127.0.0.1', 'N', 1]]]]);
  const first = await observeRoleAccess(mysqlRoles(roles, edges), 'base_role', '%', 'mysql');
  assert.equal(first.memberships.length, 2);
  assert.deepEqual(validateRoleAccess(first, 'mysql'), { kind: 'role', user: 'base_role', host: '%' });
  const malformed = structuredClone(first);
  malformed.memberships[1].defaultRole = false;
  assert.throws(() => validateRoleAccess(malformed, 'mysql'), /malformed/u);
  edges.get('nested_role')[0][3] = 0;
  assert.notEqual((await observeRoleAccess(mysqlRoles(roles, edges), 'base_role', '%', 'mysql')).fingerprint, first.fingerprint);
  await assert.rejects(observeRoleAccess(mysqlRoles(roles, edges, 'global_role'), 'base_role', '%', 'mysql'), /mandatory roles/u);
  edges.set('viewer', [['other_viewer', '127.0.0.1', 'N', 0]]);
  await assert.rejects(observeRoleAccess(mysqlRoles(roles, edges), 'base_role', '%', 'mysql'), /outside the reviewed/u);
});

test('the review fails closed on excessive graph depth and cyclic or missing MySQL role metadata', async () => {
  const roleNames = Array.from({ length: 10 }, (_, index) => 'role_' + index);
  const roles = new Set(roleNames);
  const edges = new Map(roleNames.slice(0, -1).map((role, index) => [role, [[roleNames[index + 1], '%', 'N', 0]]]));
  await assert.rejects(observeRoleAccess(mysqlRoles(roles, edges), roleNames[0], '%', 'mysql'), /reviewed depth/u);
  edges.set(roleNames.at(-1), [[roleNames[0], '%', 'N', 0]]);
  await assert.rejects(observeRoleAccess(mysqlRoles(roles, edges), roleNames[0], '%', 'mysql'), /contains a cycle/u);
  await assert.rejects(observeRoleAccess(mysqlRoles(roles, new Map()), roleNames[0], '%', 'mysql'), /explicit role assignment/u);
});
