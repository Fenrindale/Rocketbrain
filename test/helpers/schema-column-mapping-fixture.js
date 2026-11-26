'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomBytes} = require('node:crypto');
const mysql = require('mysql2/promise');
const {JOURNAL} = require('../../src/db/schema-recovery');
const {normalizeSnapshot} = require('../../src/db/schema-diff');
const {springJdbcClasspath, runJavaFixture} = require('./instance-inline-fixture');

const q = value => '\x60' + value.replaceAll('\x60', '\x60\x60') + '\x60';
const flags = {allowDestructive: true, allowImplicitCommit: true, allowDependencyChanges: true, allowUnverifiedDependencies: false};
const expected = {
  parent: [['1', '7', '2147483647', 'owned unique한 행'], ['2', '7', '-2147483648', 'owned negative']],
  child: [['11', '7', '2147483647'], ['12', '7', '-2147483648'], ['13', '7', null]]
};
const names = {from: 'legacy_code', to: 'current_code'};

async function ownedConfig(file) {
  assert.ok(file, 'Use an explicitly owned MySQL/MariaDB fixture descriptor.');
  const physical = await fs.realpath(file);
  const folder = path.dirname(physical);
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  assert.equal(owner.id, path.basename(folder));
  const kind = {mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1'};
  const engine = Object.keys(kind).find(name => kind[name] === owner.kind);
  assert.ok(engine);
  const config = JSON.parse(await fs.readFile(physical, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.ok(Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535);
  return {config, engine};
}

async function fixture(config) {
  const actor = await mysql.createConnection({...config, supportBigNumbers: true, bigNumberStrings: true});
  const base = 'rb_mapped_' + randomBytes(5).toString('hex');
  const tables = {parent: base + '_parent', child: base + '_child', peer: base + '_peer'};
  const constraint = base + '_relation';
  const scope = {tables: [tables.parent, tables.child]};
  const columnMappings = {[tables.parent]: [{from: names.from, to: names.to}]};
  const tableNames = [tables.parent, tables.child];
  const definition = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
  let desired;
  await actor.query('CREATE TABLE ' + q(tables.peer) + ' (id INT PRIMARY KEY, untouched VARCHAR(64) NOT NULL)' + definition);
  await actor.execute('INSERT INTO ' + q(tables.peer) + ' VALUES (1, ?)', ['independent peer']);
  const plans = [];
  async function create(projected) {
    const type = projected ? 'BIGINT' : 'INT';
    const name = projected ? names.to : names.from;
    await actor.query('CREATE TABLE ' + q(tables.parent) + ' (id INT PRIMARY KEY, zone_id INT NOT NULL, ' +
      q(name) + ' ' + type + ' NOT NULL, note VARCHAR(64) NOT NULL, UNIQUE KEY named_code (zone_id,' + q(name) + '))' + definition);
    await actor.query('CREATE TABLE ' + q(tables.child) + ' (id INT PRIMARY KEY, zone_id INT NOT NULL, link_code ' + type +
      ' NULL, KEY named_link(zone_id,link_code), CONSTRAINT ' + q(constraint) + ' FOREIGN KEY(zone_id,link_code) REFERENCES ' +
      q(tables.parent) + '(zone_id,' + q(name) + ') ON UPDATE CASCADE ON DELETE RESTRICT)' + definition);
  }
  async function dropSelected() {
    await actor.query('DROP TABLE IF EXISTS ' + q(tables.child));
    await actor.query('DROP TABLE IF EXISTS ' + q(tables.parent));
  }
  async function prepare(capture) {
    await create(true);
    desired = await capture(scope);
    await dropSelected();
    await create(false);
    for (const row of expected.parent) await actor.execute('INSERT INTO ' + q(tables.parent) + ' VALUES (?,?,?,?)', row);
    for (const row of expected.child) await actor.execute('INSERT INTO ' + q(tables.child) + ' VALUES (?,?,?)', row);
    return await capture(scope);
  }
  async function currentRows(projected) {
    const column = q(projected ? names.to : names.from);
    const [parent] = await actor.query({sql: 'SELECT id,zone_id,' + column + ',note FROM ' + q(tables.parent) + ' ORDER BY id', rowsAsArray: true});
    const [child] = await actor.query({sql: 'SELECT id,zone_id,link_code FROM ' + q(tables.child) + ' ORDER BY id', rowsAsArray: true});
    return {parent: parent.map(row => row.map(String)), child: child.map(row => row.map(value => value === null ? null : String(value)))};
  }
  async function checkGraph(capture, projected) {
    assert.deepEqual(await currentRows(projected), expected);
    const snap = await capture(scope);
    const parent = snap.tables.find(table => table.name === tables.parent);
    const child = snap.tables.find(table => table.name === tables.child);
    const name = projected ? names.to : names.from;
    const type = projected ? 'bigint' : 'int';
    assert.match(parent.columns.find(column => column.name === name).type, new RegExp('^' + type + '(?:\\(|$)', 'i'));
    assert.match(child.columns.find(column => column.name === 'link_code').type, new RegExp('^' + type + '(?:\\(|$)', 'i'));
    assert.deepEqual(parent.indexes.find(index => index.name === 'named_code').columns.map(part => part.name), ['zone_id', name]);
    const fk = child.foreignKeys.find(key => key.name === constraint);
    assert.equal(fk.onUpdate, 'CASCADE');
    assert.ok(['RESTRICT', 'NO ACTION'].includes(fk.onDelete));
    assert.deepEqual(fk.columns.map(({name, referencedColumn}) => [name, referencedColumn]), [['zone_id', 'zone_id'], ['link_code', name]]);
    await assert.rejects(actor.execute('INSERT INTO ' + q(tables.child) + ' VALUES (90,7,9000)'), /foreign key|constraint/u);
    await checkPeer();
  }
  async function checkPeer() {
    assert.equal((await actor.query('SELECT untouched FROM ' + q(tables.peer) + ' WHERE id=1'))[0][0].untouched, 'independent peer');
  }
  async function journal(id) {
    const [rows] = await actor.execute('SELECT payload FROM ' + q(JOURNAL) + ' WHERE operation_id=?', [id]);
    assert.equal(rows.length, 1);
    return JSON.parse(rows[0].payload);
  }
  function invalidDesired(kind) {
    const next = structuredClone(desired);
    if (kind === 'index') next.tables.find(table => table.name === tables.parent).indexes.find(index => index.name === 'named_code').name = 'unreviewed_code';
    else if (kind === 'foreign') next.tables.find(table => table.name === tables.child).foreignKeys[0].onUpdate = 'RESTRICT';
    else throw Error('Unknown fixture variant.');
    return normalizeSnapshot(next, {verifyFingerprint: false});
  }
  async function close() {
    try {
      for (const plan of plans) {
        const names = [...new Set(plan.steps.flatMap(step => [step.quarantine, step.shadow, step.backup]).filter(Boolean))];
        // Old and quarantined verified tables can each contain the same staged FK relationship, so clear only this fixture's FKs.
        for (const name of [...tableNames, ...names]) {
          const [rows] = await actor.execute('SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME=?',
            [config.database, name]);
          for (const row of rows) await actor.query('ALTER TABLE ' + q(name) + ' DROP FOREIGN KEY ' + q(row.CONSTRAINT_NAME));
        }
        await dropSelected();
        for (const name of names) await actor.query('DROP TABLE IF EXISTS ' + q(name));
        try {await actor.execute('DELETE FROM ' + q(JOURNAL) + ' WHERE operation_id=?', [plan.id]);}
        catch (error) {if (error.code !== 'ER_NO_SUCH_TABLE') throw error;}
      }
      await dropSelected();
      await actor.query('DROP TABLE IF EXISTS ' + q(tables.peer));
    } finally {await actor.end();}
  }
  return {config, actor, tables, tableNames, constraint, scope, columnMappings, plans, prepare, checkGraph,
    checkPeer, journal, invalidDesired, close, get desired() {return desired;}};
}

async function springRead(s, {javaHome, cpFile, engine, projected}) {
  const parent = await fs.realpath(os.tmpdir());
  const work = await fs.mkdtemp(path.join(parent, 'rb-map-spring-'));
  const file = path.join(work, 'MigrationLineage.java');
  const identifier = q(projected ? names.to : names.from).replaceAll('\x60', '');
  try {
    const sql = 'SELECT p.' + identifier + ' FROM ' + s.tables.parent + ' p JOIN ' + s.tables.child +
      ' c ON p.zone_id=c.zone_id AND p.' + identifier + '=c.link_code ORDER BY c.id';
    await fs.writeFile(file, [
      'import org.springframework.jdbc.core.JdbcTemplate;',
      'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
      'public final class MigrationLineage {',
      '  public static void main(String[] args) {',
      '    var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_MAP_JDBC_URL"),',
      '      System.getenv("RB_MAP_JDBC_USER"), System.getenv("RB_MAP_JDBC_PASSWORD")));',
      '    System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|");',
      '    System.out.print(jdbc.queryForList("' + sql + '", Long.class));',
      '  }',
      '}', ''
    ].join('\n'), {flag: 'wx'});
    const {server: version, output: joined} = await runJavaFixture({javaHome, file, binaryDirectory: work, className: 'MigrationLineage',
      classpath: await springJdbcClasspath(cpFile, engine), config: s.config, engine, jdbcPrefix: 'RB_MAP'});
    assert.match(version, engine === 'mysql' ? /^8\.4\./u : /^11\.4\.[0-9]+-MariaDB/u);
    assert.equal(joined, '[2147483647, -2147483648]');
    return {engine, version, joined};
  } finally {
    const physical = await fs.realpath(work);
    assert.equal(path.relative(parent, path.dirname(physical)), '');
    assert.ok(path.basename(physical).startsWith('rb-map-spring-'));
    await fs.rm(physical, {recursive: true, force: false, maxRetries: 8, retryDelay: 250});
  }
}

module.exports = {q, flags, expected, names, ownedConfig, fixture, springRead};
