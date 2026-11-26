'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { win32 } = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { distroName, linuxProjectPath, wslUnc, sameWslPath } = require('./wsl-paths');

const execute = promisify(execFile);
const outputLimit = 512 * 1024;
const descriptorLimit = 2 * 1024 * 1024;
const windowsPath = /^[a-z]:\\[^\x00-\x1f\x7f]*$/i;
const toolSpecifications = {
  maven: { executable: '/usr/bin/mvn', files: ['pom.xml'], goals: ['validate', 'compile', 'test', 'package'], args: ['--batch-mode', '--no-transfer-progress'] },
  gradle: { executable: '/usr/bin/gradle', files: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    goals: ['classes', 'test', 'build'], args: ['--no-daemon', '--console=plain'] }
};

const runGroup = 'printf "%s %s\\n" "$1" "$$"; shift; "$@"; status=$?; exit "$status"';
const runLinuxGroup = `
  printf "%s %s\\n" "$1" "$$"
  [ "$(pwd -P)" = "$2" ] && [ "$(/usr/bin/stat -c '%d:%i' -- .)" = "$3" ] || {
    printf '%s\\n' 'The Linux project identity changed before launch. Review the build again.' >&2
    exit 6
  }
  shift 3
  "$@"
  status=$?
  exit "$status"`;
const killGroup = `
  pid=$1
  [ -r "/proc/$pid/cmdline" ] || exit 0
  /usr/bin/tr '\\000' '\\n' < "/proc/$pid/cmdline" | /usr/bin/grep -Fqx -- "$2" || exit 5
  /usr/bin/kill -KILL -- "-$pid"`;
const linuxReview = String.raw`
  set -eu
  project=$1
  shift
  [ -d "$project" ] && [ "$(/usr/bin/readlink -e -- "$project")" = "$project" ] || exit 3
  identity=$(/usr/bin/stat -c '%d:%i' -- "$project")
  printf 'root %s\n' "$identity"
  for descriptor do
    file="$project/$descriptor"
    [ ! -L "$file" ] || exit 4
    [ -e "$file" ] || continue
    [ -f "$file" ] || exit 4
    before=$(/usr/bin/stat -c '%d:%i:%s:%y:%z' -- "$file")
    [ "$(/usr/bin/stat -c '%s' -- "$file")" -le 2097152 ] || exit 4
    sha=$(/usr/bin/head -c 2097153 -- "$file" | /usr/bin/sha256sum)
    [ "$before" = "$(/usr/bin/stat -c '%d:%i:%s:%y:%z' -- "$file")" ] || exit 5
    printf 'file %s %s\n' "$descriptor" "$(printf '%s' "$sha" | /usr/bin/cut -d ' ' -f 1)"
  done
  [ "$identity" = "$(/usr/bin/stat -c '%d:%i' -- "$project")" ] || exit 5`;

function readWslText(bytes) {
  const buffer = Buffer.from(bytes);
  const utf16 = buffer[0] === 255 && buffer[1] === 254 || buffer.some(byte => byte === 0);
  return buffer.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '').trim();
}

function distroArgs(distribution, command) {
  return ['--distribution', distribution, '--exec', ...command];
}

function osWslPath(platform) {
  if (platform !== 'win32') throw Error('WSL workspace builds require a local Windows extension host.');
  return win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
}

function localIdentity(file) {
  if (typeof file !== 'string' || !windowsPath.test(file)) throw Error('Choose a workspace on a local Windows drive.');
  return win32.normalize(file).replace(/\\$/u, '').toLowerCase();
}

async function descriptorDigest(fileSystem, file) {
  const handle = await fileSystem.open(file, 'r');
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > descriptorLimit) throw Error('The WSL build descriptor must be a bounded file.');
    const buffer = Buffer.alloc(status.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== status.size) throw Error('The build descriptor changed while it was being reviewed.');
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally { await handle.close(); }
}

