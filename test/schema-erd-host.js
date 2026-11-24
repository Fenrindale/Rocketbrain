'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runSchemaErdChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const url = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  async function verifySpring() {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springIsolation);
  }

  const tools = api.schemaDiagrams, profiles = api.dbConnections;
  assert.ok(tools && profiles);
  const actor = await mysql.createConnection(config);
  const suffix = randomBytes(6).toString('hex');
  const parent = 'rb_erd_parent_' + suffix, child = 'rb_erd_child_' + suffix;
  const qualified = table => '`' + table + '`';
  const tables = [];
  let managed, virtual, active;
  try {
    await verifySpring();
    await actor.query('CREATE TABLE ' + qualified(parent) + ' (first_id INT NOT NULL, second_id INT NOT NULL, PRIMARY KEY(first_id,second_id)) ENGINE=InnoDB');
    tables.push(parent);
    await actor.query('CREATE TABLE ' + qualified(child) + ' (id INT PRIMARY KEY, parent_first INT NOT NULL, parent_second INT NOT NULL, annotation_ref INT, ' +
      'CONSTRAINT ' + qualified('erd_composite_' + suffix) + ' FOREIGN KEY (parent_first,parent_second) REFERENCES ' + qualified(parent) +
      '(first_id,second_id) ON UPDATE CASCADE) ENGINE=InnoDB');
    tables.push(child);
    await actor.query('INSERT INTO ' + qualified(parent) + ' VALUES (1,2)');
    await actor.query('INSERT INTO ' + qualified(child) + ' VALUES (10,1,2,1)');
    const readSchema = async () => (await actor.query('SHOW CREATE TABLE ' + qualified(child)))[0][0]['Create Table'];
    const before = await readSchema();

    managed = await profiles.save({ profile: { name: 'Schema ERD fixture ' + suffix, group: 'Native Schema Test', color: 'blue',
      host: config.host, port: config.port, user: config.user, database: config.database,
      tls: { mode: 'disabled' }, ssh: null }, password: config.password, rememberPassword: false });
    await profiles.connect({ id: managed.id, password: config.password });
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.schema.diagram'));
    active = await vscode.commands.executeCommand('rocketbrain.schema.diagram', { table: { name: child } });
    assert.ok(active);
    assert.deepEqual(active.diagram.nodes.map(node => node.name), [child, parent]);
    const relationship = active.diagram.edges.find(edge => edge.child === child && edge.parent === parent);
    assert.ok(relationship?.childInDiagram && relationship.parentInDiagram);
    const pairs = [{ child: 'parent_first', parent: 'first_id' }, { child: 'parent_second', parent: 'second_id' }];
    assert.deepEqual(relationship.pairs, pairs);
    assert.equal(relationship.onUpdate, 'CASCADE');
    assert.equal(active.diagram.accountLimited, true);
    assert.equal(active.diagram.foreignKeysLoaded, true);
    assert.deepEqual(active.diagram.nodes.find(node => node.name === parent).columns.map(column => column.primaryKey), [true, true]);

    const custom = structuredClone(active.layout);
    const placement = custom.positions.find(item => item.name === child);
    placement.x += 26;
    placement.y += 27;
    assert.deepEqual(await tools.saveLayout(active.token, custom), custom);
    const layoutFile = tools.layoutDocument(active.token, custom);
    assert.equal(layoutFile.includes(Buffer.from(config.password)), false);
    assert.equal(layoutFile.includes(Buffer.from(config.host)), false);
    assert.deepEqual(tools.importLayout(active.token, layoutFile), custom);
    assert.deepEqual((await tools.openDiagram({ focus: child })).layout, custom);
    active = await tools.openDiagram({ focus: child });
    await assert.rejects(tools.addRelation(active.token, { name: 'Duplicate physical', child, parent, pairs }), /already present/);
    const extended = await tools.addRelation(active.token, { name: 'Local annotation', child, parent,
      pairs: [{ child: 'annotation_ref', parent: 'first_id' }] });
    virtual = extended.diagram.edges.find(edge => edge.kind === 'logical');
    assert.ok(virtual);
    assert.equal(virtual.child, child);
    assert.equal(await readSchema(), before);
    await api.connectMysql(config);
    await assert.rejects(tools.saveLayout(extended.token, custom), /catalog changed/i);
    const unprofiled = await tools.openDiagram({ focus: child });
    assert.equal(unprofiled.diagram.edges.some(edge => edge.id === virtual.id), false);
    await profiles.connect({ id: managed.id, password: config.password });
    active = await tools.openDiagram({ focus: child });
    assert.ok(active.diagram.edges.some(edge => edge.id === virtual.id));
    assert.deepEqual(active.layout, custom);
    const reduced = await tools.removeRelation(active.token, virtual.id);
    assert.equal(reduced.diagram.edges.some(edge => edge.id === virtual.id), false);
    virtual = undefined;
    assert.equal(await readSchema(), before);
    assert.deepEqual((await actor.query('SELECT id,parent_first,parent_second,annotation_ref FROM ' + qualified(child)))[0],
      [{ id: 10, parent_first: 1, parent_second: 2, annotation_ref: 1 }]);
    await verifySpring();
    checks.push('The native Schema Diagram opens against the actual account-visible catalog, exposes the ordered two-column physical FK and both primary-key columns, and focuses its two entities.');
    checks.push('Native diagram positions persisted across reopening and a connection switch, with a strict credential-free layout JSON round-trip and stale frame refusal.');
    checks.push('A local logical FK survived reconnection to its saved profile, was absent in an unprofiled connection, refused an existing physical mapping, and left the database definition and Spring rows unchanged.');
    return { physicalCompositePairs: pairs, layoutRoundTrip: true, savedProfileScope: true, logicalForeignKey: true,
      staleFrameRefused: true, unchangedDdlAndRows: true, springIsolation };
  } finally {
    try {
      if (virtual && managed) {
        if (api.activeConnectionProfile()?.id !== managed.id) await profiles.connect({ id: managed.id, password: config.password });
        active = await tools.openDiagram({ focus: child });
        await tools.removeRelation(active.token, virtual.id);
      }
      await api.disconnectMysql();
      if (managed) await profiles.remove({ id: managed.id, expectedRevision: managed.revision });
    } finally {
      try { for (const table of tables.reverse()) await actor.query('DROP TABLE ' + qualified(table)); }
      finally { await actor.end(); }
    }
  }
}

module.exports = { runSchemaErdChecks };
