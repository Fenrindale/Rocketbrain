'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { owned } = require('./schema-stored-diff-host');
const { until } = require('./helpers/stdio-lsp');

const run = promisify(execFile);

async function withSearchGitFixture(workspace, baseline, action) {
  const parent = await fs.realpath(workspace);
  assert.equal(parent, await fs.realpath(baseline));
  assert.ok(parent.split(path.sep).includes('test-output') || parent === await fs.realpath(os.tmpdir()));
  const repository = await fs.mkdtemp(path.join(parent, 'rb-search-git-'));
  const id = randomBytes(5).toString('hex');
  const marker = path.join(repository, '.fixture-owner');
  await fs.writeFile(marker, id, { flag: 'wx' });
  const filename = `RBFinder${id}.txt`, subject = `RBFinder${id} original commit`, branch = `rb-${id}-search`;
  const file = path.join(repository, filename);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const platform = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  const git = async (...args) => (await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...platform, ...args], {
    cwd: repository, env, windowsHide: true, encoding: 'utf8', timeout: 10000
  })).stdout.trim();
  try {
    await git('init', '-q', '--template=', '--initial-branch=main');
    await fs.writeFile(file, 'original fixture\n', { flag: 'wx' });
    await git('add', '--', filename);
    await git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Rocketbrain Fixture',
      '-c', 'commit.gpgSign=false', 'commit', '-qm', subject);
    await git('branch', '--', branch);
    const hash = await git('rev-parse', 'HEAD');
    const index = path.join(repository, '.git', 'index');
    const fingerprint = async () => createHash('sha256').update(await fs.readFile(index)).digest('hex');
    const previous = await fingerprint();
    const details = await action({ repository, file, filename, subject, branch, hash, term: `RBFinder${id}` });
    assert.equal(await git('rev-parse', 'HEAD'), hash);
    assert.equal(await git('branch', '--show-current'), 'main');
    assert.equal(await fingerprint(), previous);
    return details;
  } finally {
    assert.equal(path.dirname(await fs.realpath(repository)), parent);
    assert.equal(await fs.readFile(marker, 'utf8'), id);
    await fs.rm(repository, { recursive: true });
  }
}

async function runSearchEverywhereChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.equal(await fs.realpath(workspace), await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const table = 'rb_find_' + randomBytes(5).toString('hex');
  const opened = new Set();
  const remember = item => {
    const uri = item.uri ?? item.documentUri;
    if (uri) opened.add(uri);
  };
  async function cleanTabs() {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => opened.has(tab.input?.uri?.toString()));
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }
  const navigation = api.navigation;
  try {
    await importedSpring(api, workspace);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.searchEverywhere'));
    const javaFile = path.join(workspace, 'src/main/java/fixture/boot/FixtureApplication.java');
    await vscode.workspace.openTextDocument(vscode.Uri.file(javaFile));
    const symbols = await until(async () => await navigation.search('# FixtureApplication').then(items =>
      items.find(item => item.type === 'symbol' && item.label === 'FixtureApplication' && item.uri.fsPath.endsWith('FixtureApplication.java'))), 70000);
    const java = await navigation.open(symbols);
    remember(java);
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.toString(), java.uri);
    assert.match(editor.document.getText(editor.selection), /FixtureApplication/);

    const settings = await navigation.search('@ editor.formatOnSave');
    assert.equal(settings[0]?.key, 'editor.formatOnSave');
    const previous = vscode.workspace.getConfiguration('editor').inspect('formatOnSave');
    assert.deepEqual(await navigation.open(settings[0]), { setting: 'editor.formatOnSave' });
    assert.deepEqual(vscode.workspace.getConfiguration('editor').inspect('formatOnSave'), previous);
    assert.equal(Object.hasOwn(settings[0], 'value'), false);
    const actions = await navigation.search('> Open Settings');
    assert.equal(actions[0]?.command, 'workbench.action.openSettings');
    assert.deepEqual(await navigation.open(actions[0]), { command: 'workbench.action.openSettings' });

    const git = await withSearchGitFixture(workspace, process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE, async (fixture) => {
      try {
        const mixed = await navigation.search(fixture.term);
        const file = mixed.find(item => item.type === 'file' && item.label === fixture.filename);
        const commit = mixed.find(item => item.type === 'commit' && item.label === fixture.subject);
        const refs = await navigation.search('% ' + fixture.branch);
        const branch = refs.find(item => item.type === 'branch' && item.label === fixture.branch);
        assert.ok(file && commit && branch);
        remember(await navigation.open(file));
        assert.equal(vscode.window.activeTextEditor.document.getText(), 'original fixture\n');
        assert.equal(branch.hash, fixture.hash);
        const revision = await navigation.open(commit);
        remember(revision);
        assert.equal(revision.hash, fixture.hash);
        const document = vscode.window.activeTextEditor.document;
        assert.equal(document.uri.scheme, 'rocketbrain-git-search');
        assert.equal(document.isDirty, false);
        assert.ok(document.getText().includes(fixture.subject));
        assert.ok(document.getText().includes(fixture.filename));
        return { blendedCommitAndFile: true, branchExactRevision: true, readOnlyGitRevision: true };
      } finally { await cleanTabs(); }
    });

    assert.deepEqual(await navigation.search('$ ' + table), []);
    await actor.query(`CREATE TABLE ${table} (id BIGINT PRIMARY KEY) ENGINE=InnoDB`);
    await api.connectMysql(config);
    const result = (await navigation.search('$ ' + table)).find(item => item.type === 'database' && item.label === table);
    assert.ok(result);
    const object = await navigation.open(result);
    remember(object);
    assert.equal(object.object?.name, table);
    assert.ok(object.source.includes('CREATE TABLE'));
    await api.disconnectMysql();
    await assert.rejects(navigation.open(result), /active database changed/);
    checks.push('Search Everywhere opened a live Java symbol, exact Settings target, one Git revision and a database object. It combined local file and commit results without changing worktree or setting values.');
    return { engine: runtime.dbEngine, version, ...git, nativeJavaSymbol: true, nativeSettingTarget: true, nativeCommandAction: true,
      exactDatabaseObject: true, staleDatabaseResultRefused: true, jdbc: await jdbcReadback() };
  } finally {
    try { await cleanTabs(); await api.disconnectMysql(); }
    finally { try { await actor.query(`DROP TABLE IF EXISTS ${table}`); } finally { await actor.end(); } }
  }
}

module.exports = { withSearchGitFixture, runSearchEverywhereChecks };