function createWslWorkbench({ platform = process.platform, fileSystem = fs, run = execute, start = spawn,
  isTrusted = () => true, now = Date.now } = {}) {
  const reviews = new Map();
  let active;
  let disposed = false;

  function requireTrust() {
    if (disposed || !isTrusted()) throw Error('Open a trusted local Windows workspace to use WSL.');
  }

  async function call(args) {
    requireTrust();
    const executable = osWslPath(platform);
    try {
      const result = await run(executable, args, { encoding: 'buffer', windowsHide: true, timeout: 12000, maxBuffer: outputLimit });
      return readWslText(result.stdout);
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('Windows could not find WSL.');
      throw Error('WSL could not complete the selected operation. Check the distribution and installed tools.');
    }
  }

  async function distributions() {
    const text = await call(['--list', '--quiet']);
    const names = text.split(/\r?\n/u).map(name => name.trim()).filter(Boolean);
    if (names.length > 128 || names.some(name => !distroName.test(name)) || new Set(names).size !== names.length) {
      throw Error('WSL returned an invalid distribution list.');
    }
    return names;
  }

  async function registered(distribution) {
    if (!(await distributions()).includes(distribution)) throw Error('Choose a distribution from the current WSL list.');
  }

  async function linuxMapping(distribution, linux, originalWindows) {
    const selected = { distribution, linux: linuxProjectPath(linux) };
    const canonical = await call(distroArgs(distribution, ['/usr/bin/readlink', '-e', '--', linux]));
    if (canonical !== linux) throw Error('Use the exact physical Linux folder and its original letter case.');
    const returned = await call(distroArgs(distribution, ['/usr/bin/wslpath', '-a', '-w', linux]));
    if (!sameWslPath(wslUnc(returned), selected)) throw Error('The Linux project did not map to the same WSL distribution and folder.');
    const input = originalWindows || returned;
    const linuxBack = await call(distroArgs(distribution, ['/usr/bin/wslpath', '-a', '-u', input]));
    if (linuxBack !== linux) throw Error('The WSL UNC path did not map back to the exact Linux folder.');
    const windows = await fileSystem.realpath(input);
    if (!sameWslPath(wslUnc(windows), selected) || !(await fileSystem.stat(windows)).isDirectory()) {
      throw Error('Open the existing WSL folder from the verified Linux path.');
    }
    const directoryIdentity = await call(distroArgs(distribution, ['/usr/bin/stat', '-c', '%d:%i', '--', linux]));
    if (!/^\d{1,24}:\d{1,24}$/u.test(directoryIdentity)) throw Error('The Linux project directory identity could not be verified.');
    return { distribution, windows, linux, storage: 'wsl', directoryIdentity };
  }

  async function openProject(distribution, linux) {
    requireTrust();
    linuxProjectPath(linux);
    await registered(distribution);
    return linuxMapping(distribution, linux);
  }

  async function mapping(distribution, workspaceRoot) {
    requireTrust();
    const unc = wslUnc(workspaceRoot);
    if (unc) {
      if (unc.distribution !== distribution) throw Error('The selected folder belongs to a different WSL distribution.');
      await registered(distribution);
      return linuxMapping(distribution, unc.linux, workspaceRoot);
    }
    localIdentity(workspaceRoot);
    await registered(distribution);
    const windows = await fileSystem.realpath(workspaceRoot);
    const identity = localIdentity(windows);
    if (!(await fileSystem.stat(windows)).isDirectory()) throw Error('Select an existing Windows workspace directory.');
    const linux = await call(distroArgs(distribution, ['/usr/bin/wslpath', '-a', '-u', windows]));
    if (!/^\/[^\x00-\x1f\x7f]{1,2047}$/u.test(linux)) throw Error('WSL did not map the Windows workspace to a Linux directory.');
    const returned = await call(distroArgs(distribution, ['/usr/bin/wslpath', '-a', '-w', linux]));
    localIdentity(returned);
    if (localIdentity(await fileSystem.realpath(returned)) !== identity) throw Error('The WSL workspace path did not map back to the same Windows directory.');
    return { distribution, windows, linux };
  }

  async function linuxDescriptors(scope, files) {
    const response = await call(distroArgs(scope.distribution,
      ['/bin/sh', '-c', linuxReview, 'rocketbrain-wsl-review', scope.linux, ...files]));
    const [identity, ...rows] = response.split(/\r?\n/u);
    if (identity !== 'root ' + scope.directoryIdentity || rows.length > files.length) {
      throw Error('The Linux project changed during build review.');
    }
    const evidence = {};
    for (const row of rows) {
      const [, name, sha] = /^file ([a-z.]+) ([a-f0-9]{64})$/u.exec(row) || [];
      if (!files.includes(name) || Object.hasOwn(evidence, name)) throw Error('WSL reported an invalid build descriptor digest.');
      evidence[name] = sha;
    }
    return evidence;
  }

  async function snapshot(input) {
    if (!input || !Object.hasOwn(toolSpecifications, input.system)) throw Error('Choose a Maven or Gradle build.');
    const spec = toolSpecifications[input.system];
    if (!spec.goals.includes(input.goal)) throw Error('Choose one of the available WSL build tasks.');
    const scope = await mapping(input.distribution, input.workspaceRoot);
    const descriptors = {};
    for (const filename of spec.files) {
      const file = win32.join(scope.windows, filename);
      let resolved;
      try { resolved = await fileSystem.realpath(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (scope.storage === 'wsl' ? !sameWslPath(wslUnc(resolved), wslUnc(file)) : localIdentity(resolved) !== localIdentity(file)) {
        throw Error('The build descriptor must resolve inside the selected project with its exact name.');
      }
      descriptors[filename] = await descriptorDigest(fileSystem, resolved);
    }
    if (Object.keys(descriptors).length === 0) throw Error('The selected folder needs a Maven or Gradle build descriptor.');
    if (scope.storage === 'wsl') {
      const observed = await linuxDescriptors(scope, spec.files);
      if (JSON.stringify(observed) !== JSON.stringify(descriptors)) {
        throw Error('Windows and Linux did not observe the same WSL build descriptors.');
      }
    }
    await call(distroArgs(scope.distribution, ['/usr/bin/test', '-x', spec.executable]));
    return { ...scope, system: input.system, goal: input.goal, descriptors, command: [spec.executable, ...spec.args, input.goal] };
  }

  async function review(input) {
    requireTrust();
    const prepared = await snapshot(input);
    const token = randomUUID();
    const expires = now() + 60000;
    for (const [key, value] of reviews) if (value.expires <= now()) reviews.delete(key);
    if (reviews.size >= 32) reviews.delete(reviews.keys().next().value);
    reviews.set(token, { prepared, expires });
    return { token, ...prepared, command: [...prepared.command], descriptors: { ...prepared.descriptors }, expires };
  }

  async function cancelActive() {
    const target = active;
    if (!target) return false;
    if (!target.cancellation) {
      target.cancellation = (async () => {
        const pid = await Promise.race([target.groupReady, delay(4000, null, { ref: false })]);
        if (target.closed) return false;
        if (!pid) throw Error('The WSL build did not report its Linux process group.');
        await run(osWslPath(platform), distroArgs(target.distribution, ['/bin/sh', '-c', killGroup, 'rocketbrain-wsl-cancel', pid, target.nonce]),
          { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        target.cancelled = true;
        return true;
      })();
    }
    return target.cancellation;
  }

  async function apply(token, { approved = false, signal } = {}) {
    requireTrust();
    const request = reviews.get(token);
    reviews.delete(token);
    if (!approved || !request || request.expires <= now()) throw Error('Review and approve the current WSL build before running it.');
    if (signal?.aborted) throw Error('The WSL build was cancelled before launch.');
    const reviewed = request.prepared;
    const current = await snapshot({ distribution: reviewed.distribution, workspaceRoot: reviewed.windows, system: reviewed.system, goal: reviewed.goal });
    requireTrust();
    if (signal?.aborted) throw Error('The WSL build was cancelled before launch.');
    if (request.expires <= now() || JSON.stringify(reviewed) !== JSON.stringify(current)) throw Error('The WSL build changed after review. Review it again.');
    if (active) throw Error('A managed WSL build is already running.');
    const nonce = randomUUID();
    const options = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    const group = current.storage === 'wsl' ? [runLinuxGroup, 'rocketbrain-wsl', nonce, current.linux, current.directoryIdentity]
      : [runGroup, 'rocketbrain-wsl', nonce];
    const child = start(osWslPath(platform), ['--distribution', current.distribution, '--cd', current.linux, '--exec',
      '/usr/bin/setsid', '--wait', '/bin/sh', '-c', ...group,
      '/usr/bin/timeout', '--foreground', '--kill-after=5s', '9m', ...current.command], options);
    let signalGroup;
    const groupReady = new Promise(resolve => { signalGroup = resolve; });
    const target = { distribution: current.distribution, groupReady, nonce, cancelled: false, closed: false };
    active = target;
    const chunks = [];
    let outputBytes = 0;
    let truncated = false;
    let initial = Buffer.alloc(0);
    let started = false;
    function collect(bytes) {
      const buffer = Buffer.from(bytes);
      const remaining = outputLimit - outputBytes;
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      outputBytes += Math.min(remaining, buffer.length);
      truncated ||= buffer.length > remaining;
    }
    child.stdout.on('data', bytes => {
      if (started) return collect(bytes);
      initial = Buffer.concat([initial, bytes]);
      const end = initial.indexOf(10);
      if (end === -1 && initial.length <= 1024) return;
      const claimed = initial.subarray(0, end).toString('utf8').trim().split(' ');
      if (claimed[0] !== nonce || !/^[1-9]\d{0,8}$/u.test(claimed[1]) || claimed.length !== 2) {
        collect(initial);
        initial = Buffer.alloc(0);
        started = true;
        signalGroup(null);
        return;
      }
      started = true;
      signalGroup(claimed[1]);
      collect(initial.subarray(end + 1));
      initial = Buffer.alloc(0);
    });
    child.stderr.on('data', collect);
    const onAbort = () => { void cancelActive().catch(error => collect(`\nCould not cancel the WSL process group. ${error.message}\n`)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const watchdog = setTimeout(() => cancelActive().catch(() => child.kill()), 10 * 60 * 1000);
    watchdog.unref();
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      target.closed = true;
      signalGroup(null);
      await target.cancellation?.catch(() => false);
      if (initial.length) collect(initial);
      return { distribution: current.distribution, system: current.system, goal: current.goal,
        code, cancelled: target.cancelled, output: Buffer.concat(chunks).toString('utf8'), truncated };
    } finally {
      target.closed = true;
      signalGroup(null);
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      if (active === target) active = undefined;
    }
  }

  return { distributions, mapping, openProject, review, apply, cancel: cancelActive,
    dispose() { disposed = true; reviews.clear(); void cancelActive().catch(() => {}); } };
}

module.exports = { createWslWorkbench, readWslText,
  wslBuildTasks: Object.fromEntries(Object.entries(toolSpecifications).map(([name, spec]) => [name, [...spec.goals]])) };
