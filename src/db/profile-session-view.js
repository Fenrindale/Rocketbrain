'use strict';

const { randomUUID } = require('node:crypto');
const { transportLabel } = require('./local-transport');

function sessionDescription(session) {
  const states = [];
  if (session.busy) states.push('Working');
  if (session.needsReconnect) states.push('Reconnect required');
  else states.push(session.connected ? session.readOnly ? 'Read only' : 'Read/write' : 'Disconnected');
  if (session.inTransaction) states.push('Transaction active');
  if (session.outcomeUnknown) states.push('Outcome unknown');
  states.push(session.openEditors + ' open / ' + session.linkedEditors + ' linked editors');
  return states.join(' · ');
}

function createProfileTree(vscode, { changes, listProfiles, activeProfile, listSessions }) {
  const { Expanded, Collapsed, None } = vscode.TreeItemCollapsibleState;
  const color = profile => profile.color === 'none' ? undefined : new vscode.ThemeColor('charts.' + profile.color);
  const item = (label, id, kind, state) => Object.assign(new vscode.TreeItem(label, state), { id, kind });
  function getChildren(parent) {
    if (parent?.kind === 'session') return [];
    const profiles = listProfiles(), sessions = listSessions(), selected = activeProfile();
    if (!parent) return [...new Set(profiles.map(row => row.profile.group))].map(group => {
      const heading = item(group || 'Connections', 'group:' + group, 'group', Expanded);
      heading.group = group;
      const ids = new Set(profiles.filter(row => row.profile.group === group).map(row => row.id));
      const live = sessions.filter(session => ids.has(session.profileId) && session.connected).length;
      if (live) heading.description = live + ' live ' + (live === 1 ? 'session' : 'sessions');
      return heading;
    });
    if (parent.kind === 'group') return profiles.filter(row => row.profile.group === parent.group).map(({ profile }) => {
      const ownSessions = sessions.filter(session => session.profileId === profile.id);
      const node = item(profile.name, 'profile:' + profile.id, 'profile', ownSessions.length ? Collapsed : None);
      node.profileId = profile.id;
      node.contextValue = 'rocketbrain.connectionProfile';
      node.description = [selected?.id === profile.id ? 'Active catalog' : '', ownSessions.length ?
        ownSessions.filter(session => session.connected).length + '/' + ownSessions.length + ' connected' : '',
      profile.database, transportLabel(profile.transport) || profile.host, profile.tls.mode === 'verify' ? 'TLS' : '',
      profile.ssh ? 'SSH' : '', profile.auth?.kind === 'aws-rds-iam' ? 'IAM' : '',
      profile.auth?.kind === 'password-free' ? 'No password' : ''].filter(Boolean).join(' · ');
      node.tooltip = [profile.name, profile.group, profile.color, profile.user + ' @ ' +
        (transportLabel(profile.transport) || profile.host + ':' + profile.port) + '/' + profile.database,
      profile.transport && !profile.transport.address ? 'Edit the local address before connecting.' : ''].filter(Boolean).join('\n');
      node.iconPath = new vscode.ThemeIcon('database', color(profile));
      if (!ownSessions.length) node.command = { command: 'rocketbrain.connections.connect', title: 'Connect', arguments: [{ profileId: profile.id }] };
      return node;
    });
    const profile = profiles.find(row => row.id === parent.profileId)?.profile;
    if (!profile) return [];
    return sessions.filter(session => session.profileId === profile.id).map(session => {
      const node = item('SQL console ' + session.id.split('-').at(-1), 'session:' + session.id, 'session', None);
      const target = { profileId: profile.id, sessionId: session.id };
      Object.assign(node, target);
      node.contextValue = 'rocketbrain.connectionSession';
      node.description = sessionDescription(session);
      node.tooltip = profile.name + ' / ' + profile.database + '\n' + node.description;
      const icon = session.needsReconnect || session.outcomeUnknown ? 'warning' : session.busy ? 'sync~spin' : 'terminal';
      node.iconPath = new vscode.ThemeIcon(icon, color(profile));
      node.command = { command: 'rocketbrain.connections.revealSession', title: 'Reveal SQL Console', arguments: [target] };
      return node;
    });
  }
  return { onDidChangeTreeData: changes, getTreeItem: node => node, getChildren };
}

const catalogScheme = 'rocketbrain-profile-catalog';
const maxCatalogBytes = 192 * 1024;

function renderProfileCatalog({ profile, catalog }) {
  const lines = [
    'Database profile ' + JSON.stringify(profile.name),
    'Schema ' + JSON.stringify(catalog.database) + ' · ' + (catalog.serverVersion || 'Version unavailable'),
    'Visible to the connected account. Read-only metadata captured at ' + catalog.loadedAt + '.',
    ''
  ];
  let bytes = Buffer.byteLength(lines.join('\n'));
  function add(line) {
    const extra = Buffer.byteLength(line) + 1;
    if (bytes + extra > maxCatalogBytes - 100) return false;
    lines.push(line);
    bytes += extra;
    return true;
  }
  for (const [label, rows] of [['Table', catalog.tables], ['View', catalog.views]]) {
    for (const row of rows) {
      if (!add(label + ' ' + JSON.stringify(row.name)) || row.columns.some(column => !add('  ' + JSON.stringify(column.name) +
          '  ' + column.type + (column.primaryKey ? '  PK' : '') + (column.nullable ? '  NULL' : '  NOT NULL')))) {
        lines.push('', 'Additional objects or columns exceed the display limit.');
        return lines.join('\n');
      }
    }
  }
  if (!catalog.tables.length && !catalog.views.length) add('No tables or views are visible.');
  if (!catalog.complete) add('Some metadata categories were unavailable to this account.');
  return lines.join('\n');
}

function registerProfileCatalogViewer(vscode, subscriptions) {
  const documents = new Map();
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(catalogScheme, {
    provideTextDocumentContent: uri => documents.get(uri.toString()) || ''
  }), vscode.workspace.onDidCloseTextDocument(document => documents.delete(document.uri.toString())));
  return async details => {
    const uri = vscode.Uri.from({ scheme: catalogScheme, path: '/profile-catalog-' + randomUUID() + '.txt' });
    while (documents.size >= 12) documents.delete(documents.keys().next().value);
    documents.set(uri.toString(), renderProfileCatalog(details));
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      return { uri: uri.toString(), database: details.catalog.database, serverVersion: details.catalog.serverVersion,
        tableCount: details.catalog.tables.length, viewCount: details.catalog.views.length };
    } catch (error) {
      documents.delete(uri.toString());
      throw error;
    }
  };
}

module.exports = { catalogScheme, createProfileTree, registerProfileCatalogViewer, renderProfileCatalog, sessionDescription };
