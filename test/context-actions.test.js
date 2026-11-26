'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerContextActions } = require('../src/context-actions');
const { registerKeyboardProfile } = require('../src/keyboard-profile-vscode');
const { registerFileStructure } = require('../src/java/file-structure-vscode');
const { MysqlService } = require('../src/db/mysql');
const { ResultsView } = require('../src/results');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { springJdbcClasspath, runJavaFixture } = require('./helpers/instance-inline-fixture');
const { createContextHarness, document, uri, point } = require('./helpers/context-actions-fixture');

const commandIds = plan => plan.actions.map(item => item.command);
const sqlCommand = 'rocketbrain.runQuery', structure = 'rocketbrain.java.fileStructure';
const resultsCommand = 'rocketbrain.contextActions.results', mainCommand = 'rocketbrain.contextActions';
const copy = 'rocketbrain.results.copyTsv', returnSource = 'rocketbrain.results.returnToQuery';
const root = path.join(os.tmpdir(), 'rocketbrain-context-tests');

function harness() {
  const host = createContextHarness(root);
  const state = { desiredResult: { view: 1, result: 5, revision: 8, copy: true, source: true },
    sql: { run: true, live: true, edit: true, epoch: 1 }, sourceRuntime: 'jdk', debug: undefined };
  const api = registerContextActions(host.vscode, host.context, {
    database: { resultActionContext: () => state.desiredResult, sqlActionContext: () => state.sql },
    java: { getState: () => ({ runtimeIdentity: state.sourceRuntime }), debug: { getState: () => state.debug } }
  });
  return { ...host, state, api };
}

test('Context Actions routes one native chord through distinct editor, results and workspace clauses', () => {
  const { contributes } = require('../package.json');
  const bindings = contributes.keybindings.filter(item => [mainCommand, resultsCommand].includes(item.command));
  assert.equal(bindings.length, 3);
  assert.ok(bindings.every(item => item.key === 'ctrl+k ctrl+shift+a' && item.mac === 'cmd+k cmd+shift+a'));
  assert.ok(bindings.some(item => item.command === resultsCommand && item.when.includes('focusedView == rocketbrain.results')));
  assert.ok(bindings.some(item => item.args?.surface === 'workspace' && item.when.includes('!editorTextFocus')));
  assert.ok(bindings.some(item => item.args?.surface === 'editor' && item.when.startsWith('editorTextFocus')));
  assert.ok(contributes.menus['view/title'].some(item => item.command === resultsCommand && item.when === 'view == rocketbrain.results'));
});

test('the active physical text tab, profile SQL, workspace and result view have different actions', async t => {
  const h = harness();
  t.after(() => h.api.dispose());
  h.show(document(uri(path.join(root, 'Fixture.java')), 'java'));
  let plan = await h.api.prepare('editor');
  assert.equal(plan.surface, 'jvm');
  assert.ok(commandIds(plan).includes(structure));
  assert.ok(commandIds(plan).includes('rocketbrain.spring.beans'));
  assert.ok(commandIds(plan).includes('rocketbrain.java.workbench.sourceTarget'));
  assert.ok(!commandIds(plan).includes(sqlCommand));
  h.otherTab();
  assert.equal((await h.api.prepare()).surface, 'workspace');
  assert.ok(!commandIds(await h.api.prepare()).includes(structure));
  h.show(document(uri(path.join(root, 'probe.sql'), 'rocketbrain-profile-sql'), 'sql'));
  plan = await h.api.prepare();
  assert.equal(plan.surface, 'sql');
  assert.ok(commandIds(plan).includes(sqlCommand));
  assert.ok(commandIds(plan).includes('rocketbrain.sql.explainVisual'));
  assert.ok(!commandIds(await h.api.prepare('workspace')).includes(sqlCommand));
  const results = await h.api.prepare('results');
  assert.deepEqual(commandIds(results).slice(0, 2), [returnSource, copy]);
  assert.ok(!commandIds(results).includes(sqlCommand));
  const focused = await h.api.dispatch(results, returnSource);
  assert.equal(focused.command, returnSource);
  assert.deepEqual(h.invoked.at(-1).args, [h.state.desiredResult]);
  await assert.rejects(h.api.dispatch(results, copy), /current Context Actions list/);
});

