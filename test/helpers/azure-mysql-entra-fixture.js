'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const mysql = require('mysql2');
const { MysqlService } = require('../../src/db/mysql');
const { mintAzureMysqlEntraToken, runAzureCli } = require('../../src/db/azure-mysql-entra');
const { setupWireTlsFixture, mysqlIamEndpoint } = require('./rds-iam-fixture');

const host = 'rocketbrain-fixture.mysql.database.azure.com';
const user = 'Rocketbrain Database Fixture';
const auth = Object.freeze({ kind: 'azure-mysql-entra', account: 'fixture-user@example.invalid',
  tenant: '00000000-0000-4000-8000-000000001111', subscription: '00000000-0000-4000-8000-000000002222' });
const account = Object.freeze({ id: auth.subscription, tenant: auth.tenant, cloud: 'AzureCloud', state: 'Enabled', type: 'user', account: auth.account });

const issuerProgram = [
  "const {randomBytes}=require('node:crypto');",
  'const argv=process.argv.slice(1);',
  'const subscription=argv[argv.indexOf("--subscription")+1];',
  'const account=JSON.parse(process.env.RB_AZURE_FIXTURE_ACCOUNT);',
  'if(argv[0]!=="account"||account.id!==subscription||argv.includes("--tenant"))process.exit(9);',
  'let observed;',
  'if(argv[1]==="show")observed=account;',
  'else if(argv[1]==="get-access-token"&&argv[argv.indexOf("--resource-type")+1]==="oss-rdbms")',
  '  observed={accessToken:"rocketbrain-simulated-"+randomBytes(20).toString("hex"),tokenType:"Bearer",',
  '    tenant:account.tenant,subscription:account.id,expires_on:Math.floor(Date.now()/1000)+300};',
  'else process.exit(9);',
  'process.stdout.write(JSON.stringify(observed));'
].join('\n');

async function verifyAzureProtocol() {
  const credentials = await setupWireTlsFixture(host, 'rb-azure-mysql-');
  const endpoints = [], connections = [], tokens = [], operations = [];
  let secondAccountChanged = false, accountReads = 0;
  const invoke = (args, signal) => {
    operations.push(args.slice(0, 2).join(' '));
    const changed = args[1] === 'show' && ++accountReads === 2 && secondAccountChanged;
    return runAzureCli({ executable: process.execPath, prefix: ['-e', issuerProgram, '--'],
      env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1',
        RB_AZURE_FIXTURE_ACCOUNT: JSON.stringify(changed ? { ...account, account: 'different@example.invalid' } : account) } }, args, signal);
  };
  async function peer(options) {
    const result = await mysqlIamEndpoint(credentials, { databaseUser: user, ...options });
    endpoints.push(result);
    return result;
  }
  function service(peer, { serverName = host, ca = credentials.ca } = {}) {
    const db = new MysqlService({ host: serverName, port: 3306, user, database: 'rocketbrain_fixture', auth,
      ssl: { ca, serverName, verifyIdentity: true, rejectUnauthorized: true } }, {
      createConnection: options => mysql.createConnection({ ...options, stream: () => net.connect(peer.port, '127.0.0.1') }),
      mintAzureToken: (target, { signal }) => mintAzureMysqlEntraToken(target, { signal, invoke })
    });
    connections.push(db);
    return db;
  }
  try {
    const normal = await peer({ verify(token) { assert.match(token, /^rocketbrain-simulated-[0-9a-f]{40}$/u); tokens.push(token); } });
    const db = service(normal);
    const first = await db.openSession('default');
    assert.equal(first.connected, true);
    const second = await db.reconnect('default');
    assert.notEqual(first.connectionId, second.connectionId);
    assert.equal(normal.state.initialEmpty, 2);
    assert.equal(normal.state.receivedTokens, 2);
    assert.equal(normal.state.accepted, 2);
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.deepEqual(operations, ['account show', 'account get-access-token', 'account show', 'account show', 'account get-access-token', 'account show']);

    const noTls = await peer({ secure: false });
    const noToken = await peer({ requestToken: false });
    await assert.rejects(() => service(noTls).openSession('default'));
    await assert.rejects(() => service(normal, { ca: credentials.wrongCa }).openSession('default'));
    await assert.rejects(() => service(normal, { serverName: 'wrong-fixture.mysql.database.azure.com' }).openSession('default'));
    await assert.rejects(() => service(noToken).openSession('default'), /did not authenticate.*Microsoft Entra token/u);
    assert.equal(operations.length, 6);
    assert.deepEqual(noToken.state.commands, []);
    assert.equal(noTls.state.receivedTokens, 0);

    const drift = await peer({});
    secondAccountChanged = true;
    accountReads = 0;
    await assert.rejects(() => service(drift).openSession('default'), /reviewed AzureCloud user/u);
    assert.equal(drift.state.initialEmpty, 1);
    assert.equal(drift.state.receivedTokens, 0);
    assert.deepEqual(drift.state.commands, []);
    assert.deepEqual(operations.slice(6), ['account show', 'account get-access-token', 'account show']);
    return { tokenIssuer: 'simulated local subprocess', vendorLiveAuthentication: false, realTlsMysqlWireAuthSwitch: true,
      tokensAcquiredPerConnection: true, emptyInitialAuthentication: true, plaintextWrongCaAndNameRefused: true,
      apparentEmptyPasswordSuccessRefused: true, changedAccountRefusedBeforeTokenDelivery: true };
  } finally {
    tokens.length = 0;
    try { await Promise.all(connections.map(item => item.dispose())); }
    finally {
      try { await Promise.all(endpoints.map(item => item.close())); }
      finally { await credentials.close(); }
    }
  }
}

module.exports = { host, user, auth, account, verifyAzureProtocol };
