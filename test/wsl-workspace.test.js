'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { win32 } = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createWslWorkbench, readWslText } = require('../src/remote/wsl-workspace');
const { registerWslWorkbench } = require('../src/remote/wsl-vscode');
const { wslUnc } = require('../src/remote/wsl-paths');

const windows = 'D:\\Spring workspace 한글';
const linux = '/mnt/d/Spring workspace 한글';
const distro = 'Ubuntu 24.04';
const maven = { distribution: distro, workspaceRoot: windows, system: 'maven', goal: 'test' };
const linuxOnly = '/srv/dev/Case Project 한글';
const unc = '\\\\wsl.localhost\\Ubuntu 24.04\\srv\\dev\\Case Project 한글';
const legacyUnc = unc.replace('wsl.localhost', 'wsl$');

function fixture({ keepRunning = false, isTrusted = () => true, linuxOwned = false } = {}) {
  const state = { windows, linux, listed: distro, now: 0, commands: [], launches: [],
    descriptors: new Map([[win32.join(windows, 'pom.xml'), '<project/>'], [win32.join(windows, 'build.gradle'), 'plugins { id "java" }']]) };
  if (linuxOwned) {
    Object.assign(state, { windows: unc, linux: linuxOnly, canonical: linuxOnly, directoryIdentity: '82:79128' });
    state.descriptors.set(win32.join(unc, 'pom.xml'), '<project/>');
    state.descriptors.set(win32.join(unc, 'settings.gradle'), 'rootProject.name = "linux"');
  }
  let child;
  let onLaunch;
  const launched = new Promise(resolve => { onLaunch = resolve; });

  const service = createWslWorkbench({ platform: 'win32', now: () => state.now, isTrusted,
    fileSystem: {
      async realpath(value) {
        if (linuxOwned && value.startsWith(legacyUnc)) value = value.replace('wsl$', 'wsl.localhost');
        if (value === win32.join(unc, 'pom.xml') && state.pomAlias) return state.pomAlias;
        if (value === windows || value === state.windows || state.descriptors.has(value)) return value;
        throw Object.assign(Error('Missing fixture path'), { code: 'ENOENT' });
      },
      async stat() { return { isDirectory: () => true }; },
      async open(file) {
        const bytes = Buffer.from(state.descriptors.get(file));
        return { async stat() { return { isFile: () => true, size: bytes.length }; }, async close() {},
          async read(buffer) { bytes.copy(buffer); return { bytesRead: bytes.length }; } };
      }
    },
    async run(executable, args, options) {
      assert.match(executable, /System32\\wsl\.exe$/i);
      assert.equal(options.windowsHide, true);
      state.commands.push(args);
      if (args[0] === '--list') return { stdout: Buffer.from('\uFEFF' + state.listed + '\r\n', 'utf16le') };
      if (args[3] === '/usr/bin/readlink') return { stdout: Buffer.from(state.canonical) };
      if (args[3] === '/usr/bin/stat') return { stdout: Buffer.from(state.directoryIdentity) };
      if (args[3] === '/usr/bin/wslpath') return { stdout: Buffer.from(args[5] === '-u' ? state.linux : state.windows) };
      if (args[3] === '/usr/bin/test') return { stdout: Buffer.alloc(0) };
      if (args[6] === 'rocketbrain-wsl-review') {
        assert.equal(args[7], linuxOnly);
        assert.match(args[5], /readlink -e/u);
        assert.match(args[5], /sha256sum/u);
        const rows = args.slice(8).flatMap(name => {
          const bytes = state.descriptors.get(win32.join(unc, name));
          const digest = state.linuxDigests?.[name] ?? (bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex'));
          return digest ? ['file ' + name + ' ' + digest] : [];
        });
        return { stdout: Buffer.from(['root ' + state.directoryIdentity, ...rows].join('\r\n')) };
      }
      if (args[6] === 'rocketbrain-wsl-cancel') {
        assert.equal(args[7], '73');
        assert.equal(args[8], state.launches[0][11]);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 137);
        return { stdout: Buffer.alloc(0) };
      }
      throw Error('Unexpected WSL test command');
    },
    start(_executable, args, options) {
      assert.equal(options.shell, undefined);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      state.launches.push(args);
      child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      queueMicrotask(() => {
        child.stdout.write(Buffer.from(args[11] + ' 73\n'));
        child.stdout.write('BUILD SUCCESS\n');
        onLaunch();
        if (!keepRunning) {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0);
        }
      });
      return child;
    }
  });
  return { service, state, launched };
}