test('context selection is single use and rechecks connection, editor, registration, trust and result', async t => {
  const h = harness();
  t.after(() => h.api.dispose());
  const sql = document(uri(path.join(root, 'part.sql')), 'sql');
  h.show(sql);
  let plan = await h.api.prepare();
  await assert.rejects(h.api.dispatch({ ...plan }, sqlCommand), /current Context Actions list/);
  await assert.rejects(h.api.dispatch(plan, 'unrelated.extension.command'), /current Context Actions list/);
  sql.version++;
  await assert.rejects(h.api.dispatch(plan, sqlCommand), /editor, connection or result changed/);
  plan = await h.api.prepare();
  h.show(sql, point(3, 4));
  await assert.rejects(h.api.dispatch(plan, sqlCommand), /editor, connection or result changed/);
  plan = await h.api.prepare();
  h.state.sql = { ...h.state.sql, epoch: 2, binding: 'other-session' };
  await assert.rejects(h.api.dispatch(plan, sqlCommand), /editor, connection or result changed/);
  plan = await h.api.prepare();
  h.state.sql = { ...h.state.sql, session: { readOnly: false } };
  await assert.rejects(h.api.dispatch(plan, sqlCommand), /editor, connection or result changed/);
  plan = await h.api.prepare('results');
  h.state.desiredResult = { ...h.state.desiredResult, revision: 9 };
  await assert.rejects(h.api.dispatch(plan, copy), /editor, connection or result changed/);
  plan = await h.api.prepare();
  h.commands.delete(sqlCommand);
  await assert.rejects(h.api.dispatch(plan, sqlCommand), /action is no longer available/);
  plan = await h.api.prepare('workspace');
  h.vscode.workspace.isTrusted = false;
  await assert.rejects(h.api.dispatch(plan, 'rocketbrain.connectMysql'), /editor, connection or result changed/);
  assert.ok(!h.invoked.length);
  assert.ok(!commandIds(await h.api.prepare('workspace')).includes('rocketbrain.connectMysql'));
  assert.ok(!commandIds(await h.api.prepare('results')).includes(copy));
  h.state.desiredResult = null;
  await assert.rejects(h.api.prepare('results'), /Open the Query Results view/);
});

test('restricted SQL only offers execution in the local offline demo', async t => {
  const h = harness();
  t.after(() => h.api.dispose());
  h.vscode.workspace.isTrusted = false;
  h.show(document(uri(path.join(root, 'offline.sql')), 'sql'));
  assert.ok(!commandIds(await h.api.prepare()).includes(sqlCommand));
  h.state.sql = { run: true, edit: true, live: false, offlineDemo: true, epoch: 1 };
  assert.ok(commandIds(await h.api.prepare()).includes(sqlCommand));
  assert.ok(!commandIds(await h.api.prepare()).includes('rocketbrain.sql.explainVisual'));
});

test('native Quick Pick has descriptive options and routes a paused Java action only for its current stop', async t => {
  const h = harness();
  t.after(() => h.api.dispose());
  h.vscode.debug.activeDebugSession = { type: 'rocketbrain-java', id: 'paused' };
  h.state.debug = { state: 'stopped', stopVersion: 2, threadId: 8 };
  const step = 'rocketbrain.java.smartStepInto';
  h.answer((items, options) => {
    assert.equal(options.title, 'Context Actions · Workspace');
    assert.ok(items.some(row => row.label === 'Paused Java Debugger' && row.kind === -1));
    assert.equal(options.matchOnDetail, true);
    const selected = items.find(row => row.action === step);
    assert.match(selected.detail, /paused Java thread/);
    return selected;
  });
  assert.equal((await h.vscode.commands.executeCommand(mainCommand, { surface: 'workspace' })).command, step);
  const plan = await h.api.prepare('workspace');
  h.state.debug = { ...h.state.debug, state: 'running', stopVersion: 3 };
  await assert.rejects(h.api.dispatch(plan, step), /editor, connection or result changed/);
  assert.ok(!commandIds(await h.api.prepare('workspace')).includes(step));
  assert.equal(h.errors.length, 0);
});

