'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const benchmarks = new Set(['tpch', 'tpcds']);
const repository = 'https://extensions.duckdb.org';
const maxDownload = 40 * 1024 * 1024;
const memoryArgs = ['-batch', '-bail', '-no-init', '-json', ':memory:'];
const noAutomaticExtensions = 'SET autoload_known_extensions=false; SET autoinstall_known_extensions=false;';

function sqlPath(file) {
  if (/[\x00-\x1f]/.test(file)) throw Error('Choose a local path without control characters.');
  const normalized = process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
  return "'" + normalized.replaceAll("'", "''") + "'";
}

async function checkedFile(directory, name) {
  const candidate = path.join(directory, name);
  try {
    const metadata = await fs.lstat(candidate);
    if (!metadata.isFile() || await fs.realpath(candidate) !== candidate) throw Error('Unexpected DuckDB extension file location.');
    return candidate;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function download(file, url, signal) {
  const deadline = AbortSignal.timeout(25000);
  const cancellation = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const response = await fetch(url, { redirect: 'error', signal: cancellation });
  if (!response.ok || !response.body) throw Error('The official DuckDB extension download failed.');
  let bytes = 0;
  const bound = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxDownload) return callback(Error('The DuckDB extension archive exceeds 40 MiB.'));
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    { signal: cancellation });
}

function createExtensionManager({ directory, version, read }) {
  let platform;
  let active;
  let changing = false;

  async function storage(options) {
    if (!directory) throw Error('Open a trusted folder with local workspace storage before managing DuckDB extensions.');
    if (!platform) {
      const [native] = await read(memoryArgs, 'PRAGMA platform', options);
      if (typeof native?.platform !== 'string' || !/^[a-z0-9_]{3,48}$/.test(native.platform)) {
        throw Error('The DuckDB client returned an invalid platform identifier.');
      }
      platform = native.platform;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(directory);
    if (/^\\\\/.test(root)) throw Error('DuckDB extension storage must be local.');
    const expected = path.join(root, 'v' + version + '-' + platform);
    await fs.mkdir(expected, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await fs.realpath(expected) !== expected) throw Error('Unexpected DuckDB extension directory.');
    return expected;
  }

  const binary = name => name + '.duckdb_extension';
  const managed = (entry, installed) => ({ ...entry, installed, loaded: active?.name === entry.name,
    version: installed ? version : '', mode: installed ? 'WORKSPACE_CORE' : 'NOT_INSTALLED', managed: true });

  async function inventory(options) {
    const installedAt = directory ? await storage(options) : undefined;
    const config = installedAt ? `SET extension_directories=[${sqlPath(installedAt)}];` : '';
    const observed = await read(memoryArgs, `${noAutomaticExtensions} ${config}
      SELECT extension_name AS name, loaded, installed, extension_version AS version,
        install_mode AS mode, LEFT(description, 512) AS description FROM duckdb_extensions() ORDER BY name LIMIT 101`, options);
    return Promise.all(observed.map(async item => {
      if (!benchmarks.has(item.name) || item.mode === 'STATICALLY_LINKED' || !installedAt) return item;
      return managed(item, Boolean(await checkedFile(installedAt, binary(item.name))));
    }));
  }

  async function install(name, installedAt, options) {
    const workspace = await fs.mkdtemp(path.join(installedAt, 'stage-'));
    try {
      const archive = path.join(workspace, binary(name) + '.gz');
      await download(archive, `${repository}/v${version}/${platform}/${binary(name)}.gz`, options?.signal);
      const [verified] = await read(memoryArgs, `${noAutomaticExtensions}
        SET extension_directories=[${sqlPath(workspace)}]; INSTALL ${sqlPath(archive)}; LOAD ${name};
        SELECT loaded, install_path FROM duckdb_extensions() WHERE extension_name='${name}'`, options);
      const stagedParent = path.join(workspace, 'v' + version, platform);
      if (verified?.loaded !== true || path.resolve(verified.install_path ?? '') !== path.join(stagedParent, binary(name)) ||
          await fs.realpath(stagedParent) !== stagedParent) throw Error('DuckDB did not verify the official extension in staging.');
      const source = await checkedFile(stagedParent, binary(name));
      if (!source) throw Error('DuckDB did not produce an installed extension.');
      await checkedFile(installedAt, binary(name));
      options?.signal?.throwIfAborted();
      await fs.rename(source, path.join(installedAt, binary(name)));
    } finally {
      if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === installedAt) {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    }
  }

  async function manage(name, action, options) {
    if (!benchmarks.has(name)) throw Error('Choose a supported official DuckDB benchmark extension.');
    if (changing) throw Error('Wait for the current DuckDB extension action.');
    changing = true;
    try {
      const destination = await storage(options);
      const native = (await inventory(options)).find(item => item.name === name);
      if (!native?.managed) throw Error('This DuckDB build does not expose a manageable installation for that extension.');
      const file = await checkedFile(destination, binary(name));
      options?.signal?.throwIfAborted();
      if (action === 'install' || action === 'update') {
        if (Boolean(file) !== (action === 'update')) throw Error('The DuckDB extension installation changed. Refresh the inventory.');
        await install(name, destination, options);
        return managed(native, true);
      } else if (action === 'enable' && file) {
        await read(memoryArgs, `${noAutomaticExtensions} LOAD ${sqlPath(file)}; SELECT 1 AS verified`, options);
        options?.signal?.throwIfAborted();
        active = { name, file };
      } else if (action === 'disable' && active?.name === name) {
        active = undefined;
      } else if (action === 'remove' && file) {
        if (active?.name === name) throw Error('Disable the selected DuckDB extension before removing it.');
        await fs.unlink(file);
      } else {
        throw Error('The selected DuckDB extension action is unavailable.');
      }
      return managed(native, action !== 'remove');
    } finally { changing = false; }
  }

  return { inventory, manage, load: () => active ? `${noAutomaticExtensions} LOAD ${sqlPath(active.file)};` : '' };
}

module.exports = { createExtensionManager };
