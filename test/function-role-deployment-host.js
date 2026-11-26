'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { JOURNAL } = require('../src/db/object-editor');
const { jdbcReadback } = require('./java-source-analysis-host');
const { accountSql, roleSql, defaultRoleSql } = require('./helpers/function-role-fixture');

const flags = { allowImplicitCommit: true, allowRoutineReplacement: true };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = value => mysql.escapeId(value, true);
const ownerKinds = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' };

async function readFixture() {
  const spring = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const configPath = await fs.realpath(spring.dbConfigPath);
  const folder = path.dirname(configPath);
  const descriptor = await fs.realpath(process.env.ROCKETBRAIN_FUNCTION_ROLE_CONFIG);
  const owner = await read(path.join(folder, 'owner.json'));
  const db = await read(configPath);
  assert.equal(path.dirname(descriptor), folder);
  assert.equal(owner.kind, ownerKinds[spring.dbEngine]);
  const fixture = await read(descriptor);
  assert.equal(fixture.kind, 'RocketbrainOwnedFunctionRole-v1');
  assert.equal(fixture.owner, owner.id);
  assert.equal(fixture.engine, spring.dbEngine);
  assert.equal(await fs.realpath(fixture.dbConfigPath), configPath);
  assert.equal(db.host, '127.0.0.1');
  assert.equal(db.database, 'rocketbrain_fixture');
  assert.equal(fixture.guests.length, 2);
  for (const route of [fixture.publisher, ...fixture.guests]) {
    assert.deepEqual([route.host, route.port, route.database], [db.host, db.port, db.database]);
    assert.match(route.user, /^rb_grant_[a-z]+_[a-f0-9]{10}$/u);
  }
  assert.match(fixture.role, /^rb_function_role_[a-f0-9]{10}$/u);
  assert.match(fixture.nested, /^rb_function_nested_[a-f0-9]{10}$/u);
  return { ...fixture, db };
}

