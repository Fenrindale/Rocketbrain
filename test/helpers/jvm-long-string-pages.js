'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { jdbcOptions } = require('./coroutine-watch-fixture');
const { launchCoroutineFixture } = require('./coroutine-fixture');

const request = 'rocketbrain/readJavaValues', pageSize = 8192;
const jdbcLine = /Rocketbrain String JDBC\|(java|kotlin)\|([^|\r\n]+)\|(\d+)\r?\n/u;
const expected = {
  latin: 'A\0éÿ'.repeat(68003) + 'tail',
  wide: '한'.repeat(8191) + '\uD83D\uDE00' + 'ab\uD800끝\uDC00'.repeat(53000) + '\r\nlast'
};

function fixtureFrame(fixture, language) {
  const name = language === 'java' ? 'JavaStringInspection' : 'KotlinStringInspection';
  const mainClass = 'coroutinesfixture.' + name;
  const sourceRoot = path.join(fixture.root, 'src/main', language);
  const source = path.join(sourceRoot, 'coroutinesfixture', name + (language === 'java' ? '.java' : '.kt'));
  return { mainClass, sourceRoot, source, breakpoint: mainClass + '#paused' };
}

async function launchStringFixture(fixture, language, database, targetPort) {
  const { classpath, env } = await jdbcOptions(database);
  return launchCoroutineFixture(fixture,
    { vmArgs: ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:' + targetPort] },
    { mainClass: fixtureFrame(fixture, language).mainClass, classpath, env, args: ['controlled'] });
}

function rawReader(send, frameId) {
  return (action, args = {}) => send(request, { action, frameId, ...args });
}

function utf16(page) {
  assert.equal(page.kind, 'stringPage');
  assert.equal(page.encoding, 'utf16le');
  const bytes = Buffer.from(page.base64, 'base64');
  assert.equal(bytes.length, page.units * 2);
  assert.equal(bytes.toString('base64'), page.base64);
  return { ...page, text: bytes.toString('utf16le') };
}

async function assertStrings(open, next) {
  const result = {};
  for (const [name, source] of Object.entries(expected)) {
    const collected = [], pages = Math.ceil(source.length / pageSize);
    assert.ok(source.length > 256 * 1024);
    let page = await open(name);
    const first = page;
    for (let start = 0; start < source.length; start += pageSize) {
      assert.equal(page.kind, 'stringPage');
      assert.equal(page.start, start);
      assert.equal(page.length, source.length);
      assert.equal(page.text.length, Math.min(pageSize, source.length - start));
      collected.push(page.text);
      if (start + pageSize < source.length) page = await next(page, start + pageSize);
    }
    assert.equal(collected.join(''), source);
    if (name === 'wide') {
      assert.equal(collected[0].charCodeAt(pageSize - 1), 0xd83d);
      assert.equal(collected[1].charCodeAt(0), 0xde00);
      assert.equal((await next(page, pageSize - 1, 2)).text, '\uD83D\uDE00');
      assert.equal(Array.from(collected[1].slice(1, 6), unit => unit.charCodeAt(0)).join(','), '97,98,55296,45149,56320');
    }
    assert.equal((await next(page, source.length)).text, '');
    result[name] = { units: source.length, pages, utf16leSha256: createHash('sha256').update(Buffer.from(source, 'utf16le')).digest('hex') };
    assert.equal((await next(page, 0)).text, first.text);
  }
  return result;
}

async function assertRawStrings(read) {
  const values = (await read('list')).values;
  for (const [name, value] of Object.entries(expected)) {
    assert.deepEqual(values.find(entry => entry.name === name),
      { name, kind: 'string', length: value.length, complete: false, pageable: true });
  }
  assert.equal((await read('string', { name: 'shortValue' })).text, 'short value');
  await assert.rejects(read('string', { name: 'wide' }), /256 Ki/u);
  await assert.rejects(read('stringOpen', { name: 'shortValue', start: 0, count: 1 }), /Choose a long String/u);
  for (const options of [{ start: -1 }, { start: expected.wide.length + 1 }, { start: 0.5 }, { count: 0 }, { count: pageSize + 1 }]) {
    await assert.rejects(read('stringOpen', { name: 'wide', start: 0, count: pageSize, ...options }), /String (?:range|page|start)/u);
  }
  const open = async name => ({ ...utf16(await read('stringOpen', { name, start: 0, count: pageSize })), name });
  const next = async ({ name, pageId }, start, count = pageSize) =>
    ({ ...utf16(await read('stringPage', { name, pageId, start, count })), name });
  const ranges = await assertStrings(open, next);
  const previous = await open('wide');
  await assert.rejects(next({ ...previous, name: 'other' }, 0), /Reopen the long String/u);
  const active = await open('other');
  await assert.rejects(next(previous, 0), /Reopen the long String/u);
  await assert.rejects(next({ ...active, pageId: 'foreign-token' }, 0), /Reopen the long String/u);
  return { ranges, shortValue: true, oversizedReadRefused: true, sameLengthForeignLocalRefused: true,
    replacedInspectionRefused: true, foreignTokenRefused: true, afterResume: () => next(active, 0) };
}

function jdbcResult(output, engine, language) {
  const match = jdbcLine.exec(output);
  assert.ok(match, 'The resumed fixture did not read its Spring JDBC rows.');
  assert.equal(match[1], language);
  assert.match(match[2], engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*MariaDB/u);
  assert.equal(match[3], '2');
  return { language, engine, server: match[2], springRows: Number(match[3]) };
}

module.exports = { fixtureFrame, launchStringFixture, rawReader, assertRawStrings, assertStrings, jdbcResult, jdbcLine, pageSize };
