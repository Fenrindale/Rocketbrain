'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createConnection } = require('mysql2/promise');
const { forward } = require('../src/db/schema-reprojection');

async function runResultMapChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const fixture = await createConnection(config), sessions = new Set();
  const table = 'rb_map_' + randomBytes(5).toString('hex');
  const fromText = srid => 'ST_GeomFromText(?, ' + srid +
    (srid === 4326 && runtime.dbEngine === 'mysql' ? ", 'axis-order=long-lat'" : '') + ')';
  const [east, north] = forward([127.05, 37.42]);
  const closeTo = (observed, expected) => assert.ok(Math.abs(observed - expected) < 1e-8, { observed, expected });
  const spring = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    return response.json();
  };
  let connected = false;
  try {
    const untouched = await spring();
    assert.deepEqual(untouched, { people: 2, departments: 1, rolledBackNames: 0 });
    await fixture.query('CREATE TABLE ' + table + ' (id INT NOT NULL PRIMARY KEY, geom GEOMETRY) ENGINE=InnoDB');
    const samples = [
      [4326, 'POINT(126.978 37.5665)'],
      [4326, 'POLYGON((126.8 37.4,127.2 37.4,127.2 37.8,126.8 37.8,126.8 37.4),' +
        '(126.94 37.56,126.94 37.62,127.0 37.62,127.0 37.56,126.94 37.56))'],
      [3857, 'POINT(' + east + ' ' + north + ')'],
      [0, 'GEOMETRYCOLLECTION(POINT(3 2),LINESTRING(1 0,2 3))'],
      [32652, 'POINT(430000 4150000)']
    ];
    for (const [index, [srid, text]] of samples.entries()) {
      await fixture.execute('INSERT INTO ' + table + ' VALUES (?, ' + fromText(srid) + ')', [index + 1, text]);
    }
    await fixture.query('INSERT INTO ' + table + ' VALUES (6, NULL)');
    await api.connectMysql(config);
    connected = true;
    const statement = 'SELECT id, geom FROM ' + table + ' ORDER BY id;';
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: statement });
    await vscode.window.showTextDocument(document);
    const described = await api.sqlScripts.describe(document);
    sessions.add(described.sessionId);
    const prepared = await api.sqlScripts.preview(described.id, []);
    const run = await api.sqlScripts.run(prepared.id);
    assert.equal(run.state, 'completed');
    const capture = await api.sqlScripts.openStatement(run.resultId, 0);
    const record = () => api.results().find(item => item.id === capture.resultId);
    assert.equal(capture.executedSql, false);
    assert.deepEqual(record().mapColumns, [1]);
    assert.deepEqual(record().result.rows.map(row => row[0]), [1, 2, 3, 4, 5, 6]);
    const original = api.mapResult(capture.resultId, 1);
    const [geographic, cartesian] = original.groups;
    const [point, polygon, projected] = geographic.features;
    assert.deepEqual([point.srid, polygon.srid, projected.srid], [4326, 4326, 3857]);
    const raw = JSON.parse(record().result.rows[0][1]);
    closeTo(raw.x, 126.978);
    closeTo(raw.y, 37.5665);
    closeTo(point.parts[0].points[0][0], 126.978);
    closeTo(point.parts[0].points[0][1], 37.5665);
    closeTo(projected.parts[0].points[0][0], 127.05);
    closeTo(projected.parts[0].points[0][1], 37.42);
    assert.equal(polygon.parts[0].rings.length, 2);
    assert.deepEqual(cartesian.features[0].parts.map(part => part.type), ['point', 'line']);
    assert.deepEqual(original.omitted.map(item => item.reason), ['unsupported SRID 32652', 'SQL NULL']);
    assert.equal(original.mappedRows, 4);
    await fixture.execute('UPDATE ' + table + ' SET geom=' + fromText(4326) + ' WHERE id=1', ['POINT(130 35)']);
    await vscode.commands.executeCommand('rocketbrain.openTable', table);
    const tableView = api.results().at(-1);
    sessions.add(tableView.sessionId);
    assert.equal(tableView.result.edit.table, table, tableView.error);
    await api.tableAction(tableView.id, { type: 'browseTable', query: { page: 0, pageSize: 25, sort: [],
      filters: [{ column: 'id', operator: 'gt', value: { kind: 'value', text: '0' } }] } });
    const filtered = api.results().find(item => item.id === tableView.id);
    assert.equal(filtered.editError, undefined, filtered.editError);
    assert.match(filtered.result.browse.sql, /\bWHERE .* > \?/);
    const browse = api.mapResult(tableView.id, 1);
    closeTo(browse.groups[0].features[0].parts[0].points[0][0], 130);
    await api.disconnectMysql();
    connected = false;
    assert.deepEqual(api.mapResult(capture.resultId, 1), original);
    assert.deepEqual(await spring(), untouched);
    checks.push('Mapped native GEOMETRY across EPSG:4326 and EPSG:3857, kept SRID 0 separate and matched polygon holes and collection parts on the captured rows.');
    checks.push('Text-protocol query capture and bound table browsing retained geometry after source data changed. The disconnected saved map used the original capture.');
    return { engine: runtime.dbEngine, mappedRows: original.mappedRows, geographicRows: geographic.features.length,
      cartesianRows: cartesian.features.length, omissions: original.omitted.length, polygonHole: true,
      axisOrderCorrect: true, projectionCorrect: true, rawPreviewPreserved: true, retainedAfterDisconnect: true, spring: untouched };
  } finally {
    try {
      if (connected) {
        for (const session of sessions) if (session) await api.closeConsoleSession(session);
        await api.disconnectMysql();
      }
      await fixture.query('DROP TABLE IF EXISTS ' + table);
    } finally { await fixture.end(); }
  }
}

module.exports = { runResultMapChecks };
