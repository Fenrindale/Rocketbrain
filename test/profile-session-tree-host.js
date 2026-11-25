'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const springBaseline = { people: 2, departments: 1, rolledBackNames: 0 };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function verifyProfileSessionTree(runtime, peerConfig, api, vscode, checks) {
  const resources = [], profiles = api.dbConnections, opened = [], saved = [];
  const suffix = randomBytes(5).toString('hex'), table = 'rb_multiroute_' + suffix;
  const tableFor = engine => table + '_' + engine;
  const spring = async () => {
    const endpoint = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springBaseline);
  };
  const opposite = runtime.dbEngine === 'mysql' ? 'mariadb' : 'mysql';
  const tree = profiles.tree;
  function profileNode(id) {
    return tree.getChildren().flatMap(group => tree.getChildren(group)).find(row => row.profileId === id);
  }
  function sessionNode(target) {
    const rows = tree.getChildren(profileNode(target.profileId));
    const node = rows.find(row => row.sessionId === target.sessionId);
    assert.ok(node, 'Expected a session under the selected profile.');
    return node;
  }
  async function save(fixture, engine, group, color) {
    const { config } = fixture;
    const profile = { id: randomUUID(), name: engine + ' ' + suffix, group, color, host: config.host, port: config.port,
      user: config.user, database: config.database, tls: { mode: 'disabled' } };
    const result = await profiles.save({ profile, password: config.password, rememberPassword: true });
    saved.push(result);
    return result;
  }
  async function open(profile) {
    const console = await vscode.commands.executeCommand('rocketbrain.connections.openDedicatedConsole', { profileId: profile.id });
    const target = { profileId: profile.id, sessionId: console.sessionId };
    opened.push(target);
    return { ...target, uri: console.uri };
  }
  async function run(target, sql) {
    await vscode.commands.executeCommand('rocketbrain.connections.revealSession', sessionNode(target));
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.toString(), target.uri);
    const document = editor.document;
    if (document.getText() !== sql) {
      assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), sql)), true);
    }
    editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    const result = await vscode.commands.executeCommand('rocketbrain.runQuery');
    const history = api.results().find(row => row.id === result);
    assert.ok(history?.result, history?.error || 'Expected an exact SQL result.');
    return history.result;
  }
  let events = 0;
  const watch = tree.onDidChangeTreeData(() => { events++; });
  try {
    const primary = await owned(runtime.dbConfigPath); resources.push([primary, runtime.dbEngine]);
    const peer = await owned(peerConfig); resources.push([peer, opposite]);
    assert.notEqual(primary.config.port, peer.config.port);
    assert.equal(/mariadb/i.test(primary.version), runtime.dbEngine === 'mariadb');
    assert.equal(/mariadb/i.test(peer.version), opposite === 'mariadb');
    for (const [fixture, engine] of resources) {
      await fixture.actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY,label VARCHAR(40)) ENGINE=InnoDB');
      await fixture.actor.query('CREATE TABLE ' + tableFor(engine) + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
      await fixture.actor.execute('INSERT INTO ' + table + ' VALUES (1,?)', [engine + ' original']);
    }
    await spring();

    const primaryProfile = await save(primary, runtime.dbEngine, 'Development ' + suffix, 'blue');
    const peerProfile = await save(peer, opposite, 'Staging ' + suffix, 'orange');
    await profiles.connect({ id: primaryProfile.id });
    const left = await open(primaryProfile), right = await open(peerProfile);
    assert.equal(api.activeConnectionProfile().id, primaryProfile.id);
    assert.ok(profileNode(primaryProfile.id).description.includes('Active catalog'));
    assert.ok(profileNode(primaryProfile.id).description.includes('1/1 connected'));
    assert.ok(!profileNode(peerProfile.id).description.includes('Active catalog'));
    assert.equal(profileNode(primaryProfile.id).iconPath.color.id, 'charts.blue');
    assert.equal(sessionNode(right).iconPath.color.id, 'charts.orange');
    assert.equal(sessionNode(right).contextValue, 'rocketbrain.connectionSession');
    assert.match(sessionNode(right).description, /Read only/);
    assert.equal(tree.getChildren().filter(group => group.description === '1 live session').length, 2);

    const select = 'SELECT VERSION(),label FROM ' + table + ' WHERE id=1';
    assert.deepEqual((await run(left, select)).rows, [[primary.version, runtime.dbEngine + ' original']]);
    assert.deepEqual((await run(right, select)).rows, [[peer.version, opposite + ' original']]);

    const preview = await vscode.commands.executeCommand('rocketbrain.connections.inspectSessionCatalog', sessionNode(right));
    assert.equal(preview.serverVersion, peer.version);
    const catalog = vscode.window.activeTextEditor.document;
    assert.equal(catalog.uri.scheme, 'rocketbrain-profile-catalog');
    assert.match(catalog.getText(), new RegExp(tableFor(opposite)));
    assert.doesNotMatch(catalog.getText(), new RegExp(tableFor(runtime.dbEngine)));
    const content = catalog.getText();
    await vscode.commands.executeCommand('type', { text: 'owned type probe' });
    assert.equal(catalog.getText(), content);
    assert.equal(catalog.isDirty, false);
    assert.notEqual(api.activeConnectionProfile().id, peerProfile.id);
    const live = api.liveCatalogSnapshot();
    assert.ok(live.tables.some(row => row.name === tableFor(runtime.dbEngine)));
    assert.ok(!live.tables.some(row => row.name === tableFor(opposite)));

    await api.configureConsoleSession(right.sessionId, { readOnly: false, autocommit: false });
    await api.controlConsoleSession(right.sessionId, 'begin');
    await run(right, "UPDATE " + table + " SET label='pending' WHERE id=1");
    assert.match(sessionNode(right).description, /Transaction active/);
    const reviewed = await api.closeProfileSession(right);
    assert.equal(reviewed.state, 'retained');
    assert.deepEqual((await run(right, select)).rows, [[peer.version, 'pending']]);
    assert.deepEqual((await run(left, select)).rows, [[primary.version, runtime.dbEngine + ' original']]);
    const activeTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const rightTab = activeTabs.find(tab => tab.input?.uri?.toString() === right.uri);
    assert.ok(rightTab);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(right.uri));
    assert.equal(await doc.save(), true);
    assert.equal(await vscode.window.tabGroups.close(rightTab), true);
    assert.equal(await api.revealProfileSession(right).then(item => item.uri), right.uri);
    assert.deepEqual((await run(right, select)).rows, [[peer.version, 'pending']]);
    await assert.rejects(api.closeProfileSession({ sessionId: right.sessionId, profileId: left.profileId }), /selected profile session/);
    let observedApproval = false;
    assert.equal((await api.closeProfileSession(right, risk => {
      observedApproval = risk.inTransaction && !risk.outcomeUnknown && risk.editorCount === 1;
      return observedApproval;
    })).state, 'closed');
    assert.ok(observedApproval);
    assert.deepEqual((await peer.actor.query('SELECT label FROM ' + table))[0], [{ label: opposite + ' original' }]);
    assert.deepEqual(tree.getChildren(profileNode(peerProfile.id)), []);
    assert.deepEqual((await run(left, select)).rows, [[primary.version, runtime.dbEngine + ' original']]);
    assert.equal(api.activeConnectionProfile().id, primaryProfile.id);
    assert.equal((await vscode.commands.executeCommand('rocketbrain.connections.closeSession', sessionNode(left))).state, 'closed');
    assert.equal(api.profileSessionList().length, 0);
    assert.ok(events >= 8, 'Session/view changes should refresh existing entries.');
    await spring();
    checks.push('Separate simultaneous MySQL and MariaDB profiles remained active under their colored connection groups and used separate catalogs.');
    checks.push('A pending peer write survived editor close and reopen, then rolled back only after explicit scoped approval.');
    return { primaryEngine: runtime.dbEngine, primaryVersion: primary.version, peerEngine: opposite, peerVersion: peer.version,
      physicalServers: 2, groupColorAndLiveHealth: true, separateReadOnlyCatalogEditor: true, transactionAwareClose: true,
      dirtyWriteIsolated: true, reopenPreservedTransaction: true, approvedCloseRolledBack: true, staleProfileTargetRefused: true,
      independentSurvivingConsoleAndCatalog: true, treeUpdates: events, springIsolation: springBaseline };
  } finally {
    watch.dispose();
    try {
      for (const target of opened) if (api.profileSessionList().some(row => row.id === target.sessionId)) await api.closeProfileSession(target, () => true);
      await api.disconnectMysql();
      for (const record of saved) await profiles.remove({ id: record.id, expectedRevision: record.revision });
    } finally {
      for (const [fixture, engine] of resources.reverse()) {
        try { await fixture.actor.query('DROP TABLE IF EXISTS ' + table + ', ' + tableFor(engine)); }
        finally { await fixture.actor.end(); }
      }
    }
  }
}

async function runProfileSessionTreeChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const managedPeer = process.env.ROCKETBRAIN_SECONDARY_DB_CONFIG;
  if (managedPeer) return verifyProfileSessionTree(runtime, managedPeer, api, vscode, checks);
  const peer = runtime.dbEngine === 'mysql' ? await require('../scripts/integration-db-fixture').startFixture() :
    await require('../scripts/integration-mysql').startMysqlFixture();
  try { return await verifyProfileSessionTree(runtime, peer.configPath, api, vscode, checks); }
  finally { await peer.stop(); }
}

module.exports = { runProfileSessionTreeChecks, verifyProfileSessionTree };
