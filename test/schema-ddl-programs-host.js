'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const mysql = require('mysql2/promise');
const { queryWithNativeClient } = require('./sql-format-script-host');

const run = promisify(execFile);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const target = 'rocketbrain_related';
const recreate = 'CREATE DATABASE `rocketbrain_related` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
const initialSpring = { rolledBackNames: 0, departments: 1, people: 2 };
const hasEmptySchema = 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? UNION ALL ' +
  'SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? UNION ALL ' +
  'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? UNION ALL ' +
  'SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=?';

const initialDdl = [
  'CREATE TABLE parent(id INT PRIMARY KEY) ENGINE=InnoDB',
  'CREATE TABLE child(id INT PRIMARY KEY, parent_id INT NOT NULL, note VARCHAR(100) NOT NULL, ' +
    'CONSTRAINT fk_rb_parent FOREIGN KEY(parent_id) REFERENCES parent(id)) ENGINE=InnoDB',
  'CREATE TABLE audit_log(id INT PRIMARY KEY, note VARCHAR(140) NOT NULL) ENGINE=InnoDB',
  'CREATE VIEW child_source AS SELECT id, parent_id,note FROM child',
  'CREATE VIEW child_read AS SELECT id,note FROM child_source',
  "CREATE PROCEDURE zz_record(IN v_id INT, IN v_note VARCHAR(100)) BEGIN INSERT INTO audit_log(id,note) VALUES(v_id,CONCAT(v_note,';$$//한글')); END",
  'CREATE PROCEDURE aa_record(IN v_id INT, IN v_note VARCHAR(100)) BEGIN CALL zz_record(v_id,v_note); END',
  'CREATE FUNCTION scalar_result(v_id INT) RETURNS INT DETERMINISTIC NO SQL RETURN v_id*2+1',
  "CREATE TRIGGER z_child_first BEFORE INSERT ON child FOR EACH ROW BEGIN SET NEW.note=CONCAT(NEW.note,'|first'); END",
  "CREATE TRIGGER a_child_second BEFORE INSERT ON child FOR EACH ROW FOLLOWS z_child_first BEGIN SET NEW.note=CONCAT(NEW.note,'|second'); END",
  'CREATE TRIGGER audit_insert AFTER INSERT ON child FOR EACH ROW BEGIN CALL aa_record(NEW.id,NEW.note); END',
  "CREATE PROCEDURE opaque_program() BEGIN SET @rb_opaque='SELECT 1'; PREPARE s FROM @rb_opaque; EXECUTE s; DEALLOCATE PREPARE s; END",
  'CREATE PROCEDURE cross_schema() BEGIN SELECT id FROM rocketbrain_fixture.people; END',
  'CREATE TRIGGER opaque_update AFTER UPDATE ON child FOR EACH ROW BEGIN CALL opaque_program(); END',
  'CREATE TRIGGER opaque_sibling AFTER UPDATE ON child FOR EACH ROW FOLLOWS opaque_update BEGIN CALL zz_record(NEW.id,NEW.note); END'
];

