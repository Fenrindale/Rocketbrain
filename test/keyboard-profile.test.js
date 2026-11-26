'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const manifest = require('../package.json');
const { activeContext,auditProfile,exportProfile,parseKeybindings,profileRules,workspaceKeybindings } = require('../src/keyboard-profile');
const { assertWorkspaceKeybindings } = require('../scripts/keyboard-profile-manifest');
const { jdbcReadback } = require('./java-source-analysis-host');
const { registerKeyboardProfile } = require('../src/keyboard-profile-vscode');
const { createContextHarness, document, uri } = require('./helpers/context-actions-fixture');

const command = 'rocketbrain.keyboardProfile';
const find = (rules, id) => rules.find(rule => rule.command === id);

test('52 opt-in shortcuts use four platform leaders and registered Rocketbrain action IDs', () => {
  const declared = new Set(manifest.contributes.commands.map(value => value.command));
  assertWorkspaceKeybindings(manifest);
  const installed = workspaceKeybindings();
  for (const platform of ['win32', 'linux', 'darwin']) {
    const rules = profileRules(platform);
    assert.equal(rules.length, 52);
    assert.equal(new Set(rules.map(rule => rule.key)).size, rules.length);
    assert.equal(new Set(rules.map(rule => rule.command)).size, rules.length);
    assert.equal(new Set(rules.map(rule => rule.group)).size, 4);
    const modifier = platform === 'darwin' ? 'cmd' : 'ctrl';
    assert.ok(rules.every(rule => rule.key.startsWith(modifier + '+shift+f')));
    for (const rule of rules.filter(rule => rule.command.startsWith('rocketbrain.'))) assert.ok(declared.has(rule.command), rule.command);
    for (const [index,rule] of rules.entries()) {
      const contribution=installed[index];
      assert.equal(contribution.command,rule.command);
      assert.equal(platform==='darwin'?contribution.mac:contribution.key,rule.key);
      assert.equal(contribution.when,activeContext+' && workspaceFolderCount > 0 && '+rule.when);
      assert.match(contribution.when,/!inQuickOpen/);
    }
    assert.match(find(rules, 'rocketbrain.runQuery').when, /editorTextFocus.*editorLangId == sql/u);
    assert.match(find(rules, 'rocketbrain.focusQueryEditor').when, /!editorTextFocus.*focusedView == rocketbrain.results/u);
    assert.match(find(rules, 'workbench.action.focusActiveEditorGroup').when, /\(terminalFocus \|\|/u);
    assert.doesNotMatch(find(rules, 'workbench.action.focusActiveEditorGroup').when, /!terminalFocus/u);
    assert.match(find(rules, 'rocketbrain.gitWorktree.context').when, /isWorkspaceTrusted.*workspaceFolderCount > 0/u);
    assert.match(find(rules, 'rocketbrain.java.smartStepInto').when, /debugType == rocketbrain-java.*debugState == stopped/u);
    assert.match(find(rules, 'rocketbrain.java.safeDelete').when, /editorLangId == java.*!editorReadonly/u);
  }
  assert.throws(() => profileRules('other'), /Choose Windows/);
});

test('JSONC accepts comments, trailing commas and literal strings with comment syntax', () => {
  const text = '\uFEFF[\n // ignored comment\n {"command":"fixture.x","key":"ctrl+r","args":"https://example.test/* literal */",},\n /* end */ ]';
  assert.deepEqual(parseKeybindings(text), [{ command: 'fixture.x', key: 'ctrl+r', args: 'https://example.test/* literal */' }]);
  for (const invalid of ['{"key":"x"}', '[,]', '[null]', '[{},,]', '[{"key":"open}', '[/* open', '[{}],']) {
    assert.throws(() => parseKeybindings(invalid), /supplied|keybindings/);
  }
  assert.throws(() => parseKeybindings(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
  assert.throws(() => parseKeybindings('['.repeat(35) + ']'.repeat(35)), /nested too deeply/);
});

test('preview separates identical rules, possible overlaps, prefix conflicts and disjoint literal contexts', () => {
  const command = 'rocketbrain.runQuery';
  const rule = find(profileRules('win32'), command);
  const prefix = rule.key.split(' ')[0];
  const input = JSON.stringify([
    { key: 'SHIFT+CTRL+F10 R', command: 'fixture.otherLanguage', when: 'editorLangId == java' },
    { key: rule.key, command, when: rule.when },
    { key: rule.key, command, when: rule.when, args: { value: 'fixture' } },
    { key: rule.key, command: '' }, { key: rule.key, command: '-fixture.remove' },
    { key: prefix, command: 'fixture.chord', systemWide: true },
    { key: rule.key, command: 'fixture.uncertain', when: 'editorLangId == java || editorLangId == sql' }
  ]);
  const manifests = [{ id: 'fixture.extension', packageJSON: { contributes: { keybindings: [
    { key: 'ctrl+x', win: rule.key, mac: 'cmd+x', command: 'fixture.extensionCommand' },
    { key: prefix + ' q', command: 'fixture.otherChord' }
  ] } } }];
  const ownerId = 'rocketbrain-local.rocketbrain';
  const report = auditProfile('win32',{commands:[command],input,manifests:[...manifests,{id:ownerId,packageJSON:manifest}],ownerId});
  const results = find(report.routes, command).overlaps;
  assert.equal(report.suppliedRules, 7);
  const generated = manifest.contributes.keybindings.filter(binding => binding.when?.startsWith(activeContext+' && '));
  assert.equal(generated.length,52);
  assert.equal(report.manifestRules,2+manifest.contributes.keybindings.length-generated.length);
  assert.equal(results.find(item => item.command === 'fixture.otherLanguage').scope, 'disjoint literal contexts');
  assert.ok(results.some(item => item.scope === 'identical rule'));
  assert.ok(results.some(item => item.command === command && item.hasArgs && item.scope === 'possible overlap'));
  assert.ok(results.some(item => item.action === 'remove'));
  assert.ok(results.some(item => item.action === 'block'));
  assert.ok(results.some(item => item.relation === 'chord prefix' && item.systemWide));
  assert.ok(results.some(item => item.command === 'fixture.uncertain' && item.scope === 'possible overlap'));
  assert.ok(results.some(item => item.source === 'fixture.extension'));
  assert.ok(!results.some(item => item.command === 'fixture.otherChord'));
  assert.deepEqual(JSON.parse(exportProfile(report)), [{key: rule.key, command, when: rule.when}]);
});

test('preview, cancellation, stale review and untitled export leave the chosen keybindings file untouched', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-keyboard-profile-'));
  const file = path.join(owned, 'keybindings.json');
  const baseline = '[ // owned test data\n {"key":"ctrl+shift+f8","command":"fixture.prefix"},\n]\n';
  await fs.writeFile(file, baseline, { flag: 'wx' });
  t.after(async () => {
    const physical = await fs.realpath(owned);
    assert.equal(path.relative(parent, path.dirname(physical)), '');
    assert.match(path.basename(physical), /^rb-keyboard-profile-/u);
    await fs.unlink(file);
    await fs.rmdir(physical);
  });
  const host = createContextHarness(owned);
  host.vscode.extensions = { all: [host.context.extension] };
  const opens = [];
  host.vscode.workspace.openTextDocument = async options => {
    assert.deepEqual(Object.keys(options).sort(), ['content', 'language']);
    const doc = document(uri(path.join(owned, 'unsaved'), 'untitled'), options.language, options.content);
    opens.push(doc);
    return doc;
  };
  const source = document(uri(file), 'jsonc', baseline);
  host.show(source);
  const service = registerKeyboardProfile(host.vscode);
  t.after(() => service.dispose());
  const open = () => host.vscode.commands.executeCommand(command);
  host.answer(items => items.find(item => item.platform === 'win32'));
  assert.equal(await open(), undefined);
  assert.equal(opens.length, 0);

  const choose = kind => items => items.find(item => item.platform === 'win32') || items.find(item => item.kind === kind);
  host.answer(choose('audit'));
  assert.equal((await open()).kind, 'audit');
  assert.equal(opens.at(-1).languageId, 'plaintext');
  assert.match(opens.at(-1).getText(), /possible overlap · Supplied keybindings · fixture\.prefix/u);
  host.show(source);
  host.answer(items => {
    const platform = items.find(item => item.platform === 'win32');
    if (platform) return platform;
    source.version++;
    return items.find(item => item.kind === 'audit');
  });
  assert.equal(await open(), undefined);
  assert.match(host.errors.at(-1), /document changed/u);
  assert.equal(opens.length, 1);

  host.answer(choose('export'));
  assert.equal((await open()).kind, 'export');
  assert.equal(opens.at(-1).uri.scheme, 'untitled');
  assert.equal(opens.at(-1).languageId, 'jsonc');
  assert.ok(JSON.parse(opens.at(-1).getText()).some(rule => rule.command === 'rocketbrain.runQuery'));
  const getCommands = host.vscode.commands.getCommands;
  let entered, release;
  const inspecting = new Promise(resolve => { entered = resolve; });
  const completed = new Promise(resolve => { release = resolve; });
  host.vscode.commands.getCommands = async () => { entered(); await completed; return getCommands(); };
  const cancelledExport = open();
  await inspecting;
  host.answer(() => undefined);
  assert.equal(await open(), undefined, 'A second opening cancels the previously proposed export.');
  release();
  assert.equal(await cancelledExport, undefined);
  assert.equal(opens.length, 2);
  assert.equal(await fs.readFile(file, 'utf8'), baseline);
  assert.deepEqual(await fs.readdir(owned), ['keybindings.json']);
});

function profileState(root,context) {
  const host=createContextHarness(root);
  const writes=[], gate=[];
  const pickedContext=context || host.context;
  host.vscode.extensions={all:[pickedContext.extension]};
  host.commands.set('setContext',(name,value) => {assert.equal(name,activeContext);gate.push(value);});
  const workspaceState=pickedContext.workspaceState;
  const memo={get:workspaceState.get,async update(key,value){writes.push(value);return workspaceState.update(key,value);}};
  let folders;
  host.vscode.workspace.onDidChangeWorkspaceFolders=fn=>{folders=fn;return {dispose(){folders=undefined;}};};
  const service=registerKeyboardProfile(host.vscode,{...pickedContext,workspaceState:memo});
  return {host,service,gate,writes,context:pickedContext,folders:()=>folders()};
}

test('workspace profile toggles through the normal Quick Pick, reloads and remains isolated', async () => {
  const root=path.resolve('owned-workspace-a');
  const first=profileState(root);
  assert.deepEqual(await first.service.workspaceStatus(),{configured:false,enabled:false,hasWorkspace:true});
  assert.deepEqual(first.gate,[false]);
  const command=()=>first.host.vscode.commands.executeCommand('rocketbrain.keyboardProfile');
  first.host.answer(items=>items.find(item=>item.kind==='workspace'));
  assert.equal((await command()).kind,'enable');
  assert.deepEqual(first.writes,[true]);
  assert.deepEqual(first.gate,[false,true]);
  await first.service.dispose();
  assert.equal(first.gate.at(-1),false,'Disposal clears the live context while retaining the workspace preference.');

  const reopened=profileState(root,first.context);
  const other=profileState(path.resolve('owned-workspace-b'));
  try {
    assert.equal((await reopened.service.workspaceStatus()).enabled,true);
    assert.equal((await other.service.workspaceStatus()).enabled,false);
    const original=reopened.host.vscode.workspace.workspaceFolders;
    reopened.host.vscode.workspace.workspaceFolders=[];
    reopened.folders();
    assert.deepEqual(await reopened.service.workspaceStatus(),{configured:true,enabled:false,hasWorkspace:false});
    await assert.rejects(reopened.service.setWorkspaceEnabled(true),/Open a workspace folder/);
    reopened.host.vscode.workspace.workspaceFolders=original;
    reopened.folders();
    assert.equal((await reopened.service.workspaceStatus()).enabled,true);
    reopened.host.answer(items=>items.find(item=>item.kind==='workspace'));
    assert.equal((await reopened.host.vscode.commands.executeCommand('rocketbrain.keyboardProfile')).kind,'disable');
    assert.deepEqual(reopened.writes,[undefined]);
    assert.equal((await reopened.service.workspaceStatus()).enabled,false);
  } finally {
    await Promise.all([reopened.service.dispose(),other.service.dispose()]);
  }
});

test('a superseded profile picker cannot enable shortcuts', async () => {
  const {host,service,writes,gate}=profileState(path.resolve('owned-workspace-quick-pick'));
  let choose,started;
  const decided=new Promise(resolve=>{choose=resolve;});
  const began=new Promise(resolve=>{started=resolve;});
  host.answer(async items=>{started();await decided;return items.find(item=>item.kind==='workspace');});
  const open=()=>host.vscode.commands.executeCommand('rocketbrain.keyboardProfile');
  try {
    const stale=open();
    await began;
    host.answer(()=>undefined);
    assert.equal(await open(),undefined);
    choose();
    assert.equal(await stale,undefined);
    assert.equal((await service.workspaceStatus()).enabled,false);
    assert.deepEqual(writes,[]);
    assert.deepEqual(gate,[false]);
  } finally {
    await service.dispose();
  }
});

test('workspace profile changes preserve an owned Spring JDBC read', {
  skip:!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG
},async () => {
  const {service}=profileState(path.resolve('owned-profile-spring'));
  try {
    const before=await jdbcReadback();
    assert.ok(before);
    assert.equal((await service.workspaceStatus()).enabled,false);
    assert.equal((await service.setWorkspaceEnabled(true)).enabled,true);
    assert.deepEqual(await jdbcReadback(),before);
    assert.equal((await service.setWorkspaceEnabled(false)).enabled,false);
    const after=await jdbcReadback();
    assert.deepEqual(after,before);
    if (process.env.ROCKETBRAIN_KEYBOARD_PROFILE_RECEIPT) {
      await fs.writeFile(process.env.ROCKETBRAIN_KEYBOARD_PROFILE_RECEIPT,JSON.stringify({
        engine:process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,disabledByDefault:true,enabledAndDisabled:true,readOnlySpringJdbc:after
      },null,2)+'\n',{flag:'wx'});
    }
  } finally {
    await service.dispose();
  }
});
