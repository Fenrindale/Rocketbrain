'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mongoTarget, parseMongoEditValue } = require('../src/db/mongodb');

test('MongoDB editing requires an explicit boolean connection opt-in', () => {
  const fixture = { username: 'fixture', password: 'ephemeral', host: '127.0.0.1' };
  for (const reviewedEdits of [false, undefined, 'true', 1]) {
    assert.equal(mongoTarget({ ...fixture, reviewedEdits }).reviewedEdits, undefined);
  }
  assert.equal(mongoTarget({ ...fixture, reviewedEdits: true }).reviewedEdits, true);
});

test('MongoDB edit literals preserve null, Unicode, booleans and exact BSON integer width', () => {
  assert.deepEqual(parseMongoEditValue('null'), { type: 'null', value: null });
  assert.deepEqual(parseMongoEditValue('false'), { type: 'bool', value: false });
  assert.deepEqual(parseMongoEditValue('"한글"'), { type: 'string', value: '한글' });
  const short = parseMongoEditValue('{"$numberInt":"-900"}');
  const long = parseMongoEditValue('{"$numberLong":"9007199254740999"}');
  assert.equal(short.type, 'int');
  assert.equal(short.value.valueOf(), -900);
  assert.equal(long.type, 'long');
  assert.equal(long.value.toString(), '9007199254740999');
  for (const invalid of ['2', '9007199254740999', '{"$numberInt":"2147483648"}', '{"$numberLong":"9223372036854775808"}',
    '{"$numberDecimal":"1.00"}', '{"$function":{}}', '[]', '"value\\u0000other"', '"\\ud800"', '{}', JSON.stringify('x'.repeat(8193))]) {
    assert.throws(() => parseMongoEditValue(invalid), { code: 'ROCKETBRAIN_MONGO_INPUT' });
  }
});