test('WSL inventory decodes redirected Unicode output and round-trips Windows project paths', async () => {
  const { service, state } = fixture();
  assert.equal(readWslText(Buffer.from('Ubuntu\r\n')), 'Ubuntu');
  assert.deepEqual(await service.distributions(), [distro]);
  assert.deepEqual(await service.mapping(distro, windows), { distribution: distro, linux, windows });
  await assert.rejects(service.mapping('--exec', windows), /current WSL list/);
  await assert.rejects(service.mapping(distro, '\\\\wsl$\\Ubuntu\\project'), /different WSL distribution/);
  await assert.rejects(service.mapping(distro, '\\\\server\\share\\project'), /local Windows drive/);
  state.windows = 'D:\\another project';
  await assert.rejects(service.mapping(distro, windows), /same Windows directory/);
  await assert.rejects(fixture({ isTrusted: () => false }).service.distributions(), /trusted/);
});

test('WSL opens an exact registered Linux project and accepts only the two WSL UNC authorities', async () => {
  const { service, state } = fixture({ linuxOwned: true });
  const expected = { distribution: distro, windows: unc, linux: linuxOnly, storage: 'wsl', directoryIdentity: '82:79128' };
  assert.deepEqual(await service.openProject(distro, linuxOnly), expected);
  assert.deepEqual(await service.mapping(distro, legacyUnc), expected);
  const commandCount = state.commands.length;
  await assert.rejects(service.mapping('another distro', unc), /different WSL distribution/);
  await assert.rejects(service.mapping(distro, unc.replace('wsl.localhost', 'server.localhost')), /local Windows drive/);
  await assert.rejects(service.mapping(distro, unc.replace('wsl.localhost', 'wsl.localhost.example')), /local Windows drive/);
  for (const input of ['/srv/../dev', '/srv/dev/', '/srv//dev', '/srv/con. ', '/srv/dev:stream', '/srv/a\\b']) {
    await assert.rejects(service.openProject(distro, input), /exact Linux project path/);
  }
  assert.equal(state.commands.length, commandCount);
  await assert.rejects(service.openProject(distro, linuxOnly.toLowerCase()), /physical Linux folder.*case/);
  state.windows = unc.replace(distro, distro.toLowerCase());
  await assert.rejects(service.openProject(distro, linuxOnly), /same WSL distribution/);
  state.windows = unc;
  state.linux = '/srv/dev/Different';
  await assert.rejects(service.mapping(distro, unc), /exact Linux folder/);
});

test('WSL Linux build review binds the exact physical directory and both descriptor observations', async () => {
  const { service, state } = fixture({ linuxOwned: true });
  const request = { ...maven, workspaceRoot: legacyUnc };
  let review = await service.review(request);
  assert.equal(review.storage, 'wsl');
  assert.equal(review.linux, linuxOnly);
  state.directoryIdentity = '82:99128';
  await assert.rejects(service.apply(review.token, { approved: true }), /changed after review/);
  review = await service.review(request);
  state.descriptors.set(win32.join(unc, 'pom.xml'), '<project><!-- edited --></project>');
  await assert.rejects(service.apply(review.token, { approved: true }), /changed after review/);
  state.linuxDigests = { 'pom.xml': '0'.repeat(64) };
  await assert.rejects(service.review(request), /did not observe the same WSL build descriptors/);
  delete state.linuxDigests;
  state.pomAlias = win32.join(unc, 'Pom.xml');
  await assert.rejects(service.review(request), /exact name/);
  delete state.pomAlias;
  assert.equal(state.launches.length, 0);
  const gradle = await service.review({ ...request, system: 'gradle', goal: 'classes' });
  assert.deepEqual(Object.keys(gradle.descriptors), ['settings.gradle']);
  const result = await service.apply(gradle.token, { approved: true });
  assert.equal(result.code, 0);
  assert.deepEqual(state.launches[0].slice(0, 5), ['--distribution', distro, '--cd', linuxOnly, '--exec']);
  assert.deepEqual(state.launches[0].slice(12, 14), [linuxOnly, '82:99128']);
  assert.match(state.launches[0][9], /pwd -P/);
  assert.deepEqual(state.launches[0].slice(-4), ['/usr/bin/gradle', '--no-daemon', '--console=plain', 'classes']);
});