test('result routing observes the active capture and does not copy draft or stale rows', async () => {
  const h = createContextHarness(root);
  const results = new ResultsView(h.vscode, h.context, {
    focusQueryEditor: caller => ({ focused: caller.uri }),
    canFocusQueryEditor: caller => !caller.closed
  });
  results.view = { visible: true, webview: { postMessage() {} } };
  results.viewReady = true;
  const back = { uri: 'file:///source.sql' };
  const id = results.begin('SELECT 42', 'fixture', { queryEditor: back });
  results.finish(id, { columns: ['answer'], rows: [[42]], rowCount: 1 });
  const snapshot = results.actionContext();
  assert.deepEqual([snapshot.result, snapshot.copy, snapshot.source], [id, true, true]);
  assert.deepEqual(await results.copyResult(results.requireActionTarget(snapshot)), { resultId: id });
  assert.deepEqual(h.clipboard, ['answer\n42']);
  results.editState(id, { hasDraft: true });
  await assert.rejects(results.copyResult(results.requireActionTarget(snapshot)), /discard drafts/);
  const other = results.begin('SELECT 43', 'fixture');
  results.finish(other, { columns: ['answer'], rows: [[43]], rowCount: 1 });
  assert.throws(() => results.requireActionTarget(snapshot), /current result changed/);
  await results.activateResult(id);
  back.closed = true;
  assert.equal(results.actionContext().source, false);
  results.view.visible = false;
  assert.equal(results.actionContext(), null);
});

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_CONTEXT_ACTIONS_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_CONTEXT_ACTIONS_' + engine.toUpperCase() + '_CONFIG']]);
const fixtureSource = [
  'package fixture.context;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class PaletteSpringProbe {',
  '    static int readAmount(JdbcTemplate jdbc) { return jdbc.queryForObject("SELECT 42", Integer.class); }',
  '    public static void main(String[] args) {',
  '        var data = new DriverManagerDataSource(System.getenv("RB_PALETTE_JDBC_URL"),',
  '            System.getenv("RB_PALETTE_JDBC_USER"), System.getenv("RB_PALETTE_JDBC_PASSWORD"));',
  '        var jdbc = new JdbcTemplate(data);',
  '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + readAmount(jdbc));',
  '    }',
  '}', ''
].join('\n');

