'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { browserRuntime } = require('./helpers/browser-runtime');
const { parseVersion } = require('../src/desktop-updater');

const [desktop, outputParent, expectedVersion, expectedInstallerSha256] = process.argv.slice(2);
assert.ok(desktop && outputParent,
  'Usage: node test/desktop-updater-native.cjs <isolated Rocketbrain.exe> <output directory> [available version] [installer SHA-256]');
assert.ok(!expectedVersion || parseVersion(expectedVersion));
assert.ok(!expectedInstallerSha256 || /^[0-9a-f]{64}$/.test(expectedInstallerSha256));
const executable = fs.realpathSync(desktop);
assert.equal(path.basename(executable).toLowerCase(), 'rocketbrain.exe');
const installation = path.dirname(executable);
assert.ok(fs.lstatSync(path.join(installation, '.rocketbrain-isolated')).isFile(),
  'The updater test requires an installer-created isolated installation.');
const product = JSON.parse(fs.readFileSync(path.join(installation, 'resources/app/product.json'), 'utf8'));
const installedVersion = product.rocketbrainDesktop.version;
const { chromium } = browserRuntime();
assert.ok(chromium, 'A local Playwright/Chromium runtime is required.');

fs.mkdirSync(outputParent, { recursive: true });
const output = fs.mkdtempSync(path.join(fs.realpathSync(outputParent), 'updater-'));
const profile = path.join(output, 'profile');
const settings = path.join(profile, 'User');
const staging = path.join(settings, 'globalStorage/rocketbrain-local.rocketbrain/desktop-updates');
const driver = path.join(output, 'driver');
for (const folder of [settings, driver]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none',
  'window.confirmBeforeClose': 'never',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
}));
fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
  publisher: 'rocketbrain-smoke', name: 'updater-native-driver', version: '1.0.0',
  engines: { vscode: '^1.100.0' }, main: './driver.cjs',
  activationEvents: ['onStartupFinished'], extensionDependencies: ['rocketbrain-local.rocketbrain'],
}));
fs.writeFileSync(path.join(driver, 'driver.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
exports.activate = async context => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  await extension.activate();
  const output = path.dirname(context.extensionPath);
  fs.writeFileSync(path.join(output, 'ready.json'), JSON.stringify({
    executable: process.execPath,
    appRoot: vscode.env.appRoot,
    storageScheme: context.globalStorageUri.scheme,
    command: (await vscode.commands.getCommands()).includes('rocketbrain.desktop.checkForUpdates')
  }));
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(output, 'quit'))) return;
    clearInterval(timer);
    vscode.commands.executeCommand('workbench.action.quit');
  }, 100);
  context.subscriptions.push({dispose: () => clearInterval(timer)});
};
`);

async function waitFor(action, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  do {
    const result = await action();
    if (result) return result;
    await delay(125);
  } while (Date.now() < deadline);
  throw new Error(message);
}

function stagedFiles() {
  if (!fs.existsSync(staging)) return [];
  return fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => fs.readdirSync(path.join(staging, entry.name)).map(name => path.join(staging, entry.name, name)));
}

async function launch() {
  const owned = ['shared-data-dir', 'agents-user-data-dir', 'agents-extensions-dir', 'agent-plugins-dir',
    'extensions-download-dir', 'extensions-dir'].map(name => `--${name}=${path.join(output, name)}`);
  const child = spawn(executable, ['--new-window', `--user-data-dir=${profile}`, ...owned,
    `--extensionDevelopmentPath=${driver}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-telemetry', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  { windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')) });
  let endpoint;
  let stopped;
  let tail = '';
  let browser;
  let page;
  let failed = false;
  const capture = data => {
    tail = (tail + data.toString()).slice(-8000);
    endpoint ||= tail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\da-f-]+)/i)?.[1];
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', error => { stopped = { error }; });
  child.on('exit', code => { stopped = { code }; });
  try {
    await waitFor(() => endpoint || stopped, 25000, 'The isolated Rocketbrain window did not start.');
    assert.ifError(stopped?.error);
    assert.ok(endpoint, 'The isolated Rocketbrain window exited before rendering.');
    browser = await chromium.connectOverCDP(endpoint);
    page = await waitFor(async () => {
      for (const context of browser.contexts()) {
        for (const candidate of context.pages()) {
          if (await candidate.locator('.rb-workbench-header').count()) return candidate;
        }
      }
    }, 75000, 'The Rocketbrain workbench header did not render.');
    const readyPath = path.join(output, 'ready.json');
    await waitFor(() => fs.existsSync(readyPath), 75000, 'The bundled extension did not finish activating.');
    const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    assert.equal(fs.realpathSync(ready.executable).toLowerCase(), executable.toLowerCase());
    assert.equal(fs.realpathSync(ready.appRoot).toLowerCase(), path.join(installation, 'resources', 'app').toLowerCase());
    assert.equal(ready.command, true, 'The installed app did not register its desktop updater.');
    await page.locator('.rb-workbench-header button[aria-label="Check for Updates"]').click({ timeout: 10000 });

    const receipt = { installedVersion, storageScheme: ready.storageScheme, entryPoint: 'Rocketbrain header → Check for Updates' };
    if (!expectedVersion) {
      await page.getByText(`Rocketbrain Desktop ${installedVersion} is up to date on its release channel.`, { exact: true })
        .waitFor({ timeout: 40000 });
      assert.deepEqual(stagedFiles(), []);
      receipt.result = 'Already up to date';
    } else {
      await page.getByText(`Rocketbrain Desktop ${expectedVersion} is available on GitHub.`, { exact: false })
        .waitFor({ timeout: 40000 });
      assert.deepEqual(stagedFiles(), []);
      await page.getByRole('button', { name: 'Download Update', exact: true }).click();
      await page.getByText(`Quit Rocketbrain to install version ${expectedVersion}?`, { exact: true }).waitFor({ timeout: 300000 });
      const files = stagedFiles();
      assert.equal(files.length, 1);
      assert.equal(path.basename(files[0]), `RocketbrainDesktop-${expectedVersion}-win32-x64-setup.exe`);
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(files[0])) hash.update(chunk);
      receipt.stagedInstallerSha256 = hash.digest('hex');
      if (expectedInstallerSha256) assert.equal(receipt.stagedInstallerSha256, expectedInstallerSha256);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await waitFor(() => stagedFiles().length === 0, 10000, 'Cancel did not discard the staged installer.');
      assert.equal(JSON.parse(fs.readFileSync(path.join(installation, 'resources/app/product.json'), 'utf8')).rocketbrainDesktop.version,
        installedVersion);
      receipt.result = 'Staged and verified the real GitHub download, then cancelled installation';
      receipt.availableVersion = expectedVersion;
    }
    fs.writeFileSync(path.join(output, 'updater-native-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(`PASS ${path.join(output, 'updater-native-receipt.json')}`);
  } catch (error) {
    failed = true;
    await page?.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'quit'), '');
    try {
      if (!failed) {
        await waitFor(() => stopped, 12000, 'Isolated Rocketbrain did not exit normally.');
        assert.equal(stopped.code, 0);
      }
    } finally {
      if (!stopped) child.kill();
      await browser?.close().catch(() => {});
    }
  }
}

launch().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