test('the WSL open command delegates exact folder opening to VS Code and reviews only opened WSL roots', async () => {
  const { service, state } = fixture({ linuxOwned: true });
  const registered = new Map();
  const opened = [];
  const file = fsPath => ({ scheme: 'file', fsPath, authority: fsPath.split('\\')[2], toString: () => 'file://' + fsPath });
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [] },
    env: {},
    Uri: { file },
    commands: { registerCommand(id, handler) { registered.set(id, handler); return { dispose() {} }; },
      async executeCommand(...args) { opened.push(args); } },
    window: { createOutputChannel: () => ({ dispose() {} }),
      showQuickPick: async choices => choices[0], showInputBox: async () => linuxOnly,
      showErrorMessage: message => assert.fail(message) }
  };
  const workbench = registerWslWorkbench(vscode, { createService: () => service });
  await registered.get('rocketbrain.wsl.openProject')();
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'vscode.openFolder');
  assert.equal(opened[0][1].fsPath, unc);
  assert.deepEqual(opened[0][2], { forceNewWindow: true });
  vscode.workspace.workspaceFolders = [{ name: 'Linux project', uri: file(unc) }];
  const reviewed = await workbench.review({ projectUri: file(legacyUnc), system: 'maven', goal: 'test' });
  assert.deepEqual(wslUnc(reviewed.windows), { distribution: distro, linux: linuxOnly });
  const commandCount = state.commands.length;
  await assert.rejects(workbench.review({ projectUri: file(unc.toLowerCase()), system: 'maven', goal: 'test' }), /exact WSL project root/);
  await assert.rejects(workbench.review({ projectUri: file(unc + '\\nested'), system: 'maven', goal: 'test' }), /exact WSL project root/);
  await assert.rejects(workbench.review({ projectUri: { ...file(unc), fragment: 'other' }, system: 'maven', goal: 'test' }), /exact WSL project root/);
  await assert.rejects(workbench.review({ projectUri: file(unc), distribution: 'Another', system: 'maven', goal: 'test' }), /different WSL distribution/);
  assert.equal(state.commands.length, commandCount);
  workbench.dispose();
});

test('WSL review binds a fresh build, never runs arguments outside the known lifecycle, and consumes approval', async () => {
  const { service, state } = fixture();
  await assert.rejects(service.review({ ...maven, goal: '--settings' }), /available WSL build tasks/);
  let review = await service.review(maven);
  await assert.rejects(service.apply(review.token), /review and approve/i);
  await assert.rejects(service.apply(review.token, { approved: true }), /review and approve/i);
  review = await service.review(maven);
  state.descriptors.set(win32.join(windows, 'pom.xml'), '<project><!-- changed --></project>');
  await assert.rejects(service.apply(review.token, { approved: true }), /changed after review/);
  review = await service.review(maven);
  state.now += 60001;
  await assert.rejects(service.apply(review.token, { approved: true }), /review and approve/i);
  assert.equal(state.launches.length, 0);
  review = await service.review({ ...maven, system: 'gradle', goal: 'classes' });
  const result = await service.apply(review.token, { approved: true });
  assert.equal(result.code, 0);
  assert.equal(result.output, 'BUILD SUCCESS\n');
  assert.deepEqual(state.launches[0].slice(0, 5), ['--distribution', distro, '--cd', linux, '--exec']);
  assert.deepEqual(state.launches[0].slice(-4), ['/usr/bin/gradle', '--no-daemon', '--console=plain', 'classes']);
});

test('WSL cancellation signals only the approved owned Linux process group', async () => {
  const { service, state, launched } = fixture({ keepRunning: true });
  const aborted = new AbortController();
  aborted.abort();
  let review = await service.review(maven);
  await assert.rejects(service.apply(review.token, { approved: true, signal: aborted.signal }), /cancelled before launch/);
  assert.equal(state.launches.length, 0);
  review = await service.review(maven);
  const result = service.apply(review.token, { approved: true });
  await launched;
  assert.equal(await service.cancel(), true);
  assert.equal((await result).cancelled, true);
  assert.equal(await service.cancel(), false);
  const signals = state.commands.filter(args => args[6] === 'rocketbrain-wsl-cancel');
  assert.equal(signals.length, 1);
  assert.ok(signals[0][5].includes('/proc/$pid/cmdline'));
  assert.equal(state.commands.some(args => args.includes('--terminate') || args.includes('--shutdown')), false);
});

test('WSL Linux project cancellation retains the reviewed path and group owner', async () => {
  const { service, state, launched } = fixture({ keepRunning: true, linuxOwned: true });
  const review = await service.review({ ...maven, workspaceRoot: unc });
  const execution = service.apply(review.token, { approved: true });
  await launched;
  assert.equal(await service.cancel(), true);
  assert.equal((await execution).cancelled, true);
  const signal = state.commands.find(args => args[6] === 'rocketbrain-wsl-cancel');
  assert.deepEqual(signal.slice(7), ['73', state.launches[0][11]]);
  assert.deepEqual(state.launches[0].slice(12, 14), [linuxOnly, '82:79128']);
});