async function verify(adapter, readback) {
  const { engine, publisher, guests: [permitted, refused], role, nested, db } = await readFixture();
  const suffix = role.split('_').at(-1);
  const name = 'rb_role_fn_' + suffix, view = 'rb_role_view_' + suffix, table = 'rb_role_data_' + suffix;
  const qualified = object => quote(db.database) + '.' + quote(object);
  const fn = qualified(name), selectView = qualified(view), baseTable = qualified(table);
  const exactRole = roleSql(engine, role);
  const grantOutput = 'GRANT SELECT (answer) ON ' + selectView + ' TO ' + accountSql(refused);
  const revokeOutput = 'REVOKE SELECT (answer) ON ' + selectView + ' FROM ' + accountSql(refused);
  const grantInput = 'GRANT SELECT ON ' + baseTable + ' TO ' + exactRole;
  const revokeInput = 'REVOKE SELECT ON ' + baseTable + ' FROM ' + exactRole;
  const createView = adjustment => 'CREATE OR REPLACE SQL SECURITY INVOKER VIEW ' + selectView +
    ' AS SELECT ' + fn + '(x' + adjustment + ') AS answer FROM ' + baseTable;
  const server = await mysql.createConnection(publisher);
  const ids = [];
  const call = async (login, sql) => {
    const session = await mysql.createConnection(login);
    try {
      const [[row]] = await session.query(sql);
      return String(row.answer);
    } finally { await session.end(); }
  };
  const assertCall = async expected => {
    assert.equal(await call(permitted, 'SELECT ' + fn + '(40) AS answer'), expected);
    assert.equal(await call(permitted, 'SELECT answer FROM ' + selectView), expected);
    await assert.rejects(call(refused, 'SELECT ' + fn + '(40) AS answer'), /denied|not allowed/i);
    await assert.rejects(call(refused, 'SELECT answer FROM ' + selectView), /denied|not allowed/i);
  };
  const changeDefault = async enabled => {
    const session = await mysql.createConnection(permitted);
    try { await session.query(defaultRoleSql(engine, nested, permitted, enabled)); }
    finally { await session.end(); }
  };
  const review = async increment => {
    const model = await adapter.open({ kind: 'function', name });
    const result = await adapter.preview(model, 'RETURN i + ' + increment);
    ids.push(result.operationId);
    return { model, result };
  };
  const apply = item => adapter.apply(item, flags);
  const restore = item => adapter.recover(item.result.operationId, flags);
  const viewDefinition = async () => (await server.query('SHOW CREATE VIEW ' + selectView))[0];
  const executeStatement = 'GRANT EXECUTE ON FUNCTION ' + fn + ' TO ' + exactRole;
  try {
    await server.query('CREATE TABLE ' + baseTable + ' (x BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await server.query('INSERT INTO ' + baseTable + ' VALUES (40)');
    await server.query('CREATE FUNCTION ' + fn + '(i BIGINT) RETURNS BIGINT DETERMINISTIC NO SQL SQL SECURITY INVOKER RETURN i + 1');
    await server.query(createView(''));
    await server.query(executeStatement);
    await server.query(grantInput);
    await server.query('GRANT SELECT ON ' + selectView + ' TO ' + exactRole);
    const originalView = await viewDefinition();
    await assertCall('41');
    await adapter.connect(publisher);

    const changedDefault = await review(2);
    const { accessReview } = changedDefault.result;
    assert.deepEqual(changedDefault.result.validation, { compiled: true, executed: false, cleaned: true });
    assert.equal(accessReview.roles.length, 1);
    assert.equal(accessReview.roles[0].user, role);
    assert.ok(accessReview.roles[0].memberships.some(edge => edge.member[0] === nested && edge.role[0] === role));
    assert.ok(accessReview.roles[0].memberships.some(edge => edge.member[0] === permitted.user && edge.role[0] === nested && edge.defaultRole));
    assert.deepEqual(accessReview.views.map(item => [item.schema, item.name, item.output, item.input, item.tableGrants,
      item.columnGrants, item.inputTableGrants, item.inputColumnGrants]), [[db.database, view, 'answer', table, 1, 0, 1, 0]]);
    assert.match(changedDefault.result.sql, /Reviewed EXECUTE role/u);
    assert.ok(changedDefault.result.sql.endsWith(executeStatement + ';'));
    assert.doesNotMatch(changedDefault.result.sql, /SET DEFAULT ROLE|CREATE ROLE/u);
    await changeDefault(false);
    await assert.rejects(apply(changedDefault), /grants changed after review/i);
    await changeDefault(true);
    await assertCall('41');

    const changedViewGrant = await review(2);
    await server.query(grantOutput);
    await assert.rejects(apply(changedViewGrant), /dependencies changed after review/i);
    await server.query(revokeOutput);
    await assertCall('41');

    const changedInputGrant = await review(2);
    await server.query(revokeInput);
    await assert.rejects(apply(changedInputGrant), /dependencies changed after review/i);
    await server.query(grantInput);
    await assertCall('41');

    const changedViewSource = await review(2);
    await server.query(createView(' + 1'));
    await assert.rejects(apply(changedViewSource), /may depend|dependent view/iu);
    await server.query(createView(''));
    await assertCall('41');

    const deployable = await review(2);
    assert.equal((await apply(deployable)).state, 'applied');
    await assertCall('42');
    assert.deepEqual(await viewDefinition(), originalView);
    await adapter.connect(publisher);
    const [record] = (await adapter.list()).filter(item => item.operationId === deployable.result.operationId);
    assert.deepEqual(record.restoreAccessReview, deployable.result.accessReview);
    await server.query(grantOutput);
    await assert.rejects(restore(deployable), /dependency source, projected columns or grants changed/iu);
    await server.query(revokeOutput);
    await changeDefault(false);
    await assert.rejects(restore(deployable), /changed outside the reviewed replacement|role.*changed/iu);
    await changeDefault(true);
    assert.equal((await restore(deployable)).state, 'recovered');
    await assertCall('41');
    assert.deepEqual(await viewDefinition(), originalView);

    let missingFunctionRecovered = false;
    if (adapter.interruptDrop) {
      const interrupted = await review(3);
      const unknown = await adapter.interruptDrop(fn, () => apply(interrupted));
      assert.equal(unknown.state, 'needs-inspection');
      assert.equal(unknown.autoRetried, false);
      await assert.rejects(call(permitted, 'SELECT answer FROM ' + selectView));
      assert.equal((await viewDefinition())[0].View, view);
      await adapter.connect(publisher);
      await changeDefault(false);
      await assert.rejects(restore(interrupted), /member, default assignment or activation policy changed/iu);
      await changeDefault(true);
      assert.equal((await restore(interrupted)).state, 'recovered');
      await assertCall('41');
      assert.deepEqual(await viewDefinition(), originalView);
      missingFunctionRecovered = true;
    }
    const [[{ version }]] = await server.query('SELECT VERSION() AS version');
    return { engine, version, reviewedNestedRole: true, verifiedOrdinaryCallerAndDeniedControl: true,
      observedDependentSourceAndOutput: true, roleDefaultDriftRefused: true, dependentGrantAndSourceDriftRefused: true,
      dependentInputGrantDriftRefused: true,
      deployedAndReconnectedRecovery: true, missingFunctionRecovered, noMembershipMutationsInProduct: true, spring: await readback() };
  } finally {
    try {
      await adapter.disconnect();
      await server.query('DROP VIEW IF EXISTS ' + selectView);
      await server.query('DROP FUNCTION IF EXISTS ' + fn);
      await server.query('DROP TABLE IF EXISTS ' + baseTable);
      for (const id of ids) await server.execute('DELETE FROM ' + quote(JOURNAL) + ' WHERE operation_id=?', [id]);
    } finally { await server.end(); }
  }
}

function verifyFunctionRoleDeploymentBackend(readback = jdbcReadback) {
  let db;
  return verify({
    async connect(config) { await db?.dispose(); db = new MysqlService(config); },
    async disconnect() { await db?.dispose(); db = undefined; },
    open: target => db.inspectSchemaObject(target),
    preview: (model, source) => db.previewSchemaObject({ modelId: model.modelId, source }),
    apply: (item, approvals) => db.applySchemaObject({ ...approvals, reviewId: item.result.reviewId }),
    list: () => db.listSchemaObjectRecoveries(),
    recover: (operationId, approvals) => db.recoverSchemaObject({ ...approvals, operationId }),
    async interruptDrop(fn, action) {
      const stream = db._stream;
      let intercepted = 0;
      db._stream = async function (session, sql, ...args) {
        const response = await stream.call(this, session, sql, ...args);
        if (sql === 'DROP FUNCTION ' + fn) {
          intercepted++;
          const lost = Object.assign(Error('Owned fixture lost the successful function DROP reply.'), { code: 'ROCKETBRAIN_TEST_ROLE_LOST_DROP' });
          this._lose(session, lost, true);
          throw lost;
        }
        return response;
      };
      try {
        const result = await action();
        assert.equal(intercepted, 1);
        return result;
      } finally { db._stream = stream; }
    }
  }, readback);
}

async function runFunctionRoleDeploymentChecks(api, vscode, checks) {
  const author = api.dbAuthoring;
  const result = await verify({
    connect: api.connectMysql,
    disconnect: api.disconnectMysql,
    open: target => author.openObject(target),
    async preview(model, source) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source);
      assert.ok(await vscode.workspace.applyEdit(edit));
      const deadline = Date.now() + 2000;
      while (doc.getText() !== source && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(doc.getText(), source);
      const review = await author.reviewObject(model.modelId);
      const uri = vscode.Uri.parse(review.reviewUri);
      assert.ok(uri.path.endsWith('/' + review.reviewId + '/review.sql'));
      const report = await vscode.workspace.openTextDocument(uri);
      assert.equal(report.getText(), review.sql);
      assert.equal(report.isDirty, false);
      return review;
    },
    apply: (item, approvals) => author.deployObject(item.model.modelId, approvals),
    async list() { return (await api.listSchemaObjectRecoveries()).operations; },
    recover: (operationId, approvals) => author.recoverObject(operationId, approvals)
  }, jdbcReadback);
  checks.push('The installed reviewed function source retained nested role EXECUTE, dependent INVOKER view source and grants, and guarded reconnected restoration against actual default-role and view-permission drift.');
  return { ...result, nativeFunctionRoleReview: true };
}

module.exports = { verifyFunctionRoleDeploymentBackend, runFunctionRoleDeploymentChecks };
if (require.main === module) verifyFunctionRoleDeploymentBackend().then(value => console.log(JSON.stringify(value)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
