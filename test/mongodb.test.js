'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MongoDbError, mongoTarget, parseMongoFind } = require('../src/db/mongodb');

const find = (extra = {}) => JSON.stringify({ database: 'journal', collection: 'events.2026', ...extra });

test('MongoDB local routes validate explicit authentication and separate credentials from host selection', () => {
  assert.deepEqual(mongoTarget({ host: '::1', port: 42001, username: 'reader', password: 'read password!@' }),
    { host: '::1', port: 42001, authSource: 'admin', username: 'reader', password: 'read password!@' });
  for (const config of [{ host: '127.0.0.1:27017' }, { host: 'localhost' }, { host: '192.0.2.8' }, { port: 65536 },
    { authSource: 'admin?authMechanism=none' }, { username: '' }, { password: 'a\0b' }]) {
    assert.throws(() => mongoTarget({ username: 'reader', password: 'test', ...config }), MongoDbError);
  }
});

test('MongoDB find parses native BSON scalar values, dotted paths, ordering and projections', () => {
  const result = parseMongoFind(find({ filter: { $or: [{ _id: { $oid: '66ff0123456789abcdef0011' } },
    { serial: { $gte: { $numberLong: '9007199254740993' } }, 'nested.flag': { $exists: true } }],
    created: { $date: { $numberLong: '1767323045006' } }, exact: { $numberDecimal: '12.350' },
    payload: { $binary: { base64: 'AH//', subType: '00' } }, score: 7 },
  sort: { serial: -1 }, projection: { serial: 1, created: 1, _id: 0 }, limit: 20 }));
  assert.equal(result.filter.$or[0]._id.toHexString(), '66ff0123456789abcdef0011');
  assert.equal(result.filter.$or[1].serial.$gte.toString(), '9007199254740993');
  assert.equal(result.filter.created.toISOString(), '2026-01-02T03:04:05.006Z');
  assert.equal(result.filter.exact.toString(), '12.350');
  assert.equal(result.filter.payload.buffer.toString('hex'), '007fff');
  assert.equal(result.filter.score.valueOf(), 7);
  assert.deepEqual(result.sort, { serial: -1 });
  assert.deepEqual(result.projection, { serial: 1, created: 1, _id: 0 });
  assert.equal(result.limit, 20);
});

test('MongoDB JSON validation rejects unsupported operations and bounds effort before accessing the driver', () => {
  const rejected = [find({ command: { drop: 'events' } }), find({ pipeline: [{ $out: 'events' }] }),
    find({ filter: { $where: 'return true' } }), find({ filter: { $expr: true } }),
    find({ filter: { nested: { $in: [{ $code: 'return true' }] } } }), find({ filter: { 'x.constructor': 1 } }),
    find({ filter: { x: { $exists: 1 } } }), find({ filter: { $or: [] } }), find({ filter: [{ x: 1 }] }),
    find({ filter: { x: { $numberInt: '2147483648' } } }), find({ filter: { x: { $numberLong: '9223372036854775808' } } }),
    find({ filter: { x: { $binary: { base64: '1!', subType: '00' } } } }), find({ filter: { x: Number.MAX_SAFE_INTEGER + 1 } }),
    find({ filter: { x: { $in: new Array(101).fill(1) } } }), find({ filter: { x: 'a'.repeat(65536) } }),
    find({ filter: { x: JSON.parse('['.repeat(16) + '0' + ']'.repeat(16)) } }), find({ limit: 201 }),
    find({ projection: { payload: { $slice: 3 } } }), find({ sort: { payload: { $meta: 'textScore' } } }),
    find({ collection: 'bad$special' }), find({ database: 'a'.repeat(64) }), '[1,2]', '{invalid JSON}',
    '{"database":"journal","collection":"test","filter":{"__proto__":{"polluted":true}}}'];
  for (const source of rejected) assert.throws(() => parseMongoFind(source), MongoDbError);
  assert.equal({}.polluted, undefined);
});