async function git(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return run('git', args, { cwd, env, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
}

async function verifyStoredDdlExport({ runtime, crossConfigPath, nativeClient }, adapter) {
  const directory = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const marker = await read(path.join(directory, 'owner.json'));
  const cross = await read(await fs.realpath(crossConfigPath));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(path.dirname(await fs.realpath(crossConfigPath)), directory);
  assert.equal(marker.id, path.basename(directory));
  assert.equal(cross.fixtureId, marker.id);
  assert.deepEqual(cross.schemas, ['rocketbrain_fixture', target]);
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const verifySpring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), initialSpring);
  };
  const fixtureActor = await mysql.createConnection(config);
  let actor, fileRoot, ownsRestore = false, connected = false;
  try {
    const [[server]] = await fixtureActor.query('SELECT VERSION() AS version,@@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(server.datadir)).toLowerCase(), directory.toLowerCase());
    const dialect = /mariadb/i.test(server.version) ? 'mariadb' : 'mysql';
    assert.equal(dialect, runtime.dbEngine);
    await verifySpring();
    assert.deepEqual((await fixtureActor.query(hasEmptySchema, Array(4).fill(target)))[0], []);
    ownsRestore = true;
    const restoreConfig = { ...config, database: target, charset: 'UTF8MB4_UNICODE_CI' };
    actor = await mysql.createConnection(restoreConfig);
    await actor.query("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'");
    for (const sql of initialDdl) await actor.query(sql);
    await adapter.connect(restoreConfig);
    connected = true;
    const review = await adapter.prepare();
    const expected = [
      ['table', 'audit_log'], ['table', 'parent'], ['table', 'child'], ['foreignKey', 'fk_rb_parent'],
      ['view', 'child_source'], ['view', 'child_read'], ['function', 'scalar_result'], ['procedure', 'zz_record'],
      ['procedure', 'aa_record'], ['trigger', 'audit_insert'], ['trigger', 'z_child_first'], ['trigger', 'a_child_second']
    ];
    assert.deepEqual(review.statements.map(({ kind, name }) => [kind, name]), expected, JSON.stringify(review.omitted));
    assert.equal(review.state, 'partial');
    assert.deepEqual(review.omitted.map(row => row.name), ['cross_schema', 'opaque_program', 'opaque_sibling', 'opaque_update']);
    assert.match(review.omitted.find(row => row.name === 'cross_schema').reason, /rocketbrain_fixture.*people/);
    assert.match(review.sql, /^DELIMITER ~rb0~$/m);
    assert.doesNotMatch(review.sql, /CREATE [^\n]*(opaque_update|opaque_program|cross_schema|opaque_sibling)/i);
    assert.equal(review.rowDataIncluded, false);
    assert.equal(review.executedSql, false);
    assert(!review.sql.includes(config.password));
    if (adapter.preview) await adapter.preview(review);
    assert.deepEqual((await actor.query('SELECT COUNT(*) n FROM audit_log'))[0].map(row => Number(row.n)), [0]);

    const selected = await adapter.prepare({ tables: ['child', 'parent', 'audit_log'], includeStored: true });
    assert.deepEqual(selected.statements.filter(row => row.kind === 'procedure').map(row => row.name), ['zz_record', 'aa_record']);
    assert.deepEqual(selected.statements.filter(row => row.kind === 'trigger').map(row => row.name),
      ['audit_insert', 'z_child_first', 'a_child_second']);
    assert(!selected.statements.some(row => row.name === 'scalar_result'));

    const missing = await adapter.prepare({ tables: ['child', 'parent'], includeStored: true });
    assert(!missing.statements.some(row => row.kind === 'procedure' || row.name === 'audit_insert'));
    assert.match(missing.omitted.find(row => row.name === 'audit_insert').reason, /Required trigger dependency missing/);
    fileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-vcs-ddl-'));
    const file = path.join(fileRoot, 'schema.sql'), rejected = path.join(fileRoot, 'stale.sql');
    await git(['init', '--quiet'], fileRoot);
    const saved = await adapter.save(review.id, file);
    assert.equal(saved.fingerprint, review.fingerprint);
    assert.equal(await fs.readFile(file, 'utf8'), review.sql);
    await git(['add', '--intent-to-add', '--', 'schema.sql'], fileRoot);
    const { stdout: diff } = await git(['-c', 'core.quotepath=false', 'diff', '--', 'schema.sql'], fileRoot);
    assert.match(diff, /^\+-- Rocketbrain schema DDL export v2$/m);
    assert.match(diff, /^\+DELIMITER ~rb0~$/m);
    await actor.query("ALTER PROCEDURE zz_record COMMENT 'after review'");
    await assert.rejects(adapter.save(review.id, rejected), /changed after review/);
    await assert.rejects(fs.access(rejected), { code: 'ENOENT' });

    await adapter.disconnect();
    connected = false;
    await actor.end();
    actor = undefined;
    await fixtureActor.query('DROP DATABASE `rocketbrain_related`');
    await fixtureActor.query(recreate);
    assert.deepEqual((await fixtureActor.query(hasEmptySchema, Array(4).fill(target)))[0], []);
    const replay = await queryWithNativeClient(nativeClient, restoreConfig, dialect,
      'SET @rb_replay_prior_mode=@@SESSION.sql_mode, @rb_replay_prior_cs=@@SESSION.character_set_client, ' +
      '@rb_replay_prior_coll=@@SESSION.collation_connection;\n' + await fs.readFile(file, 'utf8') +
      '\nSELECT @@SESSION.sql_mode=@rb_replay_prior_mode AND @@SESSION.character_set_client=@rb_replay_prior_cs ' +
      'AND @@SESSION.collation_connection=@rb_replay_prior_coll;\n');
    assert.equal(replay.trim(), '1');
    actor = await mysql.createConnection(restoreConfig);
    assert.deepEqual((await actor.query('SELECT * FROM child_read'))[0], []);
    assert.deepEqual((await actor.query('SELECT * FROM audit_log'))[0], []);
    await assert.rejects(actor.query("INSERT INTO child VALUES(12,999,'blocked')"), { code: 'ER_NO_REFERENCED_ROW_2' });
    await actor.query('INSERT INTO parent VALUES(1)');
    await actor.query("INSERT INTO child VALUES(9,1,'fresh')");
    assert.deepEqual((await actor.query('SELECT * FROM child_read'))[0], [{ id: 9, note: 'fresh|first|second' }]);
    assert.deepEqual((await actor.query('SELECT * FROM audit_log'))[0], [{ id: 9, note: 'fresh|first|second;$$//한글' }]);
    assert.equal((await actor.query('SELECT scalar_result(9) AS n'))[0][0].n, 19);
    const [[{ account }]] = await actor.query('SELECT CURRENT_USER() AS account');
    const [restored] = await actor.execute('SELECT DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION ' +
      'FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? UNION ALL ' +
      'SELECT DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION ' +
      'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?', [target, target]);
    assert.equal(restored.length, 6);
    for (const definition of restored) assert.deepEqual(definition, {
      DEFINER: account, SQL_MODE: 'NO_BACKSLASH_ESCAPES', CHARACTER_SET_CLIENT: 'utf8mb4',
      COLLATION_CONNECTION: 'utf8mb4_unicode_ci', DATABASE_COLLATION: 'utf8mb4_unicode_ci'
    });
    await verifySpring();
    return { dialect, version: server.version, tableViewsAndForeignKey: 6, routines: 3, triggers: 3, omittedUnsafe: 4,
      nativeClient: true, destinationEmptyBeforeReplay: true, exactGitPatch: true, staleRoutineSaveRefused: true,
      nativePreview: Boolean(adapter.preview), selectedDependencyScope: true, originalDefinersAndCreationContext: true,
      sourceSqlNotExecuted: true, noDataCopied: true, springIsolation: initialSpring };
  } finally {
    try { if (connected) await adapter.disconnect(); }
    finally {
      try {
        if (actor) await actor.end();
        if (ownsRestore) {
          await fixtureActor.query('DROP DATABASE IF EXISTS `rocketbrain_related`');
          await fixtureActor.query(recreate);
        }
      } finally {
        await fixtureActor.end();
        if (fileRoot) {
          const intended = await fs.realpath(os.tmpdir()), owned = await fs.realpath(fileRoot);
          assert.equal(path.dirname(owned), intended);
          assert.match(path.basename(owned), /^rb-vcs-ddl-/u);
          await fs.rm(owned, { force: true, recursive: true });
        }
      }
    }
  }
}

async function runSchemaDdlProgramsChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const result = await verifyStoredDdlExport({
    runtime, crossConfigPath: process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG,
    nativeClient: process.env.ROCKETBRAIN_SQL_FORMAT_TEST_CLIENT
  }, {
    connect: config => api.connectMysql(config),
    disconnect: () => api.disconnectMysql(),
    prepare: options => api.schemaDdlExport.prepare(options),
    save: (id, file) => api.schemaDdlExport.saveReview(id, vscode.Uri.file(file)),
    async preview(review) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-ddl-export:/' + review.id + '/schema.sql'));
      assert.equal(doc.getText().replace(/\r\n/g, '\n'), review.sql);
      assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.schema.exportDdl'));
    }
  });
  checks.push('Previewed supported procedure, function and trigger definitions, dependency order and targeted omissions inside the native DDL export.');
  checks.push('Saved the exact DDL into an isolated Git working tree and refused stale routine source before a file write.');
  checks.push('A disposable native SQL client restored the exact file into the empty owned schema without copying data, validating trigger order, routine calls, original creation context and unchanged Spring JDBC data.');
  return result;
}

module.exports = { verifyStoredDdlExport, runSchemaDdlProgramsChecks };
