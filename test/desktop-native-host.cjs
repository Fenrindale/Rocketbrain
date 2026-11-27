'use strict';

// Accept the executable from an isolated desktop installation, never a running user window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { browserRuntime } = require('./helpers/browser-runtime');
const { startFixture } = require('../scripts/integration-db');
const { startMysqlFixture } = require('../scripts/integration-mysql');
const { resolveDebugBundle } = require('../src/java/debug-runtime');
const mysql = require('mysql2/promise');

const [executable, outputParent, engine = 'mariadb'] = process.argv.slice(2);
const databaseOnly = process.env.RB_DESKTOP_SMOKE_DB_ONLY === '1';
assert.ok(executable && outputParent && ['mariadb', 'mysql'].includes(engine),
  'Usage: node test/desktop-native-host.cjs <installed Rocketbrain.exe> <output directory> [mariadb|mysql]');
const exe = fs.realpathSync(executable);
assert.equal(path.basename(exe).toLowerCase(), 'rocketbrain.exe');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(outputParent, { recursive: true });
const output = fs.mkdtempSync(path.join(fs.realpathSync(outputParent), 'installed-'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const executableSha256 = sha256(exe);
const steps = [];
const step = (action, result) => {
  steps.push({ action, result });
  fs.writeFileSync(path.join(output, 'completed-steps.json'), JSON.stringify(steps, null, 2));
};

async function waitFor(action, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const result = await action();
    if (result) return result;
    if (Date.now() >= deadline) throw Error(message);
    await delay(100);
  }
}

function createInstalledRun(db) {
  const { chromium } = browserRuntime();
  assert.ok(chromium, 'A local Playwright/Chromium runtime is required.');
  const app = path.join(path.dirname(exe), 'resources', 'app');
  const builtIns = path.join(app, 'extensions');
  const bundled = fs.readdirSync(builtIns).flatMap(name => {
    const file = path.join(builtIns, name, 'package.json');
    return fs.existsSync(file) ? [{ name, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }] : [];
  }).find(({ manifest }) => manifest.publisher + '.' + manifest.name === 'rocketbrain-local.rocketbrain');
  assert.ok(bundled, 'No built-in Rocketbrain extension manifest was found.');
  const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'));
  assert.equal(product.nameShort, 'Rocketbrain');
  assert.equal(product.rocketbrainDesktop.extensionVersion, bundled.manifest.version);
  const hashes = {
    installedWorkbenchSha256: sha256(path.join(app, 'out/vs/workbench/workbench.desktop.main.js')),
    installedExtensionSha256: sha256(path.join(builtIns, bundled.name, 'dist/extension.js'))
  };

  const profile = path.join(output, 'profile');
  const user = path.join(profile, 'User');
  const extensions = path.join(output, 'extensions');
  const driver = path.join(output, 'driver');
  const project = path.join(output, 'maven');
  for (const folder of [user, extensions, driver]) fs.mkdirSync(folder, { recursive: true });
  fs.cpSync(path.join(root, 'test/fixtures/java/maven'), project,
    { recursive: true, filter: file => !file.endsWith(path.sep + 'target') });
  const settings = {
    'rocketbrain.java.enabled': !databaseOnly,
    'editor.multiCursorModifier': 'alt',
    'workbench.startupEditor': 'none',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'git.autofetch': false,
    'security.workspace.trust.enabled': false,
    'http.proxy': 'http://127.0.0.1:9',
    'http.proxySupport': 'override'
  };
  if (!databaseOnly) {
    const javaHome = fs.realpathSync(process.env.RB_DESKTOP_JAVA_HOME ||
      path.join(root, 'research/implementation/runtimes/temurin25/extracted/jdk-25.0.5+8'));
    const serverPath = fs.realpathSync(process.env.RB_DESKTOP_JDTLS ||
      path.join(root, 'test-output/java-runtime/jdtls-1.63.0'));
    const debugBundle = resolveDebugBundle(process.env.RB_DESKTOP_JAVA_DEBUG_BUNDLE, serverPath);
    assert.ok(debugBundle, 'The pinned Java debug bundle must be available for the launch test.');
    Object.assign(settings, {
      'rocketbrain.java.javaHome': javaHome,
      'rocketbrain.java.serverPath': serverPath,
      'rocketbrain.java.debugBundlePath': debugBundle.path,
    });
  }
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
    publisher: 'rocketbrain-smoke', name: 'desktop-native-driver', version: '1.0.0',
    engines: { vscode: '^1.100.0' }, main: './driver.cjs',
    activationEvents: ['onStartupFinished'], extensionDependencies: ['rocketbrain-local.rocketbrain']
  }));
  fs.copyFileSync(path.join(__dirname, 'desktop-native-driver.cjs'), path.join(driver, 'driver.cjs'));
  const configPath = path.join(output, 'db-connection.json');
  fs.writeFileSync(configPath, JSON.stringify(db.config), { flag: 'wx', mode: 0o600 });

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('ROCKETBRAIN_') && key !== 'ELECTRON_RUN_AS_NODE'));
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) env[key] = 'http://127.0.0.1:9';
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.RB_DESKTOP_SMOKE_ROOT = output;
  const owned = ['shared-data-dir', 'agents-user-data-dir', 'agents-extensions-dir', 'agent-plugins-dir',
    'extensions-download-dir'].map(name => '--' + name + '=' + path.join(output, name));
  const child = spawn(exe, [project, '--new-window', '--user-data-dir=' + profile, '--extensions-dir=' + extensions,
    ...owned, '--extensionDevelopmentPath=' + driver, '--disable-workspace-trust', '--skip-welcome',
    '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--disable-gpu',
    '--proxy-server=http://127.0.0.1:9', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  { windowsHide: true, env });
  return { child, chromium, configPath, extensions, manifest: bundled.manifest, product, hashes };
}

