'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRowSpool } = require('./table-transfer-spool');
const { streamLimits } = require('./table-transfer-snapshot');
const { destinationSummary } = require('./table-transfer-verification');
const { closeEvidence, openEvidence, readMarker, fileIdentity, sameIdentity, legacyCommitMarker } = require('./table-transfer-commit-marker');

const recoveryLifetimeMs = 24 * 60 * 60 * 1000;
const maxSaved = 3;
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_TABLE_TRANSFER' });
const missing = error => { if (error.code !== 'ENOENT') throw error; };
const attributes = ['id', 'expiresAt', 'database', 'table', 'scope', 'engine', 'columns', 'omittedColumns', 'maxBufferedRows'];
const fullAvailable = evidence => evidence?.version === 3 && Array.isArray(evidence.keys) &&
  evidence.keys.length > 0 && evidence.keys.every(index => Number.isInteger(index) && index >= 0);

function createTransferRecovery({ storagePath, secrets, isTrusted }) {
  if (!storagePath || !secrets) return null;
  const root = path.join(path.resolve(storagePath), 'table-copy-snapshots');
  const scope = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const secretKey = id => 'rocketbrain.tableCopy.snapshot.v1.' + scope + '.' + id;
  const files = id => {
    if (!idPattern.test(id)) throw fail('Choose a saved table snapshot.');
    const directory = path.join(root, id);
    return { directory, marker: path.join(directory, 'commit.intent') };
  };
  const trusted = () => {
    if (!isTrusted()) throw fail('Open the trusted workspace that saved the table snapshot.');
  };
  async function ownedDirectory(directory) {
    const stat = await fs.lstat(directory).catch(missing);
    if (stat && !stat.isDirectory()) throw fail('The saved table snapshot directory is unavailable.');
    return stat;
  }

  async function discard(id, { skipTrust = false } = {}) {
    if (!skipTrust) trusted();
    const { directory } = files(id);
    if (!(await ownedDirectory(root))) return false;
    if (!(await ownedDirectory(directory))) return false;
    const removed = path.join(root, '.discard-' + randomUUID());
    // Retire the original path before removing a commit marker. An older host can no longer commit from it.
    await fs.rename(directory, removed);
    await secrets.delete(secretKey(id));
    for (const name of ['rows.bin', 'commit.intent']) await fs.unlink(path.join(removed, name)).catch(missing);
    await fs.rmdir(removed);
    return true;
  }

  async function record(id) {
    const { directory, marker } = files(id);
    const stat = await ownedDirectory(directory);
    if (!stat) return {};
    const raw = await secrets.get(secretKey(id));
    if (!raw) return { stat };
    let item;
    try { item = JSON.parse(raw); }
    catch { return { stat }; }
    if (item.version !== 1 || item.metadata?.id !== id || !Array.isArray(item.metadata.columns) ||
        !Number.isSafeInteger(item.metadata.expiresAt) || !item.recovery?.sealed) return { stat };
    const blocked = item.state === 'settlement-unconfirmed' || Boolean(await fs.lstat(marker).catch(missing));
    return { stat, item, blocked };
  }

  async function ready(id) {
    trusted();
    if (!(await ownedDirectory(root))) throw fail('The saved table snapshot is unavailable.');
    const { item, blocked } = await record(id);
    if (!item || item.metadata.expiresAt <= Date.now()) throw fail('The saved table snapshot expired or is unavailable.');
    if (blocked) throw fail('A previous Commit may have reached the destination. Check its rows before discarding this saved snapshot.');
    return item;
  }

  async function uncertain(id) {
    trusted();
    if (!(await ownedDirectory(root))) throw fail('The saved table snapshot is unavailable.');
    const { item, blocked, stat } = await record(id);
    if (!item || item.metadata.expiresAt <= Date.now()) throw fail('The saved table snapshot expired or is unavailable.');
    if (!blocked) throw fail('This snapshot has no unconfirmed Commit.');
    return { item, directoryIdentity: fileIdentity(stat), ...(await boundEvidence(id, item)) };
  }

  async function boundEvidence(id, item) {
    const path = files(id).marker;
    try {
      const marker = await readMarker(path);
      let evidence;
      if (marker && !marker.bytes.equals(legacyCommitMarker)) evidence = openEvidence(item, marker.bytes, scope);
      else if (item.commitEvidence?.version !== 3 && (marker || !await fs.lstat(path).catch(missing))) evidence = item.commitEvidence;
      if (!evidence || evidence.sourceHash !== item.recovery.sealed.sourceHash || evidence.rowCount !== item.recovery.sealed.rowCount) return {};
      return { evidence, ...(evidence.version === 3 && { marker: { identity: marker.identity, digest: marker.digest } }) };
    } catch { return {}; }
  }

  async function openSpool(id, { metadata, recovery }) {
    trusted();
    return createRowSpool({ columns: metadata.columns, maxRows: streamLimits.rows, maxRowBytes: streamLimits.rowBytes,
      maxBytes: streamLimits.bytes, directory: files(id).directory, recovery });
  }

  async function inventory() {
    trusted();
    if (!(await ownedDirectory(root))) return { occupied: 0, sources: [] };
    const entries = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && idPattern.test(entry.name));
    const sources = [];
    let occupied = entries.length;
    for (const entry of entries) {
      const { stat, item, blocked } = await record(entry.name);
      if (!stat) { occupied--; continue; }
      const expiresAt = item?.metadata.expiresAt ?? stat.birthtimeMs + recoveryLifetimeMs;
      if (expiresAt <= Date.now()) {
        if (await discard(entry.name)) occupied--;
        continue;
      }
      if (item) {
        const { evidence } = blocked ? await boundEvidence(entry.name, item) : {};
        sources.push({ ...item.metadata, ...item.recovery.sealed, directory: undefined,
          recoveryState: blocked ? 'settlement-unconfirmed' : 'ready',
          ...(blocked && { verificationTarget: destinationSummary(evidence), fullVerificationAvailable: fullAvailable(evidence) }) });
      }
    }
    return { occupied, sources: sources.sort((a, b) => b.expiresAt - a.expiresAt) };
  }

  return {
    async reserve(id) {
      if ((await inventory()).occupied >= maxSaved) throw fail('Discard a saved table snapshot before capturing another.');
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await ownedDirectory(root);
      const { directory } = files(id);
      trusted();
      await fs.mkdir(directory, { mode: 0o700 });
      return directory;
    },
    async save(capture) {
      trusted();
      const metadata = Object.fromEntries(attributes.map(name => [name, capture[name]]));
      await secrets.store(secretKey(capture.id), JSON.stringify({ version: 1, metadata, recovery: capture.spool.recoveryRecord() }));
    },
    async list() { return (await inventory()).sources; },
    assertReady: ready,
    async resume(id) {
      const item = await ready(id);
      const { metadata, recovery } = item;
      const spool = await openSpool(id, item);
      return { ...metadata, ...recovery.sealed, recoveryState: 'ready', spool };
    },
    async uncertainCommit(id) {
      return (await uncertain(id)).evidence;
    },
    async describeUncertainSource(id) {
      trusted();
      if (!(await ownedDirectory(root))) return;
      const { item, blocked } = await record(id);
      if (item && blocked && item.metadata.expiresAt > Date.now()) {
        const { evidence } = await boundEvidence(id, item);
        return { expiresAt: item.metadata.expiresAt, fullVerificationAvailable: fullAvailable(evidence) };
      }
    },
    async inspectUncertainSource(id) {
      const { item, evidence, marker, directoryIdentity } = await uncertain(id);
      return {
        evidence, columns: item.metadata.columns, expiresAt: item.metadata.expiresAt,
        async scan(callbacks) {
          const spool = await openSpool(id, item);
          try { return await spool.scan(callbacks); }
          finally { await spool.dispose(); }
        },
        async assertCurrent() {
          const paths = files(id);
          let current, directory;
          try {
            trusted();
            if (marker && item.metadata.expiresAt > Date.now() && await ownedDirectory(root)) {
              current = await readMarker(paths.marker);
              directory = await ownedDirectory(paths.directory);
              trusted();
            }
          } catch { /* Unavailable evidence cannot attest this verification. */ }
          if (!current || item.metadata.expiresAt <= Date.now() || !sameIdentity(fileIdentity(directory), directoryIdentity) ||
              !sameIdentity(current.identity, marker.identity) || current.digest !== marker.digest) {
            throw Object.assign(fail('The retained evidence changed during the destination check.'),
              { verificationReason: 'retained-evidence-changed' });
          }
        }
      };
    },
    async beginCommit(id, commitEvidence) {
      const item = await ready(id);
      const { marker } = files(id);
      trusted();
      const evidenceBytes = closeEvidence(item, commitEvidence, scope);
      let file;
      try { file = await fs.open(marker, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw fail('A previous Commit may have reached the destination. Check its rows before repeating this copy.');
        throw error;
      }
      try { await file.writeFile(evidenceBytes); await file.sync(); }
      finally { await file.close(); }
      await secrets.store(secretKey(id), JSON.stringify({ ...item, state: 'settlement-unconfirmed', commitEvidence }));
    },
    discard
  };
}

module.exports = { createTransferRecovery, recoveryLifetimeMs };
