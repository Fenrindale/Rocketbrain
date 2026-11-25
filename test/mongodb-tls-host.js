'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { certificates } = require('../scripts/connection-security-fixture');
const { openMongoDb, inspectMongoTlsCa } = require('../src/db/mongodb');
const { startMongoFixture } = require('./mongodb-fixture');

async function verifyMongoTls(platform, bin, vscode) {
  const fixture = await certificates({ ssh: false, serverName: 'localhost' });
  let server, active;
  const caPath = path.join(fixture.folder, 'ca.pem');
  const wrongPath = path.join(fixture.folder, 'wrong-ca.pem');
  const serverPem = path.join(fixture.folder, 'mongo-server.pem');
  const alias = process.platform === 'win32' ? path.join('C:/Users/Public', 'Rocketbrain-MongoTLS-' + randomUUID()) : null;
  let linked = false;
  try {
    await fs.writeFile(serverPem, fixture.server.cert + '\n' + fixture.server.key + '\n', { flag: 'wx' });
    if (alias) {
      // The Windows mongod TLS backend opens PEM files through an ASCII launcher path.
      await fs.symlink(fixture.folder, alias, 'junction');
      linked = true;
    }
    server = await startMongoFixture(bin, { tls: { host: 'localhost', caPath: alias ? path.join(alias, 'ca.pem') : caPath,
      serverPem: alias ? path.join(alias, 'mongo-server.pem') : serverPem } });
    const observed = await inspectMongoTlsCa(caPath);
    assert.match(observed.sha256, /^[a-f0-9]{64}$/);
    assert.equal(observed.fingerprints.length, 1);
    const configuration = { ...server.config, host: 'localhost', tls: { caPath, caSha256: observed.sha256 } };
    const wrong = await inspectMongoTlsCa(wrongPath);
    await assert.rejects(() => platform.open({ ...configuration, tls: { caPath: wrongPath, caSha256: wrong.sha256 } }),
      { code: 'ROCKETBRAIN_MONGO_TLS_IDENTITY' });
    await assert.rejects(() => platform.open({ ...configuration, host: '127.0.0.1' }),
      { code: 'ROCKETBRAIN_MONGO_TLS_IDENTITY' });
    await assert.rejects(() => platform.open(server.config), { code: 'ROCKETBRAIN_MONGO_READ' });
    await assert.rejects(() => inspectMongoTlsCa(path.join(fixture.folder, 'server.pem')), { code: 'ROCKETBRAIN_MONGO_TLS_CA' });
    const drift = path.join(fixture.folder, 'drift.pem');
    await fs.writeFile(drift, fixture.ca, { flag: 'wx' });
    const prior = await inspectMongoTlsCa(drift);
    await fs.writeFile(drift, fixture.wrongCa);
    await assert.rejects(() => platform.open({ ...configuration, tls: { caPath: drift, caSha256: prior.sha256 } }),
      { code: 'ROCKETBRAIN_MONGO_TLS_CA_CHANGED' });
    await assert.rejects(() => platform.open({ ...configuration, password: configuration.password + 'x' }),
      error => error.code === 'ROCKETBRAIN_MONGO_AUTH' && !error.message.includes(configuration.password));

    active = await platform.open(configuration);
    const source = typeof active.source === 'function' ? active.source() : active.source;
    assert.deepEqual(source, { host: 'localhost', port: server.config.port, authSource: 'admin',
      transport: 'tls-verified', caSha256: observed.sha256 });
    const target = { database: server.sample.database, collection: server.sample.collection };
    const read = await active.find(JSON.stringify(target));
    assert.equal(read.documents[0].serial.$numberLong, server.sample.serial);
    const observedCollection = await active.inspectAggregation(target);
    const grouped = await active.aggregate(JSON.stringify({ ...observedCollection, pipeline: [{ $count: 'total' }] }));
    assert.deepEqual(grouped.documents, [{ total: { $numberInt: '3' } }]);
    assert.equal(await server.readerWriteDenied(), true);

    let nativeEditor = false;
    if (vscode) {
      const uri = await vscode.commands.executeCommand('rocketbrain.mongodb.newFind', target);
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
      const result = await vscode.commands.executeCommand('rocketbrain.mongodb.run');
      assert.ok(result.preview.startsWith('rocketbrain-mongodb-result:'));
      assert.equal(result.documents[0].serial.$numberLong, server.sample.serial);
      nativeEditor = true;
    }
    return { server: server.version, driver: '7.9.1', authenticatedTlsRequired: true, dnsCertificateVerified: true,
      incorrectTrustRejected: true, incorrectNameRejected: true, plaintextRejectedByServer: true, replacedCaRejected: true,
      leafTrustFileRejected: true, scramWrongPasswordRejected: true, typedFind: true, typedAggregation: true,
      vendorReadRoleDeniedWrites: true, nativeEditor, cleaned: true };
  } finally {
    try {
      try { await active?.close(); }
      finally { await server?.stop(); }
    } finally {
      if (linked) {
        assert.equal(await fs.realpath(alias), await fs.realpath(fixture.folder));
        await fs.unlink(alias);
      }
      await fixture.remove();
    }
  }
}

async function runMongoTlsChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_MONGODB_TEST_BIN;
  assert.ok(bin, 'Configure the owned MongoDB fixture executable.');
  const result = await verifyMongoTls({ open: async configuration => {
    await api.mongoDb.open(configuration);
    return api.mongoDb;
  } }, bin, vscode);
  checks.push('MongoDB authenticated verified TLS endpoint with checked server name, CA integrity and real typed reads');
  return result;
}

if (require.main === module) {
  verifyMongoTls({ open: openMongoDb }, process.argv[2]).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runMongoTlsChecks, verifyMongoTls };
