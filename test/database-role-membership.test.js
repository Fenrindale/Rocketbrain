'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { request, sqlFor, expectedRoles, plan, apply } = require('../src/db/database-role-membership');

const role = { user: 'service_reader', host: '%' };
const account = { user: 'reporter', host: '127.0.0.1' };
const input = { role, account, action: 'grant' };

test('role SQL uses one validated exact role and member in each dialect', () => {
  assert.equal(sqlFor(request(input, 'mysql'), 'mysql'), "GRANT 'service_reader'@'%' TO 'reporter'@'127.0.0.1'");
  const maria = { ...input, role: { ...role, host: '' }, action: 'revoke-admin' };
  const quoted = String.fromCharCode(96) + 'service_reader' + String.fromCharCode(96);
  assert.equal(sqlFor(request(maria, 'mariadb'), 'mariadb'), "REVOKE ADMIN OPTION FOR " + quoted + " FROM 'reporter'@'127.0.0.1'");
  for (const [options, dialect] of [
    [{ ...input, account: { ...account, host: "127.0.0.1'; drop" } }, 'mysql'],
    [{ ...input, role: { user: 'PUBLIC', host: '' } }, 'mariadb'],
    [{ ...input, action: 'revoke-admin' }, 'mysql'],
    [{ ...input, action: 'revoke', withAdmin: true }, 'mysql']
  ]) assert.throws(() => request(options, dialect), /Choose|Only MariaDB/);
});

test('a review captures just the requested membership and explicit admin changes', () => {
  const baseline = [{ user: 'base', host: '%', adminOption: false }, { ...role, adminOption: false }];
  const upgraded = expectedRoles(baseline, request({ ...input, withAdmin: true }, 'mysql'));
  assert.deepEqual(upgraded, [baseline[0], { ...role, adminOption: true }]);
  assert.deepEqual(expectedRoles(upgraded, { ...input, action: 'revoke-admin' }), baseline);
  assert.deepEqual(expectedRoles(upgraded, { ...input, action: 'revoke' }), [baseline[0]]);
  assert.throws(() => expectedRoles(baseline, input), /already in the requested state/);
});

function fixture() {
  const state = { memberships: [], defaults: [], attempts: [], admin: 'Y', lose: false };
  const session = { connected: true };
  const identity = { dialect: 'mysql', version: '8.4.13', database: 'app', sqlMode: '', currentUser: 'grantor@127.0.0.1' };
  const transport = {
    _withSession: action => action(session), _identity: async () => identity,
    async _read(_session, sql, vars) {
      if (sql.startsWith('SELECT CURRENT_ROLE()')) return [['NONE', '', 0]];
      if (sql.includes('FROM mysql.user')) return [[vars[0], vars[1], vars[0] === role.user ? 'Y' : 'N']];
      if (sql.includes('FROM mysql.role_edges')) {
        return vars[0] === 'grantor' ? [[role.user, role.host, state.admin]] : vars[0] === account.user ? state.memberships : [];
      }
      if (sql.includes('FROM mysql.default_roles')) return state.defaults;
      if (sql.includes('FROM information_schema.') || sql.includes('FROM mysql.tables_priv')) return [];
      assert.fail('Unexpected read ' + sql);
    }
  };
  const lease = { guard: () => true, db: { _schemaRenamer: transport, async _control(active, sql) {
    state.attempts.push(sql);
    if (state.lose) { active.connected = false; throw Error('Transport lost before acknowledgement'); }
    state.memberships = sql.startsWith('GRANT ') ? [[role.user, role.host, sql.endsWith('WITH ADMIN OPTION') ? 'Y' : 'N']] : [];
    return { warningStatus: 0 };
  } } };
  return { state, lease };
}

test('role plans reject missing direct authority and a changed membership before execution', async () => {
  const { state, lease } = fixture();
  state.admin = 'N';
  await assert.rejects(plan(lease, input), /direct ADMIN OPTION/);
  state.admin = 'Y';
  const review = await plan(lease, input);
  state.memberships = [[role.user, role.host, 'N']];
  await assert.rejects(apply(lease, review), /changed after review/);
  assert.deepEqual(state.attempts, []);
  state.defaults = [[role.user, role.host]];
  await assert.rejects(plan(lease, { ...input, action: 'revoke' }), /default role/);
});

test('postconditions distinguish observed changes from a lost acknowledgement without retrying', async () => {
  const { state, lease } = fixture();
  const first = await apply(lease, await plan(lease, input));
  assert.equal(first.state, 'verified');
  assert.deepEqual(first.membership, [{ ...role, adminOption: false }]);
  assert.equal(first.effectiveAccessCalculated, false);
  const revoke = await plan(lease, { ...input, action: 'revoke' });
  state.lose = true;
  const last = await apply(lease, revoke);
  assert.equal(last.state, 'uncertain');
  assert.equal(last.acknowledged, false);
  assert.equal(last.automaticRetry, false);
  assert.equal(state.attempts.length, 2);
});
