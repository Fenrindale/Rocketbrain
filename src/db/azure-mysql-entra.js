'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { verifiedSocket } = require('./rds-iam');

const kind = 'azure-mysql-entra';
const code = 'ROCKETBRAIN_AZURE_MYSQL_ENTRA';
const endpoint = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mysql\.database\.azure\.com$/u;
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu;
const accountName = /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/u;
const maxOutput = 32 * 1024;
const commandTimeout = 9000;
const handshakeTimeout = 32000;
const fail = message => Object.assign(new Error(message), { code });
const usesAzureMysqlEntra = profile => profile?.auth?.kind === kind;

function normalizeAzureMysqlEntra(value, { allowUnconfigured = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== kind ||
      Object.keys(value).some(key => !['kind', 'account', 'tenant', 'subscription'].includes(key))) {
    throw fail('Choose Azure Database for MySQL Microsoft Entra authentication.');
  }
  const { account, tenant, subscription } = value;
  if (allowUnconfigured && Object.keys(value).length === 1) return { kind };
  if (typeof account !== 'string' || account.length > 254 || !accountName.test(account) ||
      typeof tenant !== 'string' || !uuid.test(tenant) || typeof subscription !== 'string' || !uuid.test(subscription)) {
    throw fail('Enter the Azure CLI user principal name, tenant ID and subscription ID for this profile.');
  }
  return { kind, account, tenant: tenant.toLowerCase(), subscription: subscription.toLowerCase() };
}

function validateAzureMysqlRoute({ host, user, port = 3306, transport, ssh }, ssl) {
  if (typeof host !== 'string' || !endpoint.test(host) || port !== 3306 || typeof user !== 'string' ||
      !user || user !== user.trim() || user.length > 128 || /[\x00-\x1f\x7f]/u.test(user)) {
    throw fail('Use the exact public Azure MySQL Flexible Server hostname, port 3306 and database user.');
  }
  if (transport || ssh || !ssl || ssl.rejectUnauthorized === false || ssl.verifyIdentity === false ||
      ssl.serverName && ssl.serverName !== host || ssl.cert || ssl.key || ssl.pfx || ssl.passphrase) {
    throw fail('Microsoft Entra database authentication requires direct TCP with verified TLS for the exact Azure hostname.');
  }
}

function azureCliPlan(environment = process.env, platform = process.platform) {
  const env = { ...environment };
  const blocked = new Set(['AZURE_CLI_DISABLE_CONNECTION_VERIFICATION', 'ADAL_PYTHON_SSL_NO_VERIFY', 'PYTHONHTTPSVERIFY',
    'AZURE_EXTENSION_DIR', 'AZURE_EXTENSION_USE_DYNAMIC_INSTALL', 'AZURE_CORE_COLLECT_TELEMETRY', 'AZURE_CORE_NO_COLOR',
    'AZURE_CORE_DEBUG', 'AZURE_CORE_VERBOSE', 'AZ_INSTALLER']);
  for (const key of Object.keys(env)) if (blocked.has(key.toUpperCase())) delete env[key];
  Object.assign(env, { AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no', AZURE_CORE_COLLECT_TELEMETRY: 'no', AZURE_CORE_NO_COLOR: 'yes' });
  if (platform !== 'win32') return { executable: 'az', prefix: [], env };

  // The official Windows wrappers run the bundled interpreter with these arguments.
  const sdk = ['Microsoft SDKs', 'Azure', 'CLI2'];
  const supplied = environment.ROCKETBRAIN_AZURE_CLI_ROOT;
  const installs = supplied ? [{ root: supplied, bin: 'bin', installer: 'ZIP' }] :
    [...new Set([environment.ProgramW6432, environment.ProgramFiles, environment['ProgramFiles(x86)']].filter(Boolean))]
      .map(root => ({ root: path.join(root, ...sdk), bin: 'wbin', installer: 'MSI' }));
  for (const { root, bin, installer } of installs) {
    if (!path.isAbsolute(root) || root.startsWith('\\\\')) continue;
    const cli = path.join(root, bin, 'az.cmd');
    const executable = path.join(root, 'python.exe');
    if (fs.lstatSync(cli, { throwIfNoEntry: false })?.isFile() &&
        fs.lstatSync(executable, { throwIfNoEntry: false })?.isFile()) {
      const resolved = fs.realpathSync(executable);
      if (path.relative(executable, resolved) || path.relative(cli, fs.realpathSync(cli))) continue;
      return { executable: resolved, prefix: ['-IBm', 'azure.cli'], env: { ...env, AZ_INSTALLER: installer } };
    }
  }
  throw fail('Install Azure CLI 2.54 or later, or select its official Windows ZIP folder in ROCKETBRAIN_AZURE_CLI_ROOT.');
}

function runAzureCli(plan, args, signal, start = spawn) {
  if (signal?.aborted) return Promise.reject(fail('Microsoft Entra authentication was cancelled.'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = start(plan.executable, [...plan.prefix, ...args], { env: plan.env, cwd: path.dirname(process.execPath),
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { reject(fail('Azure CLI could not start for Microsoft Entra authentication.')); return; }
    let bytes = 0, settled = false;
    const chunks = [];
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      try {
        if (error) {
          if (child.exitCode === null) child.kill();
          reject(error);
        } else {
          const output = Buffer.concat(chunks, bytes);
          try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output))); }
          catch { reject(fail('Azure CLI returned invalid Microsoft Entra authentication output.')); }
          finally { output.fill(0); }
        }
      } finally { for (const chunk of chunks) chunk.fill(0); }
    }
    const cancel = () => finish(fail('Microsoft Entra authentication was cancelled.'));
    const timer = setTimeout(() => finish(fail('Azure CLI timed out during Microsoft Entra authentication.')), commandTimeout);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', chunk => {
      if (settled) { chunk.fill(0); return; }
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > maxOutput) finish(fail('Azure CLI returned too much Microsoft Entra authentication output.'));
    });
    child.once('error', error => finish(fail(error.code === 'ENOENT' ? 'Install Azure CLI 2.54 or later on the machine running the extension.' :
      'Azure CLI could not start for Microsoft Entra authentication.')));
    child.once('close', exit => finish(exit === 0 ? undefined : fail('Azure CLI could not use the selected account. Check its Azure sign-in.')));
    if (signal?.aborted) cancel();
  });
}