const titlebar = page => page.locator('[id="workbench.parts.titlebar"] .rb-workbench-header');
const sidebar = page => page.locator('[id="workbench.parts.sidebar"]');
const secondarySidebar = page => page.locator('[id="workbench.parts.auxiliarybar"]');
const dock = page => page.locator('[id="workbench.parts.statusbar"] .rb-workbench-dock:visible');
const panel = page => page.locator('[id="workbench.parts.panel"]');
const editor = page => page.locator('[id="workbench.parts.editor"]');
const lines = page => editor(page).locator('.monaco-editor .view-lines .view-line');
const header = (page, name) => sidebar(page).locator('.pane-header').getByText(name, { exact: true });
const action = (element, name) => element.locator('[aria-label]').filter({ visible: true })
  .and(element.locator(`[aria-label="${name}" i], [aria-label^="${name} (" i]`)).first();
const readyFile = name => path.join(output, name + '.json');
const recorded = async name => waitFor(() => {
  if (fs.existsSync(readyFile('driver-error'))) throw Error(JSON.parse(fs.readFileSync(readyFile('driver-error'), 'utf8')).message);
  if (fs.existsSync(readyFile(name))) return JSON.parse(fs.readFileSync(readyFile(name), 'utf8'));
}, 22000, `Did not observe ${name} from the installed app.`);

async function assertResultsBelowEditor(page) {
  await panel(page).getByText('Query Results', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  const [panelBounds, editorBounds] = await Promise.all([panel(page).boundingBox(), editor(page).boundingBox()]);
  assert.ok(panelBounds && editorBounds && panelBounds.y >= editorBounds.y + editorBounds.height - 3,
    'Query Results is not in the bottom workbench panel.');
}

async function assertSideLayout(page, secondaryName) {
  await secondarySidebar(page).getByText(secondaryName, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  const [primary, center, secondary] = await Promise.all([sidebar(page).boundingBox(), editor(page).boundingBox(), secondarySidebar(page).boundingBox()]);
  assert.ok(primary && center && secondary && primary.x + primary.width <= center.x + 3 && center.x + center.width <= secondary.x + 3,
    'The Rocketbrain tools are not positioned around the editor in left and right docks.');
}

async function selectRunConfiguration(page) {
  const picker = page.locator('.quick-input-widget');
  await picker.getByText('Desktop smoke · Java App', { exact: true }).first().click({ timeout: 10000 });
}

async function invocationPoint(page) {
  return lines(page).filter({ hasText: 'greeter.greet' }).evaluate(line => {
    let offset = line.textContent.indexOf('greeter.greet') + 'greeter.gr'.length;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset < node.textContent.length) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rectangle = range.getBoundingClientRect();
        return { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
      }
      offset -= node.textContent.length;
    }
    throw Error('Java invocation was not rendered in the active editor.');
  });
}

