'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { browserRuntime } = require('./helpers/browser-runtime');

const [executable, evidenceDir, existingJdk] = process.argv.slice(2);
assert.ok(executable && evidenceDir && existingJdk,
  'Usage: node test/desktop-java-setup.cjs <installed Rocketbrain.exe> <evidence directory> <JDK 25 directory>');
const exe = fs.realpathSync(executable);
assert.equal(path.basename(exe).toLowerCase(), 'rocketbrain.exe');
const javaHome = fs.realpathSync(existingJdk);
const { chromium } = browserRuntime();
assert.ok(chromium, 'Playwright is required.');

fs.mkdirSync(evidenceDir, { recursive: true });
const root = fs.mkdtempSync(path.join(fs.realpathSync(evidenceDir), 'java-first-run-'));
const profile = path.join(root, 'profile');
const user = path.join(profile, 'User');
const extensions = path.join(root, 'extensions');
const project = path.join(root, 'maven');
const driver = path.join(root, 'driver');
for (const directory of [user, extensions, driver]) fs.mkdirSync(directory, { recursive: true });
fs.cpSync(path.join(__dirname, 'fixtures/java/maven'), project, {
  recursive: true, filter: file => !file.endsWith(path.sep + 'target')
});
const settingsFile = path.join(user, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
  'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off'
}));
fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
  publisher: 'rocketbrain-smoke', name: 'java-first-run', version: '1.0.0', engines: { vscode: '^1.100.0' },
  main: './driver.cjs', activationEvents: ['onStartupFinished'], extensionDependencies: ['rocketbrain-local.rocketbrain']
}));
fs.copyFileSync(path.join(__dirname, 'desktop-java-setup-driver.cjs'), path.join(driver, 'driver.cjs'));

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !['JDK_HOME', 'JAVA_HOME', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())));
Object.assign(env, { JAVA_HOME: javaHome, RB_JAVA_SETUP_SMOKE_ROOT: root });
const owned = ['shared-data-dir', 'agents-user-data-dir', 'agents-extensions-dir', 'agent-plugins-dir', 'extensions-download-dir']
  .map(name => `--${name}=${path.join(root, name)}`);
const toolbar = page => page.locator('[id="workbench.parts.titlebar"]');
const action = (page, name) => toolbar(page).locator(`[aria-label="${name}"], [aria-label^="${name} ("]`).first();
const heading = frame => frame.getByRole('heading', { name: 'Java Setup', exact: true });
const database = page => page.locator('[id="workbench.parts.sidebar"] .pane-header').getByText('Database', { exact: true });

async function waitFor(action, timeout, message) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await action();
    if (result) return result;
    if (Date.now() >= deadline) throw Error(message);
    await delay(125);
  }
}

