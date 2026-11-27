'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { makeUpdater, verifyFile } = require('../src/desktop-updater');

const repo = 'https://github.com/Fenrindale/Rocketbrain';
const assetCdn = 'https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/fake';
const contents = Buffer.from('Windows installer test bytes');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function upload(tag, name, bytes) {
  return {
    name,
    state: 'uploaded',
    size: bytes.length,
    digest: `sha256:${digest(bytes)}`,
    browser_download_url: `${repo}/releases/download/${tag}/${name}`,
  };
}

function release(version, signature = 'unsigned-preview', adjustReceipt = () => {}) {
  const tag = `desktop-v${version}`;
  const assetBase = `RocketbrainDesktop-${version}-win32-x64`;
  const installer = upload(tag, `${assetBase}-setup.exe`, contents);
  const receipt = {
    schemaVersion: 1,
    product: 'Rocketbrain Desktop',
    version,
    target: 'win32-x64',
    installer: {
      name: installer.name,
      size: installer.size,
      sha256: digest(contents),
      authenticode: signature,
    },
  };
  adjustReceipt(receipt);
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const receiptAsset = upload(tag, `${assetBase}-update.json`, receiptBytes);
  return {
    installer,
    receipt: receiptAsset,
    receiptBytes,
    metadata: {
      tag_name: tag,
      draft: false,
      prerelease: version.includes('-preview.'),
      published_at: '2026-11-27T12:00:00Z',
      assets: [receiptAsset, installer],
    },
  };
}

function response(body = Buffer.alloc(0), statusCode = 200, headers = {}) {
  return Object.assign(Readable.from([body]), { statusCode, headers });
}

function transport(candidates, options = {}) {
  const requests = [];
  const updater = makeUpdater((url, request) => {
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.headers.Cookie, undefined);
    requests.push(url.href);
    if (url.href === 'https://api.github.com/repos/Fenrindale/Rocketbrain/releases?per_page=30&page=1') {
      return response(Buffer.from(JSON.stringify(candidates.map(candidate => candidate.metadata))));
    }
    const receipt = candidates.find(candidate => candidate.receipt.browser_download_url === url.href);
    if (receipt) return response(receipt.receiptBytes);
    if (candidates.some(candidate => candidate.installer.browser_download_url === url.href)) {
      return response(undefined, 302, { location: options.redirect || assetCdn });
    }
    if (url.href === assetCdn) {
      return options.download?.() || response(contents, 200, { 'content-length': String(contents.length) });
    }
    throw new Error(`Unexpected update URL ${url.href}`);
  });
  return { updater, requests };
}

async function stageDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-updater-test-'));
  t.after(async () => fsp.rmdir(directory));
  return directory;
}

test('preview check uses only same-channel upgrades and retrieves receipt without downloading installer', async () => {
  const preview10 = release('1.2.0-preview.10');
  const draft = release('3.0.0-preview.1');
  draft.metadata.draft = true;
  const malformed = release('4.0.0-preview.1');
  malformed.metadata.prerelease = false;
  const { updater, requests } = transport([
    release('1.2.0-preview.2'), preview10, draft, malformed, release('5.1.0', 'signed'), release('0.1.0-preview.1'),
  ]);
  const candidate = await updater.check('1.2.0-preview.1');
  assert.equal(candidate.version, '1.2.0-preview.10');
  assert.equal(candidate.installer.authenticode, 'unsigned-preview');
  assert.equal(requests.length, 2);
  assert.equal(requests[1], preview10.receipt.browser_download_url);
  assert.equal(await updater.check('1.2.0-preview.10'), undefined);
});

test('stable updates exclude preview and require a signed Windows installer receipt', async () => {
  const stable = release('1.1.0', 'signed');
  const unsigned = release('1.2.0');
  assert.equal((await transport([release('2.0.0-preview.1'), stable]).updater.check('1.0.0')).version, '1.1.0');
  await assert.rejects(transport([unsigned]).updater.check('1.0.0'), /does not match this desktop release/);
});

test('the receipt and GitHub asset fingerprint must match the pinned installer path and size', async () => {
  const wrongHash = release('1.0.1-preview.1', 'unsigned-preview', receipt => {
    receipt.installer.sha256 = '0'.repeat(64);
  });
  const offsite = release('1.0.1-preview.2');
  offsite.installer.browser_download_url = 'https://example.com/setup.exe';
  const changedReceipt = release('1.0.1-preview.3');
  changedReceipt.receipt.digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(transport([wrongHash]).updater.check('1.0.0-preview.1'), /does not match this desktop release/);
  await assert.rejects(transport([offsite]).updater.check('1.0.0-preview.1'), /invalid release metadata/);
  await assert.rejects(transport([changedReceipt]).updater.check('1.0.0-preview.1'), /did not match its GitHub upload/);
});

test('a checked installer stages via the pinned GitHub CDN and re-verification detects tampering', async t => {
  const directory = await stageDirectory(t);
  const { updater, requests } = transport([release('1.1.0-preview.1')]);
  const candidate = await updater.check('1.0.0-preview.1');
  const staged = await updater.stage(candidate, directory);
  try {
    assert.equal(requests.at(-1), assetCdn);
    assert.deepEqual(await fsp.readFile(staged.file), contents);
    await verifyFile(staged.file, candidate.installer);
    await fsp.writeFile(staged.file, Buffer.alloc(contents.length));
    await assert.rejects(verifyFile(staged.file, candidate.installer), /failed its SHA-256/);
  } finally {
    await staged.cleanup();
  }
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('offsite redirects, oversized files, checksum failures and cancellation never leave an installer', async t => {
  const directory = await stageDirectory(t);
  const cases = [
    [{ redirect: 'https://release-assets.githubusercontent.com.example.org/setup.exe' }, /outside its release asset service/],
    [{ download: () => response(Buffer.alloc(contents.length + 1)) }, /exceeded its release receipt/],
    [{ download: () => response(Buffer.alloc(contents.length)) }, /failed its SHA-256/],
    [{}, /aborted/],
  ];
  const candidateRelease = release('1.1.0-preview.1');
  for (const [options, expected] of cases) {
    const { updater } = transport([candidateRelease], options);
    const candidate = await updater.check('1.0.0-preview.1');
    const controller = new AbortController();
    const progress = Object.keys(options).length ? undefined : () => controller.abort();
    await assert.rejects(updater.stage(candidate, directory, controller.signal, progress), expected);
    assert.deepEqual(await fsp.readdir(directory), []);
  }
});