test('Context Actions opens a JDT declaration and routes live Spring JDBC results through its owning SQL editor', {
  skip: !runtimeFile || !classpathFile || !engines.every(([, config]) => config), timeout: 240000
}, async t => {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-context-actions-'));
  const project = path.join(owned, 'project');
  const source = path.join(project, 'src/main/java/fixture/context/PaletteSpringProbe.java');
  const { javaHome, serverPath } = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const dependencies = await springJdbcClasspath(classpathFile, 'mysql');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.join(project, 'bin'));
  const escape = value => value.replaceAll('\\', '/').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  await Promise.all([
    fs.writeFile(source, fixtureSource, { flag: 'wx' }),
    fs.writeFile(path.join(project, '.project'), '<projectDescription><name>palette-probe</name><natures>' +
      '<nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' }),
    fs.writeFile(path.join(project, '.classpath'), '<classpath><classpathentry kind="src" path="src/main/java"/>' +
      '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>' +
      dependencies.map(file => '<classpathentry kind="lib" path="' + escape(file) + '"/>').join('') +
      '<classpathentry kind="output" path="bin"/></classpath>', { flag: 'wx' })
  ]);
  const lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, storagePath: path.join(owned, 'jdt') }));
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const rootUri = pathToFileURL(project).href;
  const h = createContextHarness(project);
  h.vscode.extensions = { all: [h.context.extension] };
  const keyboard = registerKeyboardProfile(h.vscode);
  const keyboardRoute = async command => {
    const rule = (await keyboard.inspect({platform: 'win32'})).routes.find(value => value.command === command);
    assert.equal(rule?.available, true, command);
    return rule.command;
  };
  const java = { getState: () => ({ runtimeIdentity: 'owned-jdt' }), debug: { getState() {} }, async start() { return { state: 'running' }; } };
  const file = document(uri(source), 'java', fixtureSource);
  const symbols = () => lsp.request('textDocument/documentSymbol', { textDocument: { uri: file.uri.toString() } });
  const structureService = registerFileStructure(h.vscode, { java, readJava: symbols, output: { appendLine() {} } });
  const openDocuments = new Map();
  const results = new ResultsView(h.vscode, h.context, {
    focusQueryEditor: target => h.vscode.window.showTextDocument(openDocuments.get(target.uri)),
    canFocusQueryEditor: target => openDocuments.has(target.uri)
  });
  results.view = { visible: true, webview: { postMessage() {} } };
  results.viewReady = true;
  let epoch = 0;
  const api = registerContextActions(h.vscode, h.context, { java, database: {
    sqlActionContext: () => ({ live: true, run: true, edit: true, epoch }),
    resultActionContext: () => results.actionContext()
  } });
  t.after(async () => {
    keyboard.dispose();
    api.dispose();
    structureService.dispose();
    await lsp.close();
    const real = await fs.realpath(owned);
    assert.equal(path.relative(owned, real), '');
    assert.equal(path.relative(path.dirname(real), parent), '');
    assert.match(path.basename(real), /^rb-context-actions-/u);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'context actions' }],
    capabilities: { workspace: { configuration: true }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { workspaceFolders: [rootUri], settings } }, 75000);
  lsp.notify('initialized', {});
  lsp.notify('workspace/didChangeConfiguration', { settings });
  lsp.notify('textDocument/didOpen', { textDocument: { uri: file.uri.toString(), languageId: 'java', version: file.version, text: fixtureSource } });
  await until(async () => (await symbols())?.length, 90000);
  h.show(file);
  h.answer((items, options) => {
    if (options.title.startsWith('Context Actions')) return items.find(item => item.action === structure);
    if (options.title === 'File Structure') return items.find(item => item.group === 'all');
    return items.find(item => item.member?.label.startsWith('readAmount('));
  });
  const navigate = await h.vscode.commands.executeCommand(mainCommand, { surface: 'editor' });
  assert.equal(navigate.command, structure);
  assert.ok(navigate.result.members.some(item => item.label.startsWith('readAmount(')));
  const declaration = h.vscode.window.activeTextEditor.selection.active;
  assert.equal(declaration.line, 4);
  assert.equal(h.errors.length, 0);
  h.show(file);
  await h.vscode.commands.executeCommand(await keyboardRoute(structure));
  assert.equal(h.vscode.window.activeTextEditor.selection.active.line, declaration.line);

  const reports = [];
  h.vscode.commands.registerCommand(copy, target => results.copyResult(results.requireActionTarget(target)));
  h.vscode.commands.registerCommand(returnSource, target => results.returnToQuery(results.requireActionTarget(target).id));
  h.vscode.commands.registerCommand('rocketbrain.focusQueryEditor', () => results.returnToQuery());
  for (const [engine, configFile] of engines) {
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    const spring = await runJavaFixture({ javaHome, file: source, binaryDirectory: await fs.mkdtemp(path.join(owned, 'classes-')),
      className: 'fixture.context.PaletteSpringProbe', config, engine, jdbcPrefix: 'RB_PALETTE',
      classpath: await springJdbcClasspath(classpathFile, engine) });
    assert.equal(spring.output, '42');
    epoch++;
    const sql = 'SELECT 42 AS amount, VERSION() AS server';
    const documentUri = uri(path.join(project, engine + '.sql'), 'untitled');
    const editor = document(documentUri, 'sql', sql);
    openDocuments.set(documentUri.toString(), editor);
    h.show(editor);
    const db = new MysqlService(config);
    try {
      h.vscode.commands.registerCommand(sqlCommand, async () => {
        const active = h.vscode.window.activeTextEditor.document;
        const text = active.getText();
        const id = results.begin(text, engine, { queryEditor: { uri: active.uri.toString() } });
        results.finish(id, await db.query(text, { maxRows: 3, timeoutMs: 8000 }));
        return id;
      });
      const sqlPlan = await api.prepare('editor');
      assert.ok(commandIds(sqlPlan).includes('rocketbrain.sql.explainVisual'));
      const ran = await api.dispatch(sqlPlan, sqlCommand);
      const table = results.history.find(item => item.id === ran.result);
      assert.equal(table.result.rows.length, 1);
      assert.deepEqual(table.result.rows[0].map(String), ['42', spring.server]);
      const resultPlan = await api.prepare('results');
      assert.deepEqual(commandIds(resultPlan).slice(0, 2), [returnSource, copy]);
      const copied = await api.dispatch(resultPlan, copy);
      assert.equal(copied.result.resultId, table.id);
      assert.equal(h.clipboard.at(-1), 'amount\tserver\n42\t' + spring.server);
      h.show(file);
      await api.dispatch(await api.prepare('results'), returnSource);
      assert.equal(h.vscode.window.activeTextEditor.document, editor);
      const keyboardId = await h.vscode.commands.executeCommand(await keyboardRoute(sqlCommand));
      assert.deepEqual(results.history.find(item => item.id === keyboardId).result.rows[0].map(String), ['42', spring.server]);
      h.show(file);
      await h.vscode.commands.executeCommand(await keyboardRoute('rocketbrain.focusQueryEditor'));
      assert.equal(h.vscode.window.activeTextEditor.document, editor);
      reports.push({ engine, server: spring.server, jdbcValue: Number(spring.output), liveRows: table.result.rows.length,
        selectedCaptureCopied: true, restoredOwningSqlEditor: true, keyboardRoutesRestoredOwningSqlEditor: true });
    } finally {
      await db.dispose();
    }
  }
  if (process.env.ROCKETBRAIN_CONTEXT_ACTIONS_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_CONTEXT_ACTIONS_RECEIPT, JSON.stringify({ reports, jdt: path.basename(serverPath),
      navigatedMember: 'readAmount', sourceLine: declaration.line + 1,
      keyboardJavaDeclarationNavigation: true, realVsCodeWindow: false }, null, 2) + '\n', { flag: 'wx' });
  }
});
