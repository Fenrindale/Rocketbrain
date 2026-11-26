'use strict';

const assert = require('node:assert/strict');
const { fieldRequest } = require('./kotlin-object-fields');

const textValue = '  DB 확인🙂  ';
const initialText = JSON.stringify('original');
const typedChanges = [
  ['history', 64, 65, '75', '321'],
  ['preciseHistory', 0, 0, '9007199254740993', '9007199254741035L'],
  ['bits', 0, 1, 'false', 'true']
];
const resultFor = value => value.replace(/L$/u, '');

function assertExtendedFields(rows) {
  const fields = new Map(rows.map(item => [item.name, item]));
  for (const [name, kind, value, writable] of [
    ['label', 'text', initialText, true], ['optionalLabel', 'text', 'null', true],
    ['knownSupplementary', 'text', '"fixture🙂"', false],
    ['guardedLabel', 'text', '"custom"', false], ['largeLabel', 'text', '<String preview unavailable>', false],
    ['history', 'array', 'length 70', true], ['changingHistory', 'array', 'length 3', true],
    ['guardedArray', 'array', 'length 1', false], ['preciseHistory', 'array', 'length 2', true], ['bits', 'array', 'length 2', true]
  ]) {
    const row = fields.get(name);
    assert.deepEqual([row?.kind, row?.value, row?.writable], [kind, value, writable], name);
  }
}

async function assertKotlinFieldValues(send, frameId, change) {
  const request = (action, args = {}) => send(fieldRequest, { action, frameId, receiver: 'target', ...args });
  const fields = (receiver = 'target') => request('fields', { receiver }).then(value => value.fields);
  const page = (name, start = 0, extra = {}) => request('page', { name, start, count: 32, ...extra });
  const prepare = (name, input, extra = {}) => request('prepare', { name, input, ...extra });
  const apply = review => request('apply', { reviewId: review.reviewId });
  assertExtendedFields(await fields());
  await assert.rejects(prepare('guardedLabel', 'new'), /writable Kotlin scalar field/u);
  await assert.rejects(prepare('label', 'x'.repeat(2049)), /at most 2048/u);
  await assert.rejects(prepare('label', '\0'), /valid Kotlin field text/u);
  const supplementary=await prepare('label','fixture🙂');
  const supplementaryResult=await apply(supplementary);
  assert.equal(JSON.parse(supplementaryResult.value),'fixture🙂');
  assert.equal((await fields()).find(row=>row.name==='label').value,supplementary.after);
  await apply(await prepare('label','original'));
  assert.equal((await fields()).find(row=>row.name==='label').value,initialText);
  const longRead = await page('history');
  assert.equal(longRead.items.length, 32);
  assert.deepEqual(longRead.items[0], { index: 0, value: '10' });
  await assert.rejects(page('history', 70), /at most 32 elements/u);
  await assert.rejects(page('history', 0, { count: 33 }), /at most 32 elements/u);
  await assert.rejects(page('history', 0.5), /exact non-negative Kotlin array index/u);
  const guarded = await page('guardedArray');
  await assert.rejects(prepare('guardedArray', '6', { pageId: guarded.pageId, index: 0 }), /editable Kotlin array element/u);
  await assert.rejects(prepare('history', '6', { pageId: longRead.pageId, index: 0 }), /current Kotlin array page/u);
  const firstPage = await page('history');
  await assert.rejects(prepare('history', '6', { pageId: firstPage.pageId, index: 65 }), /current Kotlin array page/u);
  await assert.rejects(prepare('history', 'target.mutate()', { pageId: firstPage.pageId, index: 0 }), /Kotlin Int literal/u);

  const changed = [];
  for (const [name, input, before] of [['label', textValue, initialText], ['optionalLabel', 'optional', 'null']]) {
    const review = await prepare(name, input);
    assert.equal(review.type, 'String');
    assert.equal(review.before, before);
    assert.equal(JSON.parse(review.after), input);
    assert.equal((await fields()).find(row => row.name === name).value, before);
    assert.deepEqual(await apply(review), { state: 'applied', receiver: 'target', name, value: review.after });
    await assert.rejects(apply(review), /same Kotlin frame/u);
    assert.equal((await fields('other')).find(row => row.name === name).value, before);
    changed.push({ name, before, after: review.after });
  }

  const pp = await page('changingHistory');
  const beforeSwap = await prepare('changingHistory', '55', { pageId: pp.pageId, index: 1 });
  await change('array', 'Rocketbrain Kotlin array replaced by fixture');
  await assert.rejects(apply(beforeSwap), /Kotlin array instance changed/u);
  await assert.rejects(prepare('changingHistory', '55', { pageId: pp.pageId, index: 1 }), /Kotlin array instance changed/u);
  const next = await page('changingHistory');
  assert.deepEqual(next.items[1], { index: 1, value: '22' });
  const beforeElement = await prepare('changingHistory', '55', { pageId: next.pageId, index: 1 });
  await change('element', 'Rocketbrain Kotlin array element changed by fixture');
  await assert.rejects(apply(beforeElement), /Kotlin array element changed/u);
  assert.deepEqual((await page('changingHistory')).items[1], { index: 1, value: '23' });

  for (const [name, start, index, before, input] of typedChanges) {
    const selected = await page(name, start);
    assert.equal(selected.items.find(item => item.index === index).value, before);
    const review = await prepare(name, input, { pageId: selected.pageId, index });
    assert.deepEqual([review.index, review.before, review.after], [index, before, resultFor(input)]);
    assert.deepEqual(await apply(review), { state: 'applied', receiver: 'target', name, index, value: resultFor(input) });
    assert.equal((await page(name, start)).items.find(item => item.index === index).value, resultFor(input));
    assert.equal((await page(name, start, { receiver: 'other' })).items.find(item => item.index === index).value, before);
    changed.push({ name, index, before, after: resultFor(input) });
  }
  const finalPage = await page('history',64);
  const finalReview = await prepare('history', '333', { pageId: finalPage.pageId, index: 65 });
  return { changes: changed, exactPageAndArrayIdentity: true, conflictingElementRefused: true, accessorAndInputRefused: true,
    supplementaryString:'round-trip-verified',
    staleId: finalReview.reviewId };
}

