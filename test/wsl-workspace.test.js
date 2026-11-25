'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { win32 } = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createWslWorkbench, readWslText } = require('../src/remote/wsl-workspace');

const windows = 'D:\\Spring workspace 한글';
const linux = '/mnt/d/Spring workspace 한글';
const distro = 'Ubuntu 24.04';
const maven = { distribution: distro, workspaceRoot: windows, system: 'maven', goal: 'test' };

function fixture({ keepRunning = false, isTrusted = () => true } = {}) {
  const state = { windows, linux, listed: distro, now: 0, commands: [], launches: [],
    descriptors: new Map([[win32.join(windows, 'pom.xml'), '<project/>'], [win32.join(windows, 'build.gradle'), 'plugins { id "java" }']]) };
  let child;
  let onLaunch;
  const launched = new Promise(resolve => { onLaunch = resolve; });

  const service = createWslWorkbench({ platform: 'win32', now: () => state.now, isTrusted,
    fileSystem: {
      async realpath(value) {
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
      if (args[3] === '/usr/bin/wslpath') return { stdout: Buffer.from(args[5] === '-u' ? state.linux : state.windows) };
      if (args[3] === '/usr/bin/test') return { stdout: Buffer.alloc(0) };
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
  await assert.rejects(service.mapping(distro, '\\\\wsl$\\Ubuntu\\project'), /local Windows drive/);
  state.windows = 'D:\\another project';
  await assert.rejects(service.mapping(distro, windows), /same Windows directory/);
  await assert.rejects(fixture({ isTrusted: () => false }).service.distributions(), /trusted/);
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
