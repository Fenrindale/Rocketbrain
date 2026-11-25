'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function frameFixture(packageName = 'dev.rocketbrain.frames', name = 'RestartFrameFixture') {
  const source = [
    'package ' + packageName + ';',
    'public final class ' + name + ' {',
    '    private static int attempts;',
    '    private static int inspectionCalls;',
    '    static int retry(int input) {',
    '        attempts += 1; // FRAME_ENTRY',
    '        System.out.println("FRAME_ATTEMPT:" + attempts);',
    '        return leaf(input);',
    '    }',
    '    static int leaf(int input) {',
    '        int[] samples = new int[1201];',
    '        for (int i = 0; i < samples.length; i++) samples[i] = i * 3;',
    '        String message = "sample-\\n\\u03a9-txt ".repeat(1000) + "|FULL_END|";',
    '        String beyondLimit = "x".repeat(262145);',
    '        java.util.List<Object> entries = new java.util.ArrayList<>();',
    '        for (int i = 0; i < 301; i++) entries.add("entry-" + i);',
    '        entries.set(299, new ObservedValue());',
    '        entries.set(300, null);',
    '        java.util.List<Object> subclass = new UnsupportedList();',
    '        return input * 2 + samples[0] + (message.isEmpty() || beyondLimit.isEmpty() || entries.isEmpty() || !subclass.isEmpty() ? 1 : 0); // FRAME_GATE',
    '    }',
    '    static final class ObservedValue {',
    '        @Override public String toString() { inspectionCalls++; return "UNEXPECTED"; }',
    '    }',
    '    static final class UnsupportedList extends java.util.ArrayList<Object> {',
    '        @Override public Object[] toArray() { inspectionCalls++; return super.toArray(); }',
    '    }',
    '    public static void main(String[] args) {',
    '        int result = retry(21);',
    '        System.out.println("FRAME_RESULT:" + result + ":" + attempts);',
    '        System.out.println("FRAME_INSPECTION_CALLS:" + inspectionCalls);',
    '    }',
    '}',
    ''
  ].join('\n');
  return {
    mainClass: `${packageName}.${name}`, mainFile: path.join(...packageName.split('.'), name + '.java'), source,
    entry: source.split('\n').findIndex(line => line.includes('FRAME_ENTRY')) + 1,
    gate: source.split('\n').findIndex(line => line.includes('FRAME_GATE')) + 1,
    fullString: 'sample-\nΩ-txt '.repeat(1000) + '|FULL_END|'
  };
}

async function exerciseFrameRestart({ fixture, service, session, first, proceed, frame }) {
  assert.equal(first.reason, 'breakpoint');
  assert.equal((await frame(first)).line, fixture.gate);
  const report = await service.inspect(session);
  assert.match(report.frames[0].label, /\.leaf\(int\)$/);
  const caller = report.frames.find(item => /\.retry\(int\)$/.test(item.label));
  assert.ok(caller, JSON.stringify(report.frames));
  assert.ok(!report.frames.some(item => /\.main\(/.test(item.label)));
  await assert.rejects(service.restart({ ...report }, caller.id), /current Java call stack/);
  const superseded = await service.inspect(session);
  const restarted = await proceed(() => service.restart(report, caller.id));
  assert.equal(restarted.threadId, first.threadId);
  assert.equal(restarted.reason, 'restartframe');
  const reentered = await frame(restarted);
  assert.match(reentered.name, /\.retry\(int\)$/);
  assert.equal(reentered.line, fixture.entry);
  await assert.rejects(service.restart(report, caller.id), /current Java call stack/);
  await assert.rejects(service.restart(superseded, superseded.frames[0].id), /different position/);
  const second = await proceed(() => session.customRequest('continue', { threadId: restarted.threadId }));
  assert.equal(second.reason, 'breakpoint');
  assert.equal((await frame(second)).line, fixture.gate);
  return { stopped: second, proof: { reason: restarted.reason, parentFrame: 'retry(int)', entryLine: reentered.line,
    sameThread: true, callerReviewed: true, staleReviewRefused: true, gateRevisited: true } };
}

async function exerciseLocalValues(service, fixture, session) {
  const review = await service.inspect(session);
  assert.match(review.frame, /\.leaf\(int\)$/);
  const entry = name => review.values.find(value => value.name === name);
  assert.deepEqual(entry('samples'), { name: 'samples', kind: 'array', length: 1201, complete: true });
  assert.deepEqual(entry('entries'), { name: 'entries', kind: 'arrayList', length: 301, complete: true });
  assert.equal(entry('subclass'), undefined);
  const tail = await service.read(review, 'samples', { start: 1198 });
  assert.deepEqual(tail.rows.map(({ index, display }) => [index, display]), [[1198, '3594'], [1199, '3597'], [1200, '3600']]);
  const middle = await service.read(review, 'samples', { start: 410 });
  assert.equal(middle.rows.length, 100);
  assert.equal(middle.rows[0].display, '1230');
  assert.equal(middle.rows.at(-1).display, '1527');
  const list = await service.read(review, 'entries', { start: 298 });
  assert.deepEqual(list.rows.map(({ index, display }) => [index, display]), [[298, 'entry-298'], [299, undefined], [300, 'null']]);
  assert.match(list.rows[1].type, /\$ObservedValue$/);
  const message = await service.read(review, 'message');
  assert.equal(message.text, fixture.fullString);
  assert.equal(entry('beyondLimit')?.complete, false);
  await assert.rejects(service.read(review, 'beyondLimit'), /256 Ki/);
  await assert.rejects(service.read(review, 'samples', { start: 1300 }), /in-range/);
  await assert.rejects(service.read({ ...review }, 'message'), /current Java inspection/);
  return { review, proof: { totalArrayElements: tail.length, totalListElements: list.length, boundedMiddleRows: middle.rows.length,
    tailVerified: true, objectTypeOnly: true, unsupportedSubclassExcluded: true, longStringUnits: message.length,
    exactUnicodeAndNewlines: true, oversizedStringRefused: true } };
}

module.exports = { frameFixture, exerciseFrameRestart, exerciseLocalValues };
