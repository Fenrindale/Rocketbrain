'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function frameFixture(packageName = 'dev.rocketbrain.frames', name = 'RestartFrameFixture') {
  const source = [
    'package ' + packageName + ';',
    'public final class ' + name + ' {',
    '    private static int attempts;',
    '    static int retry(int input) {',
    '        attempts += 1; // FRAME_ENTRY',
    '        System.out.println("FRAME_ATTEMPT:" + attempts);',
    '        return leaf(input);',
    '    }',
    '    static int leaf(int input) {',
    '        int[] samples = new int[1201];',
    '        for (int i = 0; i < samples.length; i++) samples[i] = i * 3;',
    '        String message = "sample-\\n\\u03a9-txt ".repeat(1000) + "|FULL_END|";',
    '        return input * 2 + samples[0] + (message.isEmpty() ? 1 : 0); // FRAME_GATE',
    '    }',
    '    public static void main(String[] args) {',
    '        int result = retry(21);',
    '        System.out.println("FRAME_RESULT:" + result + ":" + attempts);',
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

module.exports = { frameFixture, exerciseFrameRestart };
