'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Script } = require('node:vm');
const { normalizeProfile, createConnectionProfiles } = require('../src/db/connection-profiles');
const { connectionHtml, reviewAzureMysqlProfile } = require('../src/db/connection-profiles-vscode');
const { azureCliPlan, runAzureCli, validatedToken, mintAzureMysqlEntraToken } = require('../src/db/azure-mysql-entra');
const { host, user, auth, account, verifyAzureProtocol } = require('./helpers/azure-mysql-entra-fixture');

const profile = { name: 'Entra fixture', host, user, database: 'fixture', tls: { mode: 'verify', serverName: host }, auth };

test('Entra profiles keep exact Azure DNS and TLS, explicit identity and portable credential boundaries', async () => {
  assert.deepEqual(normalizeProfile(profile).auth, auth);
  for (const invalid of [{ host: '127.0.0.1' }, { host: host + '.example.invalid' }, { host: 'privatelink.' + host },
    { port: 3307 }, { tls: { mode: 'disabled' } }, { tls: { mode: 'verify', serverName: 'another.example.invalid' } },
    { tls: { mode: 'verify', certPath: path.resolve('cert.pem'), keyPath: path.resolve('key.pem') } },
    { tls: { mode: 'verify', serverTrust: 'jks', trustStorePath: path.resolve('trust.jks') } },
    { auth: { ...auth, account: '--debug' } }, { auth: { ...auth, tenant: 'anything' } }, { auth: { ...auth, token: 'value' } }]) {
    assert.throws(() => normalizeProfile({ ...profile, ...invalid }));
  }
  const values = new Map(), secrets = new Map();
  const manager = createConnectionProfiles({ state: { get: (key, fallback) => values.get(key) ?? fallback,
    async update(key, value) { values.set(key, value); } }, secrets: { get: async key => secrets.get(key),
    async store(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } },
  isTrusted: () => true, getActiveProfile: () => undefined, createService: () => assert.fail('Unexpected network') });
  try {
    await assert.rejects(manager.save({ profile, verify: false, password: 'fixture-only' }), /without a database password/u);
    await assert.rejects(manager.save({ profile, verify: false, rememberPassword: true }), /temporary tokens/u);
    const saved = await manager.save({ profile, verify: false });
    assert.equal(saved.hasSavedPassword, false);
    assert.equal(secrets.size, 0);
    const portable = manager.exportProfiles();
    assert.equal(portable.version, 10);
    assert.deepEqual(portable.profiles[0].auth, { kind: auth.kind });
    assert.equal(JSON.stringify(portable).includes(auth.account), false);
    await assert.rejects(manager.importProfiles({ ...portable, version: 9 }), /format 10/u);
    await assert.rejects(manager.importProfiles({ ...portable, profiles: [{ ...portable.profiles[0], auth }] }), /unsupported fields/u);
    assert.deepEqual(await manager.importProfiles(portable), { imported: 1, connectionsAttempted: 0 });
    const imported = manager.list().find(item => item.id !== saved.id);
    await assert.rejects(manager.connect({ id: imported.id }), /local Azure CLI account/u);
  } finally { await manager.dispose(); }
});

test('Entra connection editor reviews the proposed account, tenant and exact DB route before changes', async () => {
  const prompts = [];
  let response;
  const vscode = { window: { showWarningMessage: async (...values) => { prompts.push(values); return response; } } };
  assert.equal(await reviewAzureMysqlProfile(vscode, profile, null), null);
  response = 'Approve Azure CLI Account';
  const accepted = await reviewAzureMysqlProfile(vscode, profile, null);
  assert.deepEqual(accepted.auth, auth);
  assert.equal(prompts[1][1].modal, true);
  for (const value of [host, auth.account, auth.tenant, auth.subscription]) assert.ok(prompts[1][1].detail.includes(value));
  await reviewAzureMysqlProfile(vscode, accepted, accepted);
  assert.equal(prompts.length, 2);
  await reviewAzureMysqlProfile(vscode, { ...accepted, user: 'New SQL user' }, accepted);
  assert.equal(prompts.length, 3);
  const html = connectionHtml('fixture');
  assert.match(html, /value="azure-mysql-entra"/u);
  assert.match(html, /id="azureAccount"/u);
  assert.doesNotThrow(() => new Script(/<script nonce="fixture">([\s\S]*?)<\/script>/u.exec(html)[1]));
});

