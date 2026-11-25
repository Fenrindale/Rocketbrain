'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { owned } = require('./schema-stored-diff-host');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };

async function verifyDatabasePrincipal(runtime, descriptor, adapter) {
  const live = await owned(runtime.dbConfigPath), { actor, config } = live;
  const engine = runtime.dbEngine;
  const prefix = 'rb_create_' + randomBytes(5).toString('hex') + '_';
  const host = '127.0.0.1', account = { kind: 'account', user: prefix + 'login', host };
  const stale = { ...account, user: prefix + 'stale' }, guarded = { ...account, user: prefix + 'guard' };
  const role = { kind: 'role', user: prefix + 'reader' };
  const password = randomBytes(21).toString('base64url') + "\\;'끝";
  const url = new URL('/probe/testing-state', runtime.baseUrl);
  const spring = async () => {
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  let writer, login;
  try {
    const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
    assert.equal(path.dirname(await fs.realpath(descriptor)), folder);
    const harness = await read(descriptor);
    assert.equal(harness.format, 'RocketbrainOwnedDatabaseAdminFixture');
    assert.equal(harness.version, 1);
    assert.equal(harness.owner, path.basename(folder));
    assert.equal(harness.sourceConfigPath, runtime.dbConfigPath);
    assert.equal(harness.engine, engine);
    assert.ok(harness.admin.user.startsWith('rb_acl_writer_') && harness.guest.user.startsWith('rb_acl_guest_'));
    for (const principal of [harness.admin, harness.guest]) {
      for (const key of ['host', 'port', 'database']) assert.equal(principal[key], config[key]);
    }
    writer = await mysql.createConnection(harness.admin);
    const [[identity]] = await writer.query('SELECT CURRENT_USER() currentUser, VERSION() version');
    assert.equal(identity.version, live.version);
    assert.equal(identity.currentUser, harness.admin.user + '@' + host);
    const accountFlags = async user => (await writer.execute('SELECT Host,' + (engine === 'mysql' ? 'account_locked' : 'is_role') +
      ' flag FROM mysql.user WHERE BINARY User=BINARY ?', [user]))[0];
    await spring();
    await writer.query('GRANT SELECT ON `rocketbrain_fixture`.`rb_spring_person` TO ?@?', [harness.guest.user, host]);
    await adapter.connect(harness.guest);
    const catalogDenied = error => ['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR'].includes(error.code);
    await assert.rejects(adapter.prepare(guarded), catalogDenied);
    await adapter.connect(config);
    // Cross-schema fixtures can read mysql.user, but the ordinary application account still cannot create accounts.
    const ordinary = await adapter.prepare(guarded).catch(error => { if (!catalogDenied(error)) throw error; });
    if (ordinary) {
      const refused = await adapter.apply({ reviewId: ordinary.reviewId, approved: true, password });
      assert.equal(refused.state, 'rejected');
      assert.equal(refused.acknowledged, false);
    }
    assert.deepEqual(await accountFlags(guarded.user), []);
    await adapter.connect(harness.admin);
    await assert.rejects(adapter.prepare({ ...account, host: '%' }), /explicit account host/);
    await assert.rejects(adapter.prepare({ ...account, user: "a'" }), /account or role name/);
    const pending = await adapter.prepare(stale);
    await writer.query('CREATE USER ?@? IDENTIFIED BY ?', [stale.user, host, randomBytes(24).toString('base64url')]);
    await assert.rejects(adapter.apply({ reviewId: pending.reviewId, approved: true, password }), /authorization name or connection changed/);
    assert.ok((await accountFlags(stale.user)).length === 1);

    const switched = await adapter.prepare(guarded);
    await adapter.connect({ ...harness.admin, writeProtection: { connectionReadOnly: true } });
    await assert.rejects(adapter.apply({ reviewId: switched.reviewId, approved: true, password }), /review expired|connection changed/);
    await assert.rejects(adapter.prepare(guarded), /locked to read-only/);
    await adapter.connect({ ...harness.admin, writeProtection: { tables: [{ schema: config.database, name: 'people' }] } });
    const protectedReview = await adapter.prepare(guarded);
    await assert.rejects(adapter.apply({ reviewId: protectedReview.reviewId, approved: true, password }), /writes are unavailable while this profile protects tables/);
    assert.deepEqual(await accountFlags(guarded.user), []);
    await adapter.connect(harness.admin);

    const review = await adapter.prepare(account);
    assert.equal(review.credentialsIncluded, false);
    assert.deepEqual(review.target, account);
    assert.equal(review.server.account, identity.currentUser);
    assert.match(review.sql, /IDENTIFIED BY <password supplied on apply> ACCOUNT UNLOCK/u);
    assert.ok(!JSON.stringify(review).includes(password));
    assert.deepEqual(await accountFlags(account.user), []);
    if (adapter.preview) await adapter.preview(review, 'account');
    await assert.rejects(adapter.apply({ reviewId: review.reviewId }), /Approve/);
    const created = await adapter.apply({ reviewId: review.reviewId, approved: true, password });
    assert.deepEqual(created, { state: 'verified', acknowledged: true, automaticRetry: false, credentialsIncluded: false });
    await assert.rejects(adapter.apply({ reviewId: review.reviewId, approved: true, password }), /review expired|connection changed/);
    await assert.rejects(adapter.prepare(account), /already exists/);
    assert.deepEqual(await accountFlags(account.user), [{ Host: host, flag: 'N' }]);
    login = await mysql.createConnection({ host, port: config.port, user: account.user, password });
    assert.equal((await login.query('SELECT CURRENT_USER() currentUser'))[0][0].currentUser, account.user + '@' + host);
    await assert.rejects(login.query('SELECT * FROM `rocketbrain_fixture`.`people`'), error =>
      ['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(error.code));

    const roleReview = await adapter.prepare(role);
    assert.deepEqual(roleReview.target, { ...role, host: engine === 'mysql' ? '%' : '' });
    if (engine === 'mysql') {
      assert.match(roleReview.sql, /@'%'$/u);
      assert.equal(roleReview.roleAdministrator, null);
    } else {
      assert.match(roleReview.sql, /WITH ADMIN CURRENT_USER$/u);
      assert.equal(roleReview.roleAdministrator, identity.currentUser);
    }
    if (adapter.preview) await adapter.preview(roleReview, 'role');
    assert.deepEqual(await adapter.apply({ reviewId: roleReview.reviewId, approved: true }), created);
    assert.deepEqual(await accountFlags(role.user), [{ Host: roleReview.target.host, flag: 'Y' }]);
    await assert.rejects(adapter.prepare(role), /already exists/);
    await spring();
    return { engine, version: live.version, actualPasswordAuthentication: true, noExplicitObjectPrivileges: true,
      nativeReadonlyReview: Boolean(adapter.preview), credentialsExcluded: true, observedRoleHost: roleReview.target.host,
      mariaCreatorRoleAdministration: engine === 'mariadb', explicitApprovalAndOneShot: true, staleAndBlockedProfilesRefused: true,
      newAccountAndRole: true, springIsolation: expectedSpring };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try { await login?.end(); }
      finally {
        try {
          if (writer) {
            try {
              const roleSql = engine === 'mysql' ? "'" + role.user + "'@'%'" : '`' + role.user + '`';
              await writer.query('DROP ROLE IF EXISTS ' + roleSql);
              for (const target of [account, stale, guarded]) await writer.query('DROP USER IF EXISTS ?@?', [target.user, host]);
            } finally { await writer.end(); }
          }
        } finally { await actor.end(); }
      }
    }
  }
}

async function runDatabasePrincipalChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG), tools = api.dbAdmin;
  const result = await verifyDatabasePrincipal(runtime, process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG, {
    connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    prepare: tools.preparePrincipal, apply: tools.applyPrincipal,
    async preview(review, kind) {
      const displayed = await tools.openPrincipalReview(review.reviewId);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(displayed.documentUri));
      const text = document.getText();
      assert.ok(text.includes('Create database ' + kind) && text.includes(review.target.user));
      assert.ok(text.includes(review.server.account) && text.includes(review.sql));
      await vscode.commands.executeCommand('type', { text: '-- readonly probe' });
      assert.equal(document.getText(), text);
      assert.equal(document.isDirty, false);
      assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.reviewCreatePrincipal'));
    }
  });
  checks.push('Created a reviewed login account and an engine-specific role. The new login authenticated without object privileges.');
  checks.push('Verified read-only review, password exclusion, stale/blocked guards, one-shot approval and unchanged Spring JDBC data.');
  return result;
}

module.exports = { verifyDatabasePrincipal, runDatabasePrincipalChecks };
