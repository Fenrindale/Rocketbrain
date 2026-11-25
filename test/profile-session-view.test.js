'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProfileTree, renderProfileCatalog } = require('../src/db/profile-session-view');

const vscode = {
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { constructor(id, color) { Object.assign(this, { id, color }); } }
};
const profile = (id, group, color) => ({ id, profile: { id, group, color, name: 'Dashboard',
  host: '127.0.0.1', port: 3306, user: 'observer', database: 'fixture', tls: { mode: 'disabled' } } });
const session = (id, profileId, state = {}) => ({ id, profileId, connected: true, readOnly: true, openEditors: 1, linkedEditors: 1, ...state });

test('profile tree keeps distinct colored sessions for separate groups and excludes disconnected sessions from live counts', () => {
  let active = { id: 'one' };
  const profiles = [profile('one', 'Development', 'blue'), profile('two', 'Staging', 'orange')];
  const sessions = [
    session('profile-console-4', 'one', { readOnly: false, inTransaction: true, busy: true, linkedEditors: 2 }),
    session('profile-console-5', 'two', { connected: false, needsReconnect: true, outcomeUnknown: true, openEditors: 0 })
  ];
  const tree = createProfileTree(vscode, {
    listProfiles: () => profiles, activeProfile: () => active, listSessions: () => sessions
  });
  const [development, staging] = tree.getChildren();
  assert.equal(development.description, '1 live session');
  assert.equal(staging.description, undefined);
  const [dev] = tree.getChildren(development), [stage] = tree.getChildren(staging);
  assert.equal(dev.iconPath.color.id, 'charts.blue');
  assert.equal(dev.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.match(dev.description, /^Active catalog · 1\/1 connected/);
  assert.match(stage.description, /^0\/1 connected/);
  const [pending] = tree.getChildren(dev), [lost] = tree.getChildren(stage);
  assert.match(pending.description, /Working · Read\/write · Transaction active · 1 open \/ 2 linked editors/);
  assert.equal(lost.iconPath.color.id, 'charts.orange');
  assert.equal(lost.iconPath.id, 'warning');
  assert.match(lost.description, /Reconnect required · Outcome unknown · 0 open/);
  assert.deepEqual(lost.command.arguments, [{ profileId: 'two', sessionId: 'profile-console-5' }]);
  active = { id: 'two' };
  assert.ok(tree.getChildren(staging).some(row => row.description.startsWith('Active catalog')));
  sessions.pop();
  const [closed] = tree.getChildren(staging);
  assert.equal(closed.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(tree.getChildren(closed), []);
});

test('profile catalog text projects only local metadata identifiers and labels display truncation', () => {
  const p = profile('one', 'Development', 'blue').profile;
  const database = 'catalog_' + 'ü', column = { name: 'written\ntext', type: 'bigint', nullable: false, primaryKey: true, defaultValue: 'omitted' };
  const catalog = { database, serverVersion: '8.4.13', loadedAt: '2026-11-26T00:00:00Z', complete: false,
    tables: [{ name: 'first', columns: [column], comment: 'omitted comment' }], views: [{ name: 'visible_view', columns: [] }] };
  const text = renderProfileCatalog({ profile: p, catalog });
  assert.match(text, /catalog_ü" · 8\.4\.13/);
  assert.match(text, /"written\\ntext"  bigint  PK  NOT NULL/);
  assert.match(text, /"visible_view"/);
  assert.match(text, /unavailable to this account/);
  assert.doesNotMatch(text, /omitted|127\.0\.0\.1|observer/);
  const oversized = { ...catalog, tables: [{ name:'wide', columns: [{ ...column, type: 'x'.repeat(200000) }] }] };
  const bounded = renderProfileCatalog({ profile: p, catalog: oversized });
  assert.match(bounded, /display limit/);
  assert.ok(Buffer.byteLength(bounded) <= 192 * 1024);
});