test('Entra token acquisition chooses the reviewed subscription and validates fresh vendor-shaped output', async () => {
  const now = Date.now(), token = 'simulated-fixture-token';
  const response = { accessToken: token, expires_on: Math.floor(now / 1000) + 300, tokenType: 'Bearer',
    tenant: auth.tenant, subscription: auth.subscription };
  const calls = [];
  const issued = await mintAzureMysqlEntraToken(profile, { now: () => now, invoke: async args => {
    calls.push(args);
    return args[1] === 'show' ? account : response;
  } });
  assert.deepEqual(issued, response);
  assert.deepEqual(calls.map(args => args[1]), ['show', 'get-access-token', 'show']);
  assert.ok(calls.every(args => args[args.indexOf('--subscription') + 1] === auth.subscription && !args.includes('--tenant')));
  assert.equal(calls[1][calls[1].indexOf('--resource-type') + 1], 'oss-rdbms');
  assert.equal(validatedToken(response, auth, now), token);
  for (const invalid of [{ expires_on: Math.floor(now / 1000) + 10 }, { expires_on: Math.floor(now / 1000) + 7200 },
    { subscription: auth.tenant }, { tenant: auth.subscription }, { tokenType: 'other' }, { accessToken: 'contains\nnewline' }]) {
    assert.throws(() => validatedToken({ ...response, ...invalid }, auth, now), error => !error.message.includes(token));
  }
  await assert.rejects(mintAzureMysqlEntraToken(profile, { invoke: async () => ({ ...account, cloud: 'AzureChinaCloud' }) }),
    /reviewed AzureCloud user/u);
});

test('Entra CLI runs shell-free with bounded, redacted output and cancellation', async () => {
  const planned = azureCliPlan({ AZURE_CLI_DISABLE_CONNECTION_VERIFICATION: '1', Azure_Extension_Dir: 'unexpected',
    AZURE_CONFIG_DIR: 'existing-cli-session' }, 'linux');
  assert.equal(planned.env.AZURE_CLI_DISABLE_CONNECTION_VERIFICATION, undefined);
  assert.equal(planned.env.Azure_Extension_Dir, undefined);
  assert.equal(planned.env.AZURE_CONFIG_DIR, 'existing-cli-session');
  assert.equal(planned.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, 'no');
  const node = script => ({ executable: process.execPath, prefix: ['-e', script], env: {} });
  await assert.rejects(runAzureCli(node("process.stdout.write('private-test-text');process.exit(2)"), [], undefined),
    error => /selected account/u.test(error.message) && !error.message.includes('private-test-text'));
  await assert.rejects(runAzureCli(node("process.stdout.write('a'.repeat(40000))"), [], undefined), /too much/u);
  const controller = new AbortController();
  const pending = runAzureCli(node('setTimeout(()=>{},30000)'), [], controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/u);
});

test('Windows Azure CLI resolves the official MSI or explicit ZIP layout without calling a batch shell',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await fs.realpath(tmpdir());
    const folder = await fs.mkdtemp(path.join(root, 'rb-cli-plan-'));
    t.after(async () => {
      assert.equal(await fs.realpath(folder), folder);
      assert.equal(path.dirname(folder), root);
      assert.match(path.basename(folder), /^rb-cli-plan-[a-z0-9]+$/iu);
      await fs.rm(folder, { recursive: true });
    });
    const msi = path.join(folder, 'Microsoft SDKs', 'Azure', 'CLI2');
    for (const [installation, launcher, env, installer] of [
      [msi, 'wbin', { ProgramFiles: folder }, 'MSI'],
      [path.join(folder, 'portable'), 'bin', { ROCKETBRAIN_AZURE_CLI_ROOT: path.join(folder, 'portable') }, 'ZIP']
    ]) {
      await fs.mkdir(path.join(installation, launcher), { recursive: true });
      await fs.writeFile(path.join(installation, launcher, 'az.cmd'), 'fixture wrapper');
      const executable = path.join(installation, 'python.exe');
      await fs.writeFile(executable, 'fixture interpreter placeholder');
      const plan = azureCliPlan(env, 'win32');
      assert.equal(plan.env.AZ_INSTALLER, installer);
      assert.equal(plan.executable, executable);
      assert.deepEqual(plan.prefix, ['-IBm', 'azure.cli']);
    }
    assert.throws(() => azureCliPlan({ ROCKETBRAIN_AZURE_CLI_ROOT: 'relative' }, 'win32'), /Install Azure CLI/u);
  });

test('simulated CLI issuer delivers fresh token through verified TLS and a real MySQL auth switch',
  { skip: process.env.ROCKETBRAIN_AZURE_MYSQL_WIRE_TEST !== '1', timeout: 65000 }, async () => {
    const result = await verifyAzureProtocol();
    assert.equal(result.realTlsMysqlWireAuthSwitch, true);
    assert.equal(result.vendorLiveAuthentication, false);
  });
