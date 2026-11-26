'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { win32 } = require('node:path');
const { promisify } = require('node:util');
const { packageName } = require('../java/workbench-model');
const { openSingleJdwpRelay } = require('./ssh-java-debug');
const { wslUnc } = require('./wsl-paths');
const { worker } = require('./wsl-java-runtime');

const execute = promisify(execFile);
const maximumSource = 256 * 1024;
const sha256 = /^[a-f0-9]{64}$/u;

function linuxRelative(value, mapping, extension) {
  const file = wslUnc(value);
  if (file?.distribution !== mapping.distribution || !file.linux.startsWith(mapping.linux + '/') ||
      !file.linux.endsWith(extension)) throw Error(`Choose a physical ${extension} file in this WSL project.`);
  return file.linux.slice(mapping.linux.length + 1);
}

async function sourceSnapshot(file, relative, root) {
  const handle = await fs.open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumSource) throw Error('Choose a saved Java source up to 256 KiB.');
    const buffer = Buffer.alloc(metadata.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== metadata.size) throw Error('Java source changed while being read.');
    const content = buffer.subarray(0, used);
    const pkg = packageName(new TextDecoder('utf-8', { fatal: true }).decode(content));
    const parts = relative.split('/');
    const pkgParts = typeof pkg === 'string' && pkg ? pkg.split('.') : [];
    const head = parts.length - 1 - pkgParts.length;
    if (typeof pkg !== 'string' || head < 0 || pkgParts.some((part, index) => part !== parts[head + index])) {
      throw Error('Choose a Java source whose saved path matches its package.');
    }
    return { hash: createHash('sha256').update(content).digest('hex'), root: win32.join(root, ...parts.slice(0, head)) };
  } finally { await handle.close(); }
}

function createWslJavaDebug({ mapping, trusted, saved, onOutput = () => {}, run = execute, start = spawn }) {
  const wsl = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
  const reviews = new Map();
  let opening = false;

  function args(project, source, jar, expected) {
    const { distribution, linux, directoryIdentity } = project;
    return ['--distribution', distribution, '--exec', '/usr/bin/python3', '-I', '-c', worker,
      JSON.stringify({ linux, directoryIdentity, source, jar, expected })];
  }

  async function snapshot(input) {
    trusted();
    saved(input.sourceFile);
    const project = await mapping(input.distribution, input.projectRoot);
    if (project.storage !== 'wsl') throw Error('Open a project stored on the WSL Linux filesystem.');
    const source = linuxRelative(input.sourceFile, project, '.java');
    const jar = linuxRelative(input.jarFile, project, '.jar');
    const local = await sourceSnapshot(input.sourceFile, source, project.windows);
    let proof;
    try {
      const result = await run(wsl, args(project, source, jar), { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4096 });
      proof = JSON.parse(result.stdout);
    } catch {
      throw Error('WSL could not read the selected Java source, runnable JAR and JDK. Check the selected files and Linux Java and Python installations.');
    }
    if (!['source', 'jar', 'runtime', 'release'].every(field => sha256.test(proof?.[field])) ||
        typeof proof?.java !== 'string' || !proof.java.startsWith('/') || proof.source !== local.hash) {
      throw Error('Windows and WSL did not observe the same saved Java source and reviewed launch inputs.');
    }
    return { project, sourceRoot: local.root, source, jar, proof };
  }

  return {
    async review(input) {
      const reviewed = await snapshot(input);
      const token = randomUUID();
      const expires = Date.now() + 90000;
      for (const [id, item] of reviews) if (item.expires <= Date.now()) reviews.delete(id);
      if (reviews.size >= 16) reviews.delete(reviews.keys().next().value);
      reviews.set(token, { input: { ...input }, reviewed, expires });
      return { token, expires, distribution: reviewed.project.distribution, linux: reviewed.project.linux,
        source: reviewed.source, jar: reviewed.jar, jarSha256: reviewed.proof.jar, java: reviewed.proof.java };
    },
    async open(root, confirmation) {
      trusted();
      const review = reviews.get(confirmation.token);
      if (confirmation.allowLoopbackAccess !== true || !review || review.expires <= Date.now() ||
          root !== review.input.projectRoot || confirmation.sourceFile !== review.input.sourceFile) {
        throw Error('Approve the current WSL Java debug launch review.');
      }
      if (opening) throw Error('Wait for the in-progress WSL Java debugger launch.');
      opening = true;
      reviews.delete(confirmation.token);
      let relay;
      try {
        const current = await snapshot(review.input);
        if (JSON.stringify(current) !== JSON.stringify(review.reviewed)) {
          throw Error('The reviewed WSL Java project, source, JAR or JDK changed after review.');
        }
        const child = start(wsl, args(current.project, current.source, current.jar, current.proof),
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr.on('data', data => onOutput(data.toString('utf8')));
        relay = await openSingleJdwpRelay(child, async () => {
          trusted();
          saved(review.input.sourceFile);
          const local = await sourceSnapshot(review.input.sourceFile, current.source, current.project.windows);
          if (local.hash !== current.proof.source) throw Error('The WSL Java source changed before attach.');
        }, 'WSL');
        trusted();
        return { ...relay, id: randomUUID(), sourceFile: review.input.sourceFile, sourceRoot: current.sourceRoot,
          wslRoot: current.project.linux };
      } catch (error) {
        await relay?.close();
        throw error;
      } finally { opening = false; }
    },
    clear() { reviews.clear(); }
  };
}

module.exports = { createWslJavaDebug };
