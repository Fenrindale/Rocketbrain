'use strict';

const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const repository = 'Fenrindale/Rocketbrain';
const target = 'win32-x64';
const product = 'Rocketbrain Desktop';
const releaseList = `https://api.github.com/repos/${repository}/releases`;
const assetOrigin = 'https://github.com';
const assetHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const maxInstallerBytes = 1024 * 1024 * 1024;
const maxReceiptBytes = 16 * 1024;
const maxReleaseListBytes = 8 * 1024 * 1024;
const stagePrefix = 'rocketbrain-update-';
const hexDigest = /^[0-9a-f]{64}$/;
const metadataTimeout = 30_000;
const installerTimeout = 30 * 60_000;

function parseVersion(value) {
  if (typeof value !== 'string') return;
  const match = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-preview\.([1-9]\d{0,8}))?$/.exec(value);
  if (match) return { value, numbers: match.slice(1, 4).map(Number), preview: match[4] && Number(match[4]) };
}

function compareVersions(a, b) {
  for (const [index, number] of a.numbers.entries()) {
    if (number !== b.numbers[index]) return number - b.numbers[index];
  }
  return (a.preview ?? Number.MAX_SAFE_INTEGER) - (b.preview ?? Number.MAX_SAFE_INTEGER);
}

function assetInfo(assets, tag, name, limit) {
  const matches = assets.filter(asset => asset?.name === name);
  if (matches.length !== 1) throw new Error(`Release ${tag} needs one ${name} asset.`);
  const [asset] = matches;
  const url = `${assetOrigin}/${repository}/releases/download/${tag}/${name}`;
  if (asset.state !== 'uploaded' || asset.browser_download_url !== url ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit) {
    throw new Error(`The upload for ${name} has invalid release metadata.`);
  }
  const digest = asset.digest;
  if (digest != null && (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest))) {
    throw new Error(`GitHub published an invalid digest for ${name}.`);
  }
  return { name, url, bytes: asset.size, sha256: digest?.slice(7) };
}

function selectRelease(releases, installed) {
  if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list.');
  const candidates = [];
  for (const release of releases) {
    if (release?.draft !== false || typeof release.published_at !== 'string' ||
        typeof release.tag_name !== 'string' || !release.tag_name.startsWith('desktop-v')) continue;
    const version = parseVersion(release.tag_name.slice('desktop-v'.length));
    if (!version || release.prerelease !== Boolean(version.preview) ||
        Boolean(version.preview) !== Boolean(installed.preview) || compareVersions(version, installed) <= 0) continue;
    candidates.push({ release, version });
  }
  return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
}

function request(url, options) {
  return new Promise((resolve, reject) => {
    const connection = https.get(url, options, resolve);
    connection.once('error', reject);
    connection.setTimeout(20_000, () => connection.destroy(new Error('GitHub did not finish sending the update response.')));
  });
}

function isAssetRedirect(url) {
  return url.protocol === 'https:' && assetHosts.has(url.hostname) &&
    !url.port && !url.username && !url.password && !url.hash;
}

