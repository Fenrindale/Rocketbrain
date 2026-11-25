'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');

const run = promisify(execFile);
const maxChanges = 2000;
const maxPath = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function supportedPath(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxPath &&
    !/[\\:\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every(segment => segment && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}

function decode(bytes) {
  try { return decoder.decode(bytes); }
  catch { throw Error('Git returned file names that cannot be decoded as UTF-8.'); }
}

function parseStatus(bytes) {
  if (!bytes.length) return { changes: [], omitted: 0 };
  const fields = decode(bytes).split('\0');
  if (fields.pop() !== '') throw Error('Git returned an incomplete status record. Refresh changelists.');
  const byPath = new Map();
  let omitted = 0, count = 0;
  for (let index = 0; index < fields.length; index++) {
    const item = fields[index], status = item.slice(0, 2);
    if (++count > maxChanges) throw Error('The worktree exceeds 2,000 changed paths. Narrow the repository before grouping changes.');
    if (item[2] !== ' ' || !/^(?:[ MTADRCU]{2}|\?\?)$/.test(status) || status === '  ') {
      throw Error('Git returned an unrecognized status record. Refresh changelists.');
    }
    const name = item.slice(3), renamed = /[RC]/.test(status);
    const from = renamed ? fields[++index] : undefined;
    if (renamed && from === undefined) throw Error('Git returned an incomplete rename record. Refresh changelists.');
    if (!supportedPath(name) || renamed && !supportedPath(from)) { omitted++; continue; }
    const previous = byPath.get(name);
    if (previous) {
      if (!previous.statuses.includes(status)) previous.statuses.push(status);
      if (renamed) previous.previousPath = from;
    } else {
      byPath.set(name, { path: name, statuses: [status], ...(renamed ? { previousPath: from } : {}) });
    }
  }
  return { changes: [...byPath.values()], omitted };
}

async function gitRead(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  try {
    const platform = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
    const { stdout } = await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...platform, ...args],
      { cwd, env, windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('Install Git on the extension host PATH to use changelists.');
    if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('Git status exceeded its time or size limit.');
    if (args[0] === 'rev-parse' && Buffer.isBuffer(error.stderr) && /not a git repository/i.test(error.stderr.toString('utf8'))) return null;
    throw Error('Git could not inspect this repository. Check the local working tree and permissions.');
  }
}

async function inspectRepository(directory, workspaceRoot) {
  const candidate = await fs.realpath(directory), workspace = await fs.realpath(workspaceRoot);
  if (!inside(workspace, candidate)) throw Error('Choose a Git repository inside an open workspace folder.');
  const marker = await gitRead(candidate, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (marker === null) return null;
  const [top, gitDirectory, ...extra] = decode(marker).replace(/\r?\n$/, '').split(/\r?\n/);
  if (extra.length || !path.isAbsolute(top) || !path.isAbsolute(gitDirectory || '')) throw Error('Git did not identify a local working tree.');
  const root = await fs.realpath(top), git = await fs.realpath(gitDirectory);
  if (!inside(workspace, root)) return null;
  const identity = await fs.stat(git);
  if (!identity.isDirectory()) throw Error('The Git metadata directory is unavailable.');
  const key = createHash('sha256').update(JSON.stringify([root, git, identity.dev, identity.ino, identity.birthtimeMs])).digest('hex');
  return { root, key };
}

async function observeChanges(repo) {
  return parseStatus(await gitRead(repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--renames']));
}

module.exports = { gitRead, inspectRepository, observeChanges, parseStatus, supportedPath, inside, maxChanges };