async function exerciseJava(page) {
  const top = titlebar(page);
  await action(top, 'Java Mode').click({ timeout: 12000 });
  await header(page, 'Java Projects').waitFor({ state: 'visible', timeout: 10000 });
  await assertSideLayout(page, 'Outline');
  step('Window toolbar → Java Mode', 'Java Projects docked left and Structure docked right around the editor');
  const point = await invocationPoint(page);
  await page.keyboard.down('Control');
  try {
    await page.mouse.move(point.x, point.y);
    await delay(650);
    await page.mouse.click(point.x, point.y);
  } finally {
    await page.keyboard.up('Control');
  }
  await page.locator('.tabs-container .tab.active').filter({ hasText: /^Greeter\.java$/ })
    .waitFor({ state: 'visible', timeout: 10000 });
  step('Java editor → Ctrl+Click', 'Greeter.java declaration opened from App.java');
  await page.screenshot({ path: path.join(output, 'desktop-java-structure.png') });
  await page.getByRole('tab', { name: /App\.java/ }).click({ timeout: 8000 });
  await action(top, 'Run Java').click({ timeout: 10000 });
  await selectRunConfiguration(page);
  assert.equal((await recorded('run-output')).greeting, true);
  assert.equal((await recorded('run-ended')).terminated, true);
  await panel(page).getByText('Debug Console', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  step('Window toolbar → Run Java', 'Fixture JVM printed its greeting and exited with console docked below the editor');

  await action(top, 'Debug Java').click({ timeout: 10000 });
  await selectRunConfiguration(page);
  assert.equal((await recorded('debug-stopped')).reason, 'breakpoint');
  await panel(page).getByText('Run and Debug', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.keyboard.press('F5');
  assert.equal((await recorded('debug-ended')).terminated, true);
  step('Window toolbar → Debug Java', 'Owned Java debug session stopped at breakpoint, resumed and exited');
}

async function gridFor(page, contents) {
  return waitFor(async () => {
    for (const frame of page.frames()) {
      if (!frame.url().startsWith('vscode-webview://')) continue;
      const grid = frame.locator('#grid');
      if (await grid.isVisible().catch(() => false) && (await grid.textContent().catch(() => '') || '').includes(contents)) return frame;
    }
  }, 16000, `Query Results did not display the owned marker ${contents}.`);
}

const readValue = async config => {
  const connection = await mysql.createConnection(config);
  try {
    const [rows] = await connection.query('SELECT id, value_text FROM transaction_probe ORDER BY id');
    assert.deepEqual(rows.map(row => row.id), [1, 2]);
    assert.equal(rows[1].value_text, 'second');
    return rows[0].value_text;
  } finally {
    await connection.end();
  }
};

async function exerciseDatabase(page, config) {
  const top = titlebar(page);
  await action(top, 'Database Mode').click({ timeout: 12000 });
  await header(page, 'Database').waitFor({ state: 'visible', timeout: 10000 });
  await assertSideLayout(page, 'Explorer');
  await assertResultsBelowEditor(page);
  step('Window toolbar → Database Mode', 'Database Explorer left, Files right, and Query Results below the editor');

  await action(top, 'Open SQL Console').click({ timeout: 10000 });
  await lines(page).filter({ hasText: /SELECT/i }).last().click({ timeout: 10000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('SELECT 31807 AS desktop_native_probe;\n-- owned SQL query');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Enter');
  await gridFor(page, '31807');
  await assertResultsBelowEditor(page);
  step('SQL console → Ctrl+Enter', 'Observed marker 31807 in the bottom panel after the statement terminator');

  await action(dock(page), 'Database Explorer').click({ timeout: 10000 });
  const tree = header(page, 'Database').locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " pane ")][1]');
  const preview = tree.getByText('transaction_probe', { exact: true }).first();
  if (!await preview.count()) {
    await tree.locator('.monaco-list-rows').first().hover();
    await page.mouse.wheel(0, 260);
  }
  await preview.hover({ timeout: 10000 });
  const row = preview.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " monaco-list-row ")][1]');
  await action(row, 'Preview Table').click({ timeout: 10000 });
  const frame = await gridFor(page, 'original');
  await frame.getByRole('button', { name: 'Enable Editing', exact: true }).click();
  await frame.locator('#edit-status').filter({ hasText: /Editing enabled/ }).waitFor({ timeout: 12000 });
  const cell = frame.locator('#grid').getByRole('button', { name: /Edit row .* column value_text/i }).filter({ hasText: /^original$/ });
  await cell.click({ timeout: 10000 });
  await frame.getByRole('button', { name: 'Edit Cell', exact: true }).click();
  const newValue = 'desktop-installed-commit';
  await frame.locator('#cell-value').fill(newValue);
  await frame.getByRole('button', { name: 'Stage Cell', exact: true }).click();
  assert.equal(await readValue(config), 'original');
  await frame.getByRole('button', { name: 'Review SQL', exact: true }).click();
  await frame.locator('#review-sql').filter({ hasText: /UPDATE .*transaction_probe/ }).waitFor({ timeout: 10000 });
  assert.match(await frame.locator('#review-sql').textContent(), new RegExp(newValue));
  await frame.getByRole('button', { name: 'Apply Reviewed Changes', exact: true }).click();
  await frame.locator('#edit-status').filter({ hasText: /Changes applied in this session/ }).waitFor({ timeout: 10000 });
  assert.equal(await readValue(config), 'original');
  await frame.getByRole('button', { name: 'Commit', exact: true }).click();
  await frame.locator('#edit-status').filter({ hasText: /Transaction committed/ }).waitFor({ timeout: 10000 });
  await gridFor(page, newValue);
  assert.equal(await readValue(config), newValue);
  step('Database Explorer → bottom result grid edit', 'Staged cell, reviewed UPDATE, applied, committed and read back by separate SQL client');
}