async function run(phase, exercise) {
  const child = spawn(exe, [project, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, ...owned,
    `--extensionDevelopmentPath=${driver}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-updates', '--disable-telemetry', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  { windowsHide: true, env: { ...env, RB_JAVA_SETUP_SMOKE_PHASE: phase } });
  let endpoint, exit, browser, page, failure, tail = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    tail = (tail + data.toString()).slice(-12000);
    endpoint ||= tail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\da-f-]+)/i)?.[1];
  });
  child.on('error', error => { exit = { error }; });
  child.on('exit', code => { exit = { code }; });
  const phaseFile = name => path.join(root, `${phase}-${name}.json`);
  const recorded = (name, timeout = 100000) => waitFor(() => {
    if (fs.existsSync(phaseFile('error'))) throw Error(JSON.parse(fs.readFileSync(phaseFile('error'), 'utf8')).message);
    if (fs.existsSync(phaseFile(name))) return JSON.parse(fs.readFileSync(phaseFile(name), 'utf8'));
  }, timeout, `Java setup accepted no ${name} record for ${phase}.`);
  try {
    await waitFor(() => endpoint || exit, 90000, 'Installed app did not launch DevTools on loopback.');
    if (exit) throw Error('Installed app exited during startup.', { cause: exit.error });
    browser = await chromium.connectOverCDP(endpoint);
    page = await waitFor(async () => {
      for (const context of browser.contexts()) for (const view of context.pages()) {
        if (await toolbar(view).count()) return view;
      }
    }, 90000, 'Rocketbrain workbench did not appear.');
    const activation = await recorded('activated');
    assert.equal(activation.product, 'Rocketbrain');
    return await exercise(page, recorded, phaseFile, activation);
  } catch (error) {
    failure = error;
    fs.writeFileSync(path.join(root, `${phase}-failure.log`), tail);
    await page?.screenshot({ path: path.join(root, `${phase}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(phaseFile('quit'), '');
    try {
      if (!failure) {
        await waitFor(() => exit, 18000, 'The isolated desktop did not quit cleanly.');
        assert.equal(exit.code, 0);
      }
    } finally {
      if (!exit) child.kill();
      await browser?.close().catch(() => {});
    }
  }
}

async function verifyReady(recorded) {
  const { state, definition } = await recorded('ready', 190000);
  assert.equal(state.ready, true);
  assert.equal(state.javaHome, javaHome);
  assert.equal(definition, true);
  return state;
}

async function firstRun(page, recorded, _phaseFile, activation) {
  assert.equal(fs.readFileSync(settingsFile, 'utf8').includes('rocketbrain.java.'), false);
  const setup = await waitFor(async () => {
    for (const frame of page.frames()) if (await heading(frame).isVisible()) return frame;
  }, 25000, 'Java Setup did not open automatically for the unconfigured Maven project.');
  await setup.locator('#status').filter({ hasText: 'Java setup required' }).waitFor({ timeout: 15000 });
  const detected = await setup.locator('#java-home').textContent();
  assert.ok(detected.includes(javaHome));
  assert.match(detected, /^JDK 25/);
  await page.screenshot({ path: path.join(root, 'first-run-setup.png') });
  await setup.getByRole('button', { name: 'Download Java Engine', exact: true }).click({ timeout: 8000 });
  await setup.locator('#status').filter({ hasText: 'Installing Java Engine' }).waitFor({ timeout: 10000 });
  const state = await verifyReady(recorded);
  await setup.locator('#status').filter({ hasText: 'Java is ready' }).waitFor({ timeout: 12000 });
  await page.screenshot({ path: path.join(root, 'first-run-ready.png') });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings['rocketbrain.java.javaHome'], javaHome);
  assert.equal(settings['rocketbrain.java.serverPath'], state.serverPath);
  assert.equal(settings['rocketbrain.java.debugBundlePath'], state.debugBundlePath);
  assert.ok(state.debugBundlePath.startsWith(root + path.sep));
  await action(page, 'Database Mode').click({ timeout: 10000 });
  await database(page).waitFor({ timeout: 12000 });
  return { ...activation, detected, serverPath: state.serverPath, debugBundlePath: state.debugBundlePath, definition: true };
}

async function reopen(page, recorded, phaseFile) {
  await database(page).waitFor({ timeout: 18000 });
  await delay(2000);
  fs.writeFileSync(phaseFile('sample'), '');
  assert.equal((await recorded('database-state')).state, 'stopped');
  await action(page, 'Java Mode').click({ timeout: 10000 });
  await verifyReady(recorded);
  await action(page, 'Java Setup').click({ timeout: 10000 });
  const setup = await waitFor(async () => {
    for (const frame of page.frames()) if (await heading(frame).isVisible()) return frame;
  }, 15000, 'Java Setup toolbar button did not reopen the setup editor.');
  await setup.locator('#status').filter({ hasText: 'Java is ready' }).waitFor({ timeout: 10000 });
  return { didNotStartInDatabaseMode: true, automaticStartOnJavaMode: true, setupToolbarReopens: true };
}

async function main() {
  console.log(`Isolated Java setup evidence directory ${root}`);
  const first = await run('first', firstRun);
  const restarted = await run('reopened', reopen);
  const receipt = path.join(root, 'desktop-java-setup-receipt.json');
  const executableSha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(receipt, JSON.stringify({ executableSha256, first, restarted }, null, 2), { flag: 'wx' });
  console.log(`PASS ${receipt}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