async function assertNativeKotlinFieldValues(inspector, session) {
  const receivers = await inspector.list(session), fields = await inspector.inspectFields(receivers, 'target');
  assertExtendedFields(fields.fields);
  await assert.rejects(inspector.prepare(fields, 'guardedLabel', 'new'), /writable Kotlin field/u);
  await assert.rejects(inspector.prepare(fields, 'label', '\0'), /valid Kotlin field text/u);
  const changes = [];
  for (const [name, input, before] of [['label', textValue, initialText], ['optionalLabel', 'optional', 'null']]) {
    const review = await inspector.prepare(fields, name, input);
    assert.equal(review.before, before);
    assert.equal(JSON.parse(review.after), input);
    assert.deepEqual(await inspector.apply(review), { state: 'applied', receiver: 'target', name, value: review.after });
    changes.push({ name, before, after: review.after });
  }
  const first = await inspector.inspectArray(fields, 'history');
  assert.equal(first.items.length, 32);
  const guarded = await inspector.inspectArray(fields, 'guardedArray');
  await assert.rejects(inspector.prepareElement(guarded, 0, '11'), /editable Kotlin array element/u);
  for (const [name, start, index, before, input] of typedChanges) {
    const page = await inspector.inspectArray(fields, name, start);
    if (name === 'history') {
      assert.equal(page.length, 70);
      assert.equal(page.items.length, 6);
      await assert.rejects(inspector.prepareElement(first, 0, '19'), /current Kotlin array page/u);
    }
    const review = await inspector.prepareElement(page, index, input);
    assert.deepEqual([review.before, review.after], [before, resultFor(input)]);
    assert.deepEqual(await inspector.apply(review), { state: 'applied', receiver: 'target', name, index, value: resultFor(input) });
    await assert.rejects(inspector.apply(review), /Inspect this paused Kotlin object/u);
    changes.push({ name, index, before, after: resultFor(input) });
  }
  return { changes, nativeCommand: true, boundedPages: true, readonlyAccessorRefused: true };
}

function assertKotlinFieldValuesResumed(output) {
  const exactBytes = Buffer.from(textValue,'utf8').toString('hex');
  const expected = 'Rocketbrain Kotlin Field Values|' + exactBytes + '|optional|321|9007199254741035|true|original|75|0';
  assert.ok(output.includes(expected), output);
  return { text: textValue, optionalText: 'optional', arrayValues: [321, '9007199254741035', true], otherInstanceUnchanged: true, sideEffects: 0 };
}

module.exports = { assertKotlinFieldValues, assertNativeKotlinFieldValues, assertKotlinFieldValuesResumed };
