'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BSON } = require('mongodb');
const { parseMongoAggregation } = require('../src/db/mongodb');

const target = { database: 'journal', collection: 'events', collectionId: '123abc00-1234-5678-aaaa-bbbbccccdddd' };
const source = (pipeline, extras) => JSON.stringify({ ...target, pipeline, ...extras });

test('MongoDB aggregation validates compound typed filters and carries supported stage order', () => {
  const input = source([{ $match: { '$or': [{ serial: { $gt: { $numberLong: '9007199254740993' } } }, { active: true }] } },
    { $group: { _id: '$type', count: { $sum: 1 }, price: { $sum: '$invoice.amount' } } }, { $sort: { count: -1 } },
    { $project: { type: '$_id', count: 1, _id: 0 } }, { $limit: 7 }]);
  const result = parseMongoAggregation(input);
  assert.equal(result.pipeline[0].$match.$or[0].serial.$gt.constructor, BSON.Long);
  assert.equal(result.pipeline[0].$match.$or[0].serial.$gt.toString(), '9007199254740993');
  assert.deepEqual(result.pipeline.slice(1).map(stage => Object.keys(stage)[0]), ['$group', '$sort', '$project', '$limit']);
  assert.equal(result.limit, 50);
  assert.equal(result.collectionId, target.collectionId);
});

test('MongoDB aggregation refuses unsafe or unbound stages and bounded-input violations', () => {
  for (const stages of [[{ $out: 'target' }], [{ $merge: { into: 'target' } }], [{ $lookup: { from: 'outside' } }],
    [{ $match: { $expr: { $eq: [1, 1] } } }], [{ $project: { n: { $function: { body: 'return 1' } } } }],
    [{ $project: { n: '$$ROOT' } }], [{ $project: { n: 0, m: 1 } }], [{ $match: {}, $sort: { n: 1 } }],
    [{ $group: { _id: '$x', f: { $accumulator: {} } } }], [{ $group: { _id: { $function: {} } } }],
    [{ $limit: 201 }], [{ $count: 'nested.n' }], [{ $sort: { n: 0 } }], [],
    Array.from({ length: 17 }, () => ({ $match: {} }))]) {
    assert.throws(() => parseMongoAggregation(source(stages)), { code: 'ROCKETBRAIN_MONGO_INPUT' });
  }
  assert.throws(() => parseMongoAggregation(source([{ $match: {} }], { collection: 'system.users' })), /ordinary/);
  assert.throws(() => parseMongoAggregation(source([{ $match: {} }], { collectionId: 'fake' })), /observed/);
  assert.throws(() => parseMongoAggregation(source([{ $match: {} }], { allowDiskUse: true })), /Use only/);
});