async function run(db) {
  const { child, chromium, configPath, extensions, manifest, product, hashes } = createInstalledRun(db);
  let endpoint, browser, page, stopped, failure, tail = '';
  const capture = data => {
    tail = (tail + data.toString()).slice(-16000);
    endpoint ||= tail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\da-f-]+)/i)?.[1];
  };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', capture);
  child.on('error', error => { stopped = { error }; });
  child.on('exit', code => { stopped = { code }; });
  try {
    await waitFor(() => endpoint || stopped, 25000, 'The isolated desktop did not start a local DevTools connection.');
    if (stopped) throw Error('The installed desktop aborted startup.', { cause: stopped.error });
    browser = await chromium.connectOverCDP(endpoint);
    page = await waitFor(async () => {
      for (const context of browser.contexts()) for (const candidate of context.pages()) {
        if (await titlebar(candidate).count()) return candidate;
      }
    }, 16000, 'The desktop Workbench window did not render.');
    const ready = await waitFor(() => {
      if (fs.existsSync(readyFile('driver-error'))) throw Error(JSON.parse(fs.readFileSync(readyFile('driver-error'), 'utf8')).message);
      if (fs.existsSync(readyFile('ready'))) return JSON.parse(fs.readFileSync(readyFile('ready'), 'utf8'));
    }, 100000, 'The bundled extension did not activate on the owned fixture.');
    assert.equal(ready.bundled, true);
    assert.equal(ready.extension, manifest.version);
    assert.deepEqual(fs.readdirSync(extensions).filter(name => name.startsWith('rocketbrain-local.rocketbrain')), []);
    if (!databaseOnly) await exerciseJava(page);
    await exerciseDatabase(page, db.config);
    await page.screenshot({ path: path.join(output, 'desktop-db-after-commit.png') });
    await action(titlebar(page), 'Java Mode').click({ timeout: 12000 });
    await header(page, 'Java Projects').waitFor({ state: 'visible', timeout: 10000 });
    await assertSideLayout(page, 'Outline');
    await panel(page).waitFor({ state: 'hidden', timeout: 10000 });
    step('Window toolbar → return to Java Mode', 'Java docks restored and database results dock closed');
    return { executableSha256, ...hashes, product: product.nameShort, core: ready.vscode,
      build: product.rocketbrainDesktop.version, codeOssCommit: product.rocketbrainDesktop.codeOssCommit,
      extension: ready.extension, bundledVsixSha256: product.rocketbrainDesktop.extensionVsixSha256,
      builtInExtension: ready.bundled, database: db.server.version,
      scope: databaseOnly ? 'database' : 'java-and-database', steps };
  } catch (error) {
    failure = error;
    if (page) {
      await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
      fs.writeFileSync(path.join(output, 'failed.json'), JSON.stringify({ message: error.message, steps }));
    }
    throw error;
  } finally {
    fs.unlinkSync(configPath);
    fs.writeFileSync(path.join(output, 'quit'), '');
    try {
      if (!failure) {
        await waitFor(() => stopped, 12000, 'The installed desktop did not quit cleanly.');
        assert.equal(stopped.code, 0);
      }
    } finally {
      if (!stopped) child.kill();
      await browser?.close().catch(() => {});
    }
  }
}

async function main() {
  console.log('Owned desktop smoke output: ' + output);
  const db = await (engine === 'mysql' ? startMysqlFixture() : startFixture());
  let result;
  try { result = await run(db); }
  finally { await db.stop(); }
  const evidence = path.join(output, 'desktop-native-receipt.json');
  fs.writeFileSync(evidence, JSON.stringify({ ...result, ownedFixtureStopped: true }, null, 2), { flag: 'wx' });
  console.log('PASS ' + evidence);
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
