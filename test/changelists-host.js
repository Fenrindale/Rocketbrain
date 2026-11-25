'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');

const run = promisify(execFile);
const read = async name => JSON.parse(await fs.readFile(name, 'utf8'));
const digest = async name => createHash('sha256').update(await fs.readFile(name)).digest('hex');

async function runChangelistChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const serverOwner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(serverOwner.kind));
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const workspace = vscode.workspace.workspaceFolders[0];
  const root = await fs.realpath(workspace.uri.fsPath);
  assert.equal(root, await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
  assert.ok(root.split(path.sep).includes('test-output'));
  const repo = await fs.mkdtemp(path.join(root, 'rb-changelist-'));
  const token = randomUUID(), marker = path.join(repo, '.fixture-owner');
  await fs.writeFile(marker, token, { flag: 'wx' });
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const git = async (...args) => (await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repo, env: gitEnv, windowsHide: true, encoding: 'utf8', timeout: 10000
  })).stdout;
  const relative = name => path.join(repo, ...name.split('/'));
  const write = async (name, content) => { await fs.mkdir(path.dirname(relative(name)), { recursive: true }); await fs.writeFile(relative(name), content); };
  const editor = async name => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(relative(name))), { preview: false });
  const close = async names => {
    const files = new Set(names.map(name => vscode.Uri.file(relative(name)).toString()));
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => files.has(tab.input?.uri?.toString()));
    if (tabs.length) assert.equal(await vscode.window.tabGroups.close(tabs), true);
  };
  const folderTarget = vscode.workspace.workspaceFile ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
  const launchConfig = () => vscode.workspace.getConfiguration('launch', workspace.uri);
  const previous = launchConfig().inspect('configurations');
  const previousLaunch = folderTarget === vscode.ConfigurationTarget.WorkspaceFolder ? previous?.workspaceFolderValue : previous?.workspaceValue;
  const launch = { name: 'Owned Changelist Fixture', type: 'rocketbrain-java', request: 'launch' };
  const options = { repositoryUri: vscode.Uri.file(repo).toString() };
  const lists = api.changelists;
  let launchAdded = false;
  try {
    await git('init', '-q', '--template=', '--initial-branch=main');
    await write('tracked.txt', 'first\n');
    await git('add', '--', 'tracked.txt');
    await git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Rocketbrain Fixture', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture base');
    await write('tracked.txt', 'staged\n');
    await git('add', '--', 'tracked.txt');
    await write('left/same.txt', 'original left\n');
    await write('right/same.txt', 'original right\n');
    await write('outside-context.txt', 'outside\n');
    const index = await digest(relative('.git/index')), head = await git('rev-parse', 'HEAD');
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.vcs.changelists'));
    const first = await lists.create({ ...options, name: 'First work context' });
    const second = await lists.create({ ...options, name: 'Second work context' });
    await lists.assign({ ...options, listId: first.id, paths: ['left/same.txt', 'right/same.txt'] });
    await lists.assign({ ...options, listId: second.id, paths: ['left/same.txt'] });
    const assigned = await lists.snapshot(options);
    assert.deepEqual(assigned.lists.find(list => list.id === first.id).members.map(member => member.path), ['right/same.txt']);
    assert.deepEqual(assigned.lists.find(list => list.id === second.id).members.map(member => member.path), ['left/same.txt']);
    assert.deepEqual(assigned.unassigned.find(member => member.path === 'tracked.txt').statuses, ['M ']);

    await launchConfig().update('configurations', [...(previousLaunch || []), { ...launch, mainClass: 'fixture.boot.FixtureApplication' }], folderTarget);
    launchAdded = true;
    assert.ok((await lists.launchChoices(options)).some(value => value.name === launch.name));
    await editor('left/same.txt');
    const active = await editor('right/same.txt');
    active.selection = new vscode.Selection(0, 7, 0, 1);
    const captured = await lists.capture({ ...options, listId: first.id, launch });
    assert.deepEqual(captured.context.editors.map(item => item.path).sort(), ['left/same.txt', 'right/same.txt']);
    assert.equal(captured.context.activePath, 'right/same.txt');
    await close(['left/same.txt', 'right/same.txt']);
    await editor('outside-context.txt');
    const restored = await lists.restore({ ...options, listId: first.id });
    assert.equal(restored.editors.find(item => item.path === 'right/same.txt').selection, 'restored');
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), vscode.Uri.file(relative('right/same.txt')).toString());
    assert.ok(vscode.window.activeTextEditor.selection.isReversed);
    assert.equal(vscode.window.activeTextEditor.selection.anchor.character, 7);
    assert.equal(vscode.window.activeTextEditor.selection.active.character, 1);
    assert.deepEqual(restored.launch, { ...launch, state: 'available' });
    assert.equal(restored.launched, false);
    assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab =>
      tab.input?.uri?.toString() === vscode.Uri.file(relative('outside-context.txt')).toString()));

    await close(['left/same.txt', 'right/same.txt']);
    await fs.mkdir(relative('gone'));
    await fs.rename(relative('left/same.txt'), relative('gone/same.txt'));
    await write('right/same.txt', 'edited after capturing\n');
    const changed = await lists.snapshot(options);
    assert.equal(changed.lists.find(item => item.id === second.id).members[0].state, 'unavailable');
    assert.ok(changed.unassigned.some(item => item.path === 'gone/same.txt'));
    await assert.rejects(lists.assign({ ...options, listId: first.id, paths: ['left/same.txt'] }), /still changed/);
    const stale = await lists.restore({ ...options, listId: first.id });
    assert.deepEqual(stale.editors, [{ path: 'left/same.txt', state: 'missing' },
      { path: 'right/same.txt', state: 'opened', selection: 'stale' }]);
    assert.equal(await digest(relative('.git/index')), index);
    assert.equal(await git('rev-parse', 'HEAD'), head);
    assert.equal(await fs.readFile(relative('right/same.txt'), 'utf8'), 'edited after capturing\n');

    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(9000) });
    assert.equal(response.ok, true);
    const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
    assert.deepEqual(await response.json(), springIsolation);
    checks.push('Owned Git changelists moved exact paths, restored a reversed editor selection and launch reference, refused stale paths, and preserved the Git index and HEAD.');
    return { engine: runtime.dbEngine, movedBetweenLists: true, sameBasenameDistinct: true, missingPathReported: true,
      selectionRestored: true, staleSelectionSkipped: true, launchReferenceRestored: true, launchStarted: false,
      unrelatedEditorPreserved: true, indexPreserved: true, headPreserved: true, springIsolation };
  } finally {
    try { await close(['left/same.txt', 'right/same.txt', 'outside-context.txt']); }
    finally {
      if (launchAdded) await launchConfig().update('configurations', previousLaunch, folderTarget);
      const owned = await fs.realpath(repo);
      assert.equal(path.dirname(owned), root);
      assert.ok(path.basename(owned).startsWith('rb-changelist-'));
      assert.equal(await fs.readFile(marker, 'utf8'), token);
      await fs.rm(owned, { recursive: true, force: false });
    }
  }
}

module.exports = { runChangelistChecks };
