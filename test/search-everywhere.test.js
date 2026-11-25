'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { actionsIndex, gitIndex, gitSummary, rankItems, settingsIndex } = require('../src/navigation-index');
const { searchDatabaseText } = require('../src/db/unified-search');
const { contextOf } = require('../src/db/object-source');
const { MysqlService } = require('../src/db/mysql');
const { withSearchGitFixture } = require('./search-everywhere-host');
const { owned } = require('./schema-stored-diff-host');

test('settings search uses only schema keys and public descriptions', () => {
  const extensions = [{ id: 'rocketbrain-local.rocketbrain', isActive: true, packageJSON: { contributes: { configuration: [
    { properties: { 'rocketbrain.java.javaHome': { default: 'private-test-path', description: 'Select the local JVM runtime.' },
      'rocketbrain.java.oldRuntime': { description: 'old', deprecationMessage: 'Retired' } } }
  ] } } }];
  const choices = settingsIndex(extensions);
  const matches = rankItems(choices, 'local JVM runtime');
  assert.equal(matches[0]?.key, 'rocketbrain.java.javaHome');
  assert.equal(choices.some(item => item.key === 'rocketbrain.java.oldRuntime'), false);
  assert.doesNotMatch(JSON.stringify(choices), /private-test-path/);
  const mixed = rankItems([...choices, { type: 'file', label: 'editor.fontSize', description: 'preferences' }], 'editor.fontSize');
  assert.deepEqual(new Set(mixed.slice(0, 2).map(item => item.type)), new Set(['file', 'setting']));
});

test('action search ranks only registered, public action titles', () => {
  const active = { id: 'rocketbrain-local.rocketbrain', isActive: true, packageJSON: { contributes: { commands: [
    { command: 'rocketbrain.openTable', title: 'Open Table', category: 'Rocketbrain' },
    { command: 'rocketbrain.unknown', title: 'Open Unknown' },
    { command: 'rocketbrain.hidden', title: '%unsupported.translation%' }
  ] } } };
  const actions = actionsIndex([active], ['rocketbrain.openTable', 'rocketbrain.hidden', 'workbench.action.openSettings']);
  assert.deepEqual(rankItems(actions, 'open table').map(item => item.command), ['rocketbrain.openTable']);
  assert.deepEqual(rankItems(actions, 'open').map(item => item.command).sort(), ['rocketbrain.openTable', 'workbench.action.openSettings']);
});

test('Git search resolves bounded nested repository history without mutating the worktree or index', async () => {
  const directory = path.join(__dirname, '../test-output');
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.mkdtemp(path.join(directory, 'rb-git-search-workspace-'));
  const uri = fsPath => ({ scheme: 'file', fsPath });
  const folder = { uri: uri(await fs.realpath(root)), name: 'Spring' };
  const vscode = { Uri: { file: uri }, workspace: { isTrusted: true, workspaceFolders: [folder], getWorkspaceFolder: () => folder } };
  try {
    await withSearchGitFixture(root, root, async fixture => {
      const items = await gitIndex(vscode);
      const branch = items.find(item => item.type === 'branch' && item.label === fixture.branch);
      assert.equal(branch?.hash, fixture.hash);
      const commit = rankItems(items, fixture.term).find(item => item.type === 'commit');
      assert.equal(commit?.hash, fixture.hash);
      const raw = await gitSummary(vscode, commit);
      assert.ok(raw.includes(fixture.subject));
      assert.ok(raw.includes(fixture.filename));
      assert.doesNotMatch(raw, /\+original fixture/);
      await assert.rejects(gitSummary(vscode, { ...commit, repo: { ...commit.repo, key: 'stale' } }), /worktree changed/);
      vscode.workspace.isTrusted = false;
      assert.deepEqual(await gitIndex(vscode), []);
      await assert.rejects(gitSummary(vscode, commit), /trusted/);
    });
  } finally {
    assert.match(path.basename(root), /^rb-git-search-workspace-/);
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(directory));
    await fs.rmdir(root);
  }
});

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('database search finds a live object by name without reading its definition',
  { skip: !fixture && 'Run an owned Spring server and DB fixture.', timeout: 45000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(fixture, 'utf8'));
    const { actor, config, version } = await owned(runtime.dbConfigPath);
    const db = new MysqlService(config), table = 'rb_search_db_' + randomBytes(4).toString('hex');
    try {
      await actor.query(`CREATE TABLE ${table} (id BIGINT PRIMARY KEY) ENGINE=InnoDB`);
      const query = (...args) => db._metadataQuery(...args);
      const report = await searchDatabaseText(query, await contextOf(query), { term: table, includeDdl: false });
      assert.ok(report.names.some(item => item.object.kind === 'table' && item.object.name === table));
      assert.deepEqual(report.ddl, []);
      assert.equal(report.coverage.inspectedDefinitions, 0);
      const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200);
      const jdbc = await response.json();
      assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
      console.log(JSON.stringify({ engine: runtime.dbEngine, version, currentNameOnly: true, jdbc }));
    } finally {
      try { await actor.query(`DROP TABLE IF EXISTS ${table}`); }
      finally { await Promise.all([actor.end(), db.dispose()]); }
    }
  });
