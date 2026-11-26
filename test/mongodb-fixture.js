'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { BSON, MongoClient } = require('mongodb');

const sample = { database: 'rb_mongo', extra: 'rb_mongo_extra', hidden: 'rb_mongo_hidden', collection: 'events',
  view: 'active_events', id: '66ff0123456789abcdef0011', serial: '9007199254740993', stamp: '2026-01-02T03:04:05.006Z' };

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

function fixtureClient(port, auth, tls) {
  return new MongoClient('mongodb://' + (tls?.host || '127.0.0.1') + ':' + port, { directConnection: true, auth, authSource: 'admin',
    authMechanism: auth && 'SCRAM-SHA-256', serverSelectionTimeoutMS: 1500, socketTimeoutMS: 4000, maxPoolSize: 1, retryWrites: false,
    ...(tls && { tls: true, tlsCAFile: tls.caPath, family: 4 }) });
}

async function startMongoFixture(bin, { tls, edits = false } = {}) {
  if (!path.isAbsolute(bin) || !/^mongod(?:\.exe)?$/i.test(path.basename(bin))) {
    throw Error('Select the absolute mongod executable path for the disposable fixture.');
  }
  bin = await fs.realpath(bin);
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rocketbrain-mongo-'));
  const marker = path.join(root, 'fixture-owner');
  const ownership = randomUUID();
  const data = path.join(root, 'data');
  const log = path.join(root, 'mongod.log');
  let child, administrator, adminReady = false;
  let exited, exitState;
  await fs.writeFile(marker, ownership, { flag: 'wx' });

  async function stop() {
    if (administrator && adminReady && !exitState) {
      await administrator.db('admin').command({ shutdown: 1, force: true }).catch(() => {});
    }
    await administrator?.close().catch(() => {});
    if (child && !exitState) {
      await Promise.race([exited, delay(2000, undefined, { ref: false })]);
      if (!exitState) child.kill();
      await Promise.race([exited, delay(4000, undefined, { ref: false })]);
    }
    if (child && !exitState) throw Error('The owned MongoDB test child did not stop.');
    const resolved = await fs.realpath(root);
    if (path.dirname(resolved) !== parent || resolved !== root || !path.basename(root).startsWith('rocketbrain-mongo-') ||
      await fs.readFile(marker, 'utf8') !== ownership) throw Error('MongoDB fixture cleanup ownership changed.');
    await fs.rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }

  try {
    const port = await freePort();
    await fs.mkdir(data);
    const adminAuth = { username: 'rb_fixture_admin', password: randomBytes(32).toString('base64url') };
    const readerAuth = { username: 'rb_fixture_reader', password: randomBytes(32).toString('base64url') };
    const writerAuth = edits ? { username: 'rb_fixture_editor', password: randomBytes(32).toString('base64url') } : null;
    child = spawn(bin, ['--auth', '--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', data,
      '--logpath', log, '--setParameter', 'diagnosticDataCollectionEnabled=false', '--wiredTigerCacheSizeGB', '0.25',
      ...(tls ? ['--tlsMode', 'requireTLS', '--tlsCertificateKeyFile', tls.serverPem, '--tlsCAFile', tls.caPath,
        '--tlsAllowConnectionsWithoutCertificates'] : [])],
    { windowsHide: true, shell: false, stdio: 'ignore' });
    exited = new Promise(resolve => {
      child.once('error', error => { exitState = error.code ?? 'start-failure'; resolve(); });
      child.once('exit', (code, signal) => { exitState = String(code ?? signal); resolve(); });
    });
    const until = Date.now() + 20000;
    let listening = false;
    while (!exitState && Date.now() < until) {
      const lines = await fs.readFile(log, 'utf8').catch(() => '');
      if (lines.includes('Waiting for connections')) { listening = true; break; }
      await delay(100);
    }
    if (!listening || exitState) {
      const messages = (await fs.readFile(log, 'utf8').catch(() => '')).split(/\r?\n/).flatMap(line => {
        try {
          const entry = JSON.parse(line);
          return ['E', 'F'].includes(entry.s) ? [entry.msg, entry.attr?.error?.errmsg].filter(value => typeof value === 'string') : [];
        } catch { return []; }
      });
      throw Error(`The owned MongoDB test child failed to listen (${exitState ?? 'time limit'}). ${messages.join(' ').slice(-800)}`);
    }
    const bootstrap = fixtureClient(port, undefined, tls);
    try {
      // MongoDB's localhost exception permits only this first user on the new auth-enabled data directory.
      await bootstrap.db('admin').command({ createUser: adminAuth.username, pwd: adminAuth.password,
        roles: ['root'], mechanisms: ['SCRAM-SHA-256'] });
    } finally { await bootstrap.close(); }
    administrator = await fixtureClient(port, adminAuth, tls).connect();
    adminReady = true;
    const build = await administrator.db('admin').command({ buildInfo: 1 });
    await administrator.db('admin').command({ createUser: readerAuth.username, pwd: readerAuth.password,
      mechanisms: ['SCRAM-SHA-256'], roles: [sample.database, sample.extra].map(db => ({ db, role: 'read' })) });
    if (writerAuth) await administrator.db('admin').command({ createUser: writerAuth.username, pwd: writerAuth.password,
      mechanisms: ['SCRAM-SHA-256'], roles: [{ db: sample.database, role: 'readWrite' }] });

    const source = administrator.db(sample.database);
    await source.collection(sample.collection).insertMany([
      { _id: new BSON.ObjectId(sample.id), rank: 2, active: true, text: '한국어 데이터',
        serial: BSON.Long.fromString(sample.serial), price: BSON.Decimal128.fromString('20.50'),
        created: new Date(sample.stamp), nested: { tags: ['blue', null], raw: new BSON.Binary(Buffer.from([0, 127, 255])) } },
      { rank: 1, active: false, text: null }, { rank: 3, active: true }
    ]);
    await source.createCollection(sample.view, { viewOn: sample.collection, pipeline: [{ $match: { active: true } }] });
    await source.collection('wide').insertOne({ text: 'a'.repeat(270000) });
    await source.collection('budget').insertMany(Array.from({ length: 7 }, (_, index) => ({ index, text: 'z'.repeat(200000) })));
    await source.collection('stale_target').insertOne({ generation: 1 });
    const editObjectId = new BSON.ObjectId(sample.id), editCollection = source.collection('edit_identity');
    if (edits) await editCollection.insertOne({ _id: editObjectId, name: 'original' });
    await administrator.db(sample.extra).collection('nested').insertOne({ n: 1 });
    await administrator.db(sample.hidden).collection('secret').insertOne({ n: 2 });
    const config = { host: '127.0.0.1', port, authSource: 'admin', ...readerAuth };
    async function readerWriteDenied() {
      const reader = fixtureClient(port, readerAuth, tls);
      try {
        await reader.db(sample.database).collection(sample.collection).insertOne({ rank: 100 });
        return false;
      } catch (error) { return error.code === 13; }
      finally { await reader.close(); }
    }
    async function replaceAggregationTarget() {
      await source.collection('stale_target').drop();
      await source.collection('stale_target').insertOne({ generation: 2 });
    }
    async function readerRejectsStaleAggregationIdentity(uuid) {
      const reader = fixtureClient(port, readerAuth, tls);
      try {
        await reader.db(sample.database).command({ aggregate: 'stale_target', collectionUUID: new BSON.UUID(uuid),
          pipeline: [{ $match: {} }], cursor: {}, allowDiskUse: false });
        return false;
      } catch (error) { return error.code === 361; }
      finally { await reader.close(); }
    }
    const editFixture = edits && {
      config: { ...config, ...writerAuth },
      collection: 'edit_identity',
      updateObservedField: (field, value) => source.collection(sample.collection).updateOne({ _id: editObjectId }, { $set: { [field]: value } }),
      changeValidator: () => source.command({ collMod: sample.collection, validator: { rank: { $type: 'int' } } }),
      async replaceSameDocumentCollection() {
        await editCollection.drop();
        await editCollection.insertOne({ _id: editObjectId, name: 'original' });
      },
      async rejectOldCollectionUuid(uuid) {
        const writer = fixtureClient(port, writerAuth, tls);
        try {
          const result = await writer.db(sample.database).command({ update: editCollection.collectionName,
            collectionUUID: new BSON.UUID(uuid), updates: [{ q: { _id: editObjectId, name: 'original' },
              u: { $set: { name: 'must-not-write' } }, multi: false, upsert: false }], writeConcern: { w: 1, j: true } });
          return result.writeErrors?.[0]?.code === 361;
        } catch (error) { return error.code === 361; }
        finally { await writer.close(); }
      }
    };
    return { sample, config, version: build.version, readerWriteDenied, replaceAggregationTarget,
      readerRejectsStaleAggregationIdentity, ...(editFixture && { editFixture }), stop };
  } catch (error) {
    await stop();
    const reason = error?.code ? ' (driver code ' + error.code + ')' : '';
    if (error.message.startsWith('The owned MongoDB test child failed to listen')) throw error;
    throw Error('Unable to initialize the disposable MongoDB fixture' + reason + '.');
  }
}

module.exports = { startMongoFixture };
