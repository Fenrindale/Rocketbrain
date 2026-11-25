'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const principal = ({user,host}) => ({user,host});
const credentials = ({database,...value}) => value;
const roleSql = (name, engine) => engine === 'mysql' ? "'" + name + "'@'%'" : String.fromCharCode(96) + name + String.fromCharCode(96);

async function verifyRoleMembership(runtime, descriptor, adapter) {
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder, 'owner.json'));
  const config = await read(runtime.dbConfigPath), data = await read(descriptor);
  const { engine, admin, guest, membership } = data;
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(data.format, 'RocketbrainOwnedDatabaseAdminFixture');
  assert.equal(data.owner, owner.id);
  assert.equal(owner.id, path.basename(folder));
  assert.equal(path.dirname(await fs.realpath(descriptor)), folder);
  assert.equal(data.sourceConfigPath, runtime.dbConfigPath);
  assert.equal(engine, runtime.dbEngine);
  assert.match(membership.role, /^rb_acl_review_[a-f0-9]{10}$/u);
  assert.match(membership.leaf, /^rb_acl_review_leaf_[a-f0-9]{10}$/u);
  assert.match(membership.table, /^rb_acl_review_data_[a-f0-9]{10}$/u);
  for (const profile of [config,admin,guest,membership.delegated]) {
    assert.equal(profile.host, '127.0.0.1');
    assert.equal(profile.port, config.port);
    assert.equal(profile.database, 'rocketbrain_fixture');
  }
  const role = { user: membership.role, host: engine === 'mysql' ? '%' : '' };
  const target = { role, account: principal(guest) }, selected = roleSql(role.user, engine);
  const query = 'SELECT id FROM rocketbrain_fixture.' + membership.table + ' ORDER BY id';
  const prepare = (action, options = {}) => adapter.prepare({ ...target, action, ...options });
  const apply = (review, options = {}) => adapter.apply({reviewId:review.reviewId,approved:true,...options});
  const guestSession = async (profile, action) => {
    const connection = await mysql.createConnection(credentials(profile));
    try { return await action(connection); } finally { await connection.end(); }
  };
  const readHidden = profile => guestSession(profile, async connection => assert.rejects(connection.query(query), /denied/i));
  const readRole = profile => guestSession(profile, async connection => {
    await connection.query('SET ROLE ' + selected);
    assert.deepEqual((await connection.query(query))[0].map(row => Number(row.id)), [1,2]);
  });
  const delegate = connection => connection.query('GRANT ' + selected + ' TO ?@?', [membership.delegated.user,membership.delegated.host]);
  const setDefault = roleName => guestSession(guest, connection => connection.query(
    'SET DEFAULT ROLE ' + roleName + (engine === 'mysql' ? ' TO ?@?' : ''), engine === 'mysql' ? [guest.user,guest.host] : []));
  const outOfBand = await mysql.createConnection(admin);
  try {
    await adapter.connect(admin);
    const spring = await adapter.probe();
    assert.equal(spring.people, 2);
    const available = await adapter.options();
    assert.deepEqual(available.actor, principal(admin));
    assert.ok(available.roles.some(item => item.user === role.user && item.host === role.host));
    assert.ok(available.accounts.some(item => item.user === guest.user && item.host === guest.host));
    const oldRole = { ...role, user: data.role };
    await assert.rejects(prepare('grant', { role: oldRole }), /direct ADMIN OPTION/);
    await readHidden(guest);
    await readHidden(membership.delegated);

    const ordinary = await prepare('grant');
    assert.equal(ordinary.sql, 'GRANT ' + selected + " TO '" + guest.user + "'@'" + guest.host + "'");
    assert.equal(ordinary.credentialsIncluded, false);
    assert.ok(!JSON.stringify(ordinary).includes(guest.password));
    await adapter.assertReview?.(ordinary, membership.leaf);
    await assert.rejects(adapter.apply({reviewId:ordinary.reviewId}), /Approve the exact/);
    const granted = await apply(ordinary);
    assert.equal(granted.state, 'verified');
    assert.equal(granted.effectiveAccessCalculated, false);
    assert.equal(granted.membership.find(item => item.user === role.user).adminOption, false);
    await assert.rejects(apply(ordinary), /expired or the administrator connection changed/);
    await readHidden(guest);
    await readRole(guest);
    await guestSession(guest, async connection => assert.rejects(delegate(connection), /denied|not authorized|not allowed|not have/i));
    await setDefault(selected);
    await assert.rejects(prepare('revoke'), /default role/);
    await setDefault('NONE');

    const upgrade = await prepare('grant', {withAdmin:true});
    await assert.rejects(apply(upgrade), /Explicitly approve delegated/);
    assert.equal((await apply(upgrade, {approvedDelegation:true})).membership.find(item => item.user === role.user).adminOption, true);
    await guestSession(guest, delegate);
    await readRole(membership.delegated);

    if (engine === 'mariadb') {
      const downgrade = await prepare('revoke-admin');
      assert.match(downgrade.sql, /^REVOKE ADMIN OPTION FOR /u);
      const removedAdmin = await apply(downgrade);
      assert.equal(removedAdmin.state, 'verified');
      assert.equal(removedAdmin.membership.find(item => item.user === role.user).adminOption, false);
      await readRole(guest);
      await guestSession(guest, async connection => assert.rejects(delegate(connection), /denied|not authorized|not allowed|not have/i));
    } else await assert.rejects(prepare('revoke-admin'), /Only MariaDB/);
    const removed = await apply(await prepare('revoke'));
    assert.equal(removed.state, 'verified');
    assert.ok(!removed.membership.some(item => item.user === role.user));
    assert.ok(removed.membership.some(item => item.user === oldRole.user));
    await readHidden(guest);
    await guestSession(guest, async connection => assert.rejects(connection.query('SET ROLE ' + selected)));
    await readRole(membership.delegated);

    const stale = await prepare('grant');
    await outOfBand.query('GRANT ' + selected + ' TO ?@?', [guest.user,guest.host]);
    await assert.rejects(apply(stale), /changed after review/);
    assert.equal((await apply(await prepare('revoke'))).state, 'verified');
    await readHidden(guest);
    assert.deepEqual(await adapter.probe(), spring);
    return { verifiedDirectGrantAndRevoke: true, separateDelegationApproval: true, actualDelegatedGrant: true,
      adminOnlyRevocation: engine === 'mariadb', defaultRoleRefusal: true, staleMembershipRejected: true,
      actualRoleActivationAndAccess: true, inheritedLeafPrivilegeRead: true, deniedAfterRevoke: true, otherRolePreserved: true, noCredentials: true, spring };
  } finally { await outOfBand.end(); }
}

async function runRoleMembershipChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG), admin = api.dbAdmin;
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.reviewRoleMembership'));
  try {
    checks.roleMembership = await verifyRoleMembership(runtime, process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG, {
      connect: config => api.connectMysql(config), options: admin.listRoleMembershipOptions,
      prepare: admin.prepareRoleMembership, apply: admin.applyRoleMembership,
      async assertReview(review, inherited) {
        const details = await admin.openRoleMembershipReview(review.reviewId);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(details.documentUri));
        assert.equal(document.uri.scheme, 'rocketbrain-db-admin');
        assert.equal(document.isDirty, false);
        assert.match(document.getText(), /Reviewed direct role membership/);
        assert.ok(document.getText().includes(review.sql));
        assert.ok(document.getText().includes(inherited));
      },
      async probe() {
        const response = await fetch(runtime.baseUrl + '/probe/testing-state', {signal:AbortSignal.timeout(5000)});
        assert.ok(response.ok);
        return response.json();
      }
    });
  } finally { await api.disconnectMysql(); }
}

module.exports = { runRoleMembershipChecks, verifyRoleMembership };