const matchingId = (value, selected) => typeof value === 'string' && value.toLowerCase() === selected;

function observedAccount(observed, auth) {
  if (observed?.cloud !== 'AzureCloud' || observed.state !== 'Enabled' || observed.type !== 'user' ||
      observed.account !== auth.account || !matchingId(observed.tenant, auth.tenant) || !matchingId(observed.id, auth.subscription)) {
    throw fail('Azure CLI did not report the reviewed AzureCloud user, tenant and enabled subscription.');
  }
}

function validatedToken(response, auth, now = Date.now()) {
  const token = response?.accessToken;
  const expiry = response?.expires_on;
  if (response?.tokenType !== 'Bearer' || !matchingId(response.tenant, auth.tenant) ||
      !matchingId(response.subscription, auth.subscription) || !Number.isSafeInteger(expiry) ||
      expiry * 1000 - now < 15000 || expiry * 1000 - now > 90 * 60 * 1000 ||
      typeof token !== 'string' || !token || token.length > 16384 || /[^\x21-\x7e]/u.test(token)) {
    throw fail('Azure CLI did not return a fresh Microsoft Entra token for the reviewed tenant and subscription.');
  }
  return token;
}

async function mintAzureMysqlEntraToken(target, { signal, invoke, now = Date.now } = {}) {
  const auth = normalizeAzureMysqlEntra(target.auth);
  if (!invoke) {
    const plan = azureCliPlan();
    invoke = args => runAzureCli(plan, args, signal);
  }
  const selected = ['--subscription', auth.subscription, '--output', 'json', '--only-show-errors'];
  const account = ['account', 'show', ...selected, '--query',
    '{id:id,tenant:tenantId,cloud:environmentName || cloudName,state:state,account:user.name,type:user.type}'];
  observedAccount(await invoke(account, signal), auth);
  const response = await invoke(['account', 'get-access-token', ...selected, '--resource-type', 'oss-rdbms'], signal);
  validatedToken(response, auth, now());
  observedAccount(await invoke(account, signal), auth);
  return response;
}

function createAzureMysqlEntraHandshake(target, mint = mintAzureMysqlEntraToken) {
  let requested = false, sent = false, error;
  const mysql_clear_password = ({ connection }) => async () => {
    const socket = connection.stream;
    const controller = new AbortController();
    const close = () => controller.abort();
    try {
      if (requested || !verifiedSocket(socket, target.host)) {
        throw fail('The Microsoft Entra token can only be sent once over verified TLS for the Azure hostname.');
      }
      requested = true;
      socket.once('close', close);
      const token = validatedToken(await mint(target, { signal: controller.signal }), target.auth);
      if (!verifiedSocket(socket, target.host) || controller.signal.aborted) {
        throw fail('The verified Azure MySQL connection closed before authentication.');
      }
      sent = true;
      return Buffer.from(token + '\0', 'utf8');
    } catch (failure) {
      error = failure?.code === code ? fail(failure.message) : fail('The Microsoft Entra authentication token is unavailable.');
      throw fail(error.message);
    } finally { socket?.off('close', close); }
  };
  return { options: { password: '', authPlugins: { mysql_clear_password } }, sent: () => sent, error: () => error };
}

module.exports = { code, usesAzureMysqlEntra, normalizeAzureMysqlEntra, validateAzureMysqlRoute, azureCliPlan,
  runAzureCli, validatedToken, mintAzureMysqlEntraToken, createAzureMysqlEntraHandshake, handshakeTimeout };