function makeUpdater(getResponse = request) {
  async function responseFrom(initialUrl, signal, asset = false) {
    let url = new URL(initialUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      signal.throwIfAborted();
      const response = await getResponse(url, {
        signal,
        headers: {
          'User-Agent': 'Rocketbrain-Desktop-Updater',
          'Accept-Encoding': 'identity',
          'Accept': asset ? 'application/octet-stream' : 'application/vnd.github+json',
          ...(!asset && { 'X-GitHub-Api-Version': '2022-11-28' }),
        },
      });
      const status = response.statusCode;
      if (status === 200) {
        if (!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity') return response;
        response.destroy();
        throw new Error('GitHub returned an unsupported update response encoding.');
      }
      response.destroy();
      if (asset && [301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        const redirect = new URL(response.headers.location, url);
        if (!isAssetRedirect(redirect)) throw new Error('GitHub redirected an update download outside its release asset service.');
        url = redirect;
        continue;
      }
      if (status === 403 || status === 429) {
        throw new Error('GitHub limited update requests. Try checking again later.');
      }
      throw new Error(`GitHub returned HTTP ${status} while checking for an update.`);
    }
    throw new Error('GitHub returned too many update redirects.');
  }

  async function jsonFrom(url, limit, signal, asset) {
    const response = await responseFrom(url, signal, Boolean(asset));
    const parts = [];
    let bytes = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > limit) throw new Error('The GitHub update response exceeded its expected size.');
      parts.push(chunk);
    }
    const contents = Buffer.concat(parts);
    if (asset && (bytes !== asset.bytes || (asset.sha256 && sha256(contents) !== asset.sha256))) {
      throw new Error('The update receipt did not match its GitHub upload.');
    }
    try {
      return JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('GitHub returned unreadable update metadata.');
    }
  }

  async function check(installedVersion, cancellation) {
    const installed = parseVersion(installedVersion);
    if (!installed) throw new Error('The installed Rocketbrain version could not be verified.');
    const signal = deadline(cancellation, metadataTimeout);
    const releases = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await jsonFrom(`${releaseList}?per_page=30&page=${page}`, maxReleaseListBytes, signal);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid release list.');
      releases.push(...batch);
      if (batch.length < 30) break;
    }
    const candidate = selectRelease(releases, installed);
    if (!candidate) return;
    const { release, version } = candidate;
    if (!Array.isArray(release.assets)) throw new Error('GitHub returned an invalid desktop release asset list.');
    const tag = release.tag_name;
    const base = `RocketbrainDesktop-${version.value}-${target}`;
    const installer = assetInfo(release.assets, tag, `${base}-setup.exe`, maxInstallerBytes);
    const receiptAsset = assetInfo(release.assets, tag, `${base}-update.json`, maxReceiptBytes);
    const receipt = await jsonFrom(receiptAsset.url, receiptAsset.bytes, signal, receiptAsset);
    const authenticode = receipt?.installer?.authenticode;
    if (receipt?.schemaVersion !== 1 || receipt.product !== product || receipt.version !== version.value ||
        receipt.target !== target || receipt.installer?.name !== installer.name ||
        receipt.installer.size !== installer.bytes || typeof receipt.installer.sha256 !== 'string' ||
        !hexDigest.test(receipt.installer.sha256) || (installer.sha256 && receipt.installer.sha256 !== installer.sha256) ||
        (authenticode !== 'signed' && !(authenticode === 'unsigned-preview' && version.preview))) {
      throw new Error(`The update receipt for ${version.value} does not match this desktop release.`);
    }
    return {
      version: version.value,
      releaseUrl: `${assetOrigin}/${repository}/releases/tag/${tag}`,
      installer: { ...installer, sha256: receipt.installer.sha256, authenticode },
    };
  }

  async function stage(candidate, directory, cancellation, onProgress) {
    const { installer } = candidate;
    const signal = deadline(cancellation, installerTimeout);
    signal.throwIfAborted();
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stageDirectory = await fsp.mkdtemp(path.join(directory, stagePrefix));
    const file = path.join(stageDirectory, installer.name);
    const cleanup = async () => {
      await fsp.unlink(file).catch(() => {});
      await fsp.rmdir(stageDirectory).catch(() => {});
    };
    try {
      const response = await responseFrom(installer.url, signal, true);
      const size = response.headers['content-length'];
      if (size !== undefined && String(installer.bytes) !== size) {
        response.destroy();
        throw new Error('The installer size did not match its release receipt.');
      }
      await pipeline(response, inspectInstaller(installer, onProgress), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
      return { file, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  return { check, stage };
}

function deadline(outer, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inspectInstaller(installer, onProgress) {
  const hash = createHash('sha256');
  let bytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > installer.bytes) {
        callback(new Error('The installer size exceeded its release receipt.'));
        return;
      }
      hash.update(chunk);
      onProgress?.(bytes);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== installer.bytes || hash.digest('hex') !== installer.sha256) {
        callback(new Error('The installer failed its SHA-256 or size verification.'));
        return;
      }
      callback();
    },
  });
}

async function verifyFile(file, installer) {
  const check = inspectInstaller(installer);
  check.resume();
  await pipeline(fs.createReadStream(file), check);
}

module.exports = { makeUpdater, parseVersion, verifyFile };
