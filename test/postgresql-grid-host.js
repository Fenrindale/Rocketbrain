'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { setTimeout: pause } = require('node:timers/promises');
const { startPostgreSqlFixture } = require('./helpers/postgresql-fixture');

const first = '9007199254740994', second = '9007199254740995';

async function verifyPostgreSqlGrid(api, { bin, jar, nativePreview }) {
  const fixture = await startPostgreSqlFixture(bin);
  const profiles = [];
  try {
    await fixture.ownerQuery(`
      CREATE TABLE pilot.grid_people (id bigint PRIMARY KEY, note text, short varchar(3), count_value int, spare text);
      INSERT INTO pilot.grid_people VALUES (${first},NULL,'old',1,NULL),(${second},'peer','two',2,NULL);
      CREATE TABLE pilot.grid_generated (id bigint PRIMARY KEY, amount int, doubled int GENERATED ALWAYS AS (amount*2) STORED);
      INSERT INTO pilot.grid_generated VALUES (1,2);
      GRANT SELECT,UPDATE ON pilot.grid_people,pilot.grid_generated TO rb_fixture;
    `);
    const draft = { jar, driverClass: 'org.postgresql.Driver', postgresql: fixture.route };
    const readonly = await api.prepare({ ...draft, name: 'PostgreSQL read only' });
    profiles.push(await api.save(readonly.id, true));
    await api.open(readonly.id, fixture.auth);
    assert.equal(api.supportsPostgreSqlGrid(), false);
    await assert.rejects(api.previewPostgreSqlGrid('grid_people'), /approved for reviewed cell edits/);
    const approval = await api.prepare({ ...draft, name: 'PostgreSQL reviewed writes', postgresqlGridEditing: true });
    assert.equal(approval.postgresqlGridEditing, true);
    await assert.rejects(api.save(approval.id, false), /explicitly approve/);
    profiles.push(await api.save(approval.id, true));
    assert.equal(profiles[1].postgresqlGridEditing, true);
    const catalog = await api.open(approval.id, fixture.auth);
    assert.equal(api.supportsPostgreSqlGrid(), true);
    assert.deepEqual((await api.query('SHOW transaction_read_only')).rows, [['on']]);
    await assert.rejects(api.query('UPDATE grid_people SET note = NULL'), /read-only|read statement/);
    await assert.rejects(api.previewPostgreSqlGrid('grid_generated'), { code: 'ROCKETBRAIN_JDBC_GRID_SCOPE' });

    const inspect = table => api.previewPostgreSqlGrid(table);
    let grid = await (nativePreview || inspect)('grid_people');
    const index = name => grid.columns.findIndex(column => column.name === name);
    assert.deepEqual(grid.rows[0].values, [first, null, 'old', '1', null]);
    assert.equal(grid.rows[1].values[0], second);
    assert.throws(() => api.preparePostgreSqlGridEdit(grid.id, 0, 0, second), /non-key cell/);
    const unicode = '한글 <script> & Rocketbrain';
    let edit = api.preparePostgreSqlGridEdit(grid.id, 0, index('note'), unicode);
    assert.equal(edit.identity.value, first);
    assert.equal(edit.original, null);
    await assert.rejects(api.applyPostgreSqlGridEdit(edit.id, false), /review .* again/i);
    assert.equal((await fixture.query(`SELECT note IS NULL FROM pilot.grid_people WHERE id=${first};`)).trim(), 't');
    assert.deepEqual(await api.applyPostgreSqlGridEdit(edit.id, true), { identity: first, value: unicode, committed: true });
    await assert.rejects(api.applyPostgreSqlGridEdit(edit.id, true), /review .* again/i);
    assert.equal((await fixture.query(`SELECT note FROM pilot.grid_people WHERE id=${first};`)).trim(), unicode);
    assert.equal((await fixture.query(`SELECT note FROM pilot.grid_people WHERE id=${second};`)).trim(), 'peer');

    grid = await inspect('grid_people');
    edit = api.preparePostgreSqlGridEdit(grid.id, 0, index('note'), null);
    await fixture.ownerQuery(`UPDATE pilot.grid_people SET count_value=3 WHERE id=${first};`);
    await assert.rejects(api.applyPostgreSqlGridEdit(edit.id, true), { code: 'ROCKETBRAIN_JDBC_GRID_STALE' });
    assert.equal((await fixture.query(`SELECT note FROM pilot.grid_people WHERE id=${first};`)).trim(), unicode);
    grid = await inspect('grid_people');
    edit = api.preparePostgreSqlGridEdit(grid.id, 0, index('note'), null);
    assert.deepEqual(await api.applyPostgreSqlGridEdit(edit.id, true), { identity: first, value: null, committed: true });

    grid = await inspect('grid_people');
    edit = api.preparePostgreSqlGridEdit(grid.id, 0, index('short'), 'above');
    await assert.rejects(api.applyPostgreSqlGridEdit(edit.id, true), /SQLSTATE 22001.*Reload/);
    assert.equal((await fixture.query(`SELECT short FROM pilot.grid_people WHERE id=${first};`)).trim(), 'old');

    grid = await inspect('grid_people');
    edit = api.preparePostgreSqlGridEdit(grid.id, 0, index('count_value'), '4');
    const writer = fixture.ownerQuery(`BEGIN; UPDATE pilot.grid_people SET count_value=77 WHERE id=${first};
      SELECT pg_sleep(15); ROLLBACK;`);
    writer.catch(() => {});
    try {
      const deadline = Date.now() + 3000;
      let locked = false;
      while (!locked && Date.now() < deadline) {
        locked = (await fixture.query(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
          WHERE relation='pilot.grid_people'::regclass AND mode='RowExclusiveLock' AND granted);`)).trim() === 't';
        if (!locked) await pause(60);
      }
      assert.equal(locked, true, 'The owned concurrent update did not acquire its table lock.');
      await assert.rejects(api.applyPostgreSqlGridEdit(edit.id, true), /SQLSTATE 55P03.*Reload/);
    } finally { await writer; }

    grid = await inspect('grid_people');
    edit = api.preparePostgreSqlGridEdit(grid.id, 0, index('spare'), 'refused');
    await fixture.ownerQuery('ALTER TABLE pilot.grid_people DROP COLUMN spare; ALTER TABLE pilot.grid_people ADD COLUMN spare text;');
    await assert.rejects(api.applyPostgreSqlGridEdit(edit.id, true), { code: 'ROCKETBRAIN_JDBC_GRID_STALE' });
    assert.equal((await fixture.query(`SELECT spare IS NULL AND note IS NULL AND count_value=3 FROM pilot.grid_people WHERE id=${first};`)).trim(), 't');

    return { server: fixture.version, driver: catalog.connection.driverVersion, nativeGrid: Boolean(nativePreview), exactBigint: true,
      nullableUnicode: true, originalValueReviewed: true, independentApproval: true, queryStillReadOnly: true,
      peerPreserved: true, rejectedReplay: true, staleRowRejected: true, replacedColumnRejected: true, unsafeGeneratedRejected: true,
      concurrentWriterRefused: true, rollbackOnServerConstraint: true, cleaned: true };
  } finally {
    api.close();
    for (const profile of profiles.reverse()) await api.remove(profile.id);
    await fixture.close();
    await assert.rejects(fs.stat(fixture.folder), { code: 'ENOENT' });
  }
}

async function runPostgreSqlGridChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_POSTGRES_TEST_BIN, jar = process.env.ROCKETBRAIN_POSTGRES_TEST_JAR;
  assert.ok(bin && jar, 'Configure the owned PostgreSQL vendor fixture.');
  const response = await verifyPostgreSqlGrid(api.jdbc, { bin, jar, async nativePreview(table) {
    const grid = await vscode.commands.executeCommand('rocketbrain.jdbc.openPostgreSqlGrid', table);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && vscode.window.tabGroups.activeTabGroup.activeTab?.label !== 'PostgreSQL · ' + table) await pause(50);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'PostgreSQL · ' + table);
    assert.equal(grid.table, table);
    return grid;
  } });
  checks.push('actual PostgreSQL native single-cell grid, separate write approval, exact row checks and rollback on server error');
  return response;
}

module.exports = { verifyPostgreSqlGrid, runPostgreSqlGridChecks };
