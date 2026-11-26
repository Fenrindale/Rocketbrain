'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { host, user, auth, verifyAzureProtocol } = require('./helpers/azure-mysql-entra-fixture');

async function runAzureMysqlEntraChecks(api, _vscode, checks) {
  const manager = api.dbConnections, name = 'Owned Azure MySQL profile ' + randomUUID();
  const profile = { name, host, user, database: 'rocketbrain_fixture', tls: { mode: 'verify', serverName: host }, auth };
  let saved;
  try {
    saved = await manager.save({ profile, verify: false });
    assert.equal(saved.hasSavedPassword, false);
    const editor = await manager.openEditor(saved.id);
    try { assert.deepEqual(editor.profile.auth, auth); }
    finally { manager.closeEditor(editor.editorId); }
    const portable = manager.exportProfiles();
    assert.equal(portable.version, 10);
    assert.deepEqual(portable.profiles.find(item => item.name === name).auth, { kind: auth.kind });
    const wire = await verifyAzureProtocol();
    checks.push('The installed Azure MySQL profile retains its reviewed local account without a saved password and exports only the auth kind.');
    return { installedProfile: true, portableAccountOmitted: true, wire };
  } finally {
    if (saved) await manager.remove({ id: saved.id, expectedRevision: saved.revision });
  }
}

module.exports = { runAzureMysqlEntraChecks };
