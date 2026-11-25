'use strict';

const assert = require('node:assert/strict');

function asyncTraceFixture(packageName, className) {
  const source = [
    'package ' + packageName + ';',
    'import java.nio.file.Path;',
    'import java.util.concurrent.CompletableFuture;',
    'import java.util.concurrent.CountDownLatch;',
    'import java.util.concurrent.Executor;',
    'import java.util.concurrent.Executors;',
    'import java.util.concurrent.TimeUnit;',
    'import rocketbrain.async.TaskTrace;',
    'public final class ' + className + ' {',
    '    static int calculate(int price) {',
    '        int total = price + 1;',
    '        return total; // ASYNC_STOP',
    '    }',
    '    static CompletableFuture<Integer> queue(TaskTrace trace, Executor source, Executor target) {',
    '        var gate = new CountDownLatch(1);',
    '        var first = new CompletableFuture<Integer>();',
    '        trace.executor(source, "load-order").execute(() -> { // SUBMIT_ORDER',
    '            try {',
    '                if (!gate.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("worker gate");',
    '                first.complete(41); // COMPLETE_ORDER',
    '            } catch (InterruptedException error) {',
    '                first.completeExceptionally(error);',
    '                Thread.currentThread().interrupt();',
    '            }',
    '        });',
    '        var result = first.thenApplyAsync(' + className + '::calculate, trace.executor(target, "calculate-total"));',
    '        gate.countDown();',
    '        return result;',
    '    }',
    '    public static void main(String[] args) throws Exception {',
    '        try (var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath());',
    '             var source = Executors.newSingleThreadExecutor(job -> new Thread(job, "orders-worker"));',
    '             var target = Executors.newSingleThreadExecutor(job -> new Thread(job, "totals-worker"))) {',
    '            int marker = 1; // UNTRACKED_STOP',
    '            int result = queue(trace, source, target).get(30, TimeUnit.SECONDS);',
    '            System.out.println("ASYNC_RESULT:" + result);',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n');
  return { mainClass: packageName + '.' + className, source,
    line: marker => source.split('\n').findIndex(value => value.includes(marker)) + 1 };
}

function assertAsyncChain(report, fixture) {
  assert.equal(report.chain.length, 2);
  const [parent, worker] = report.chain;
  assert.equal(worker.parentId, parent.id);
  assert.equal(report.taskId, worker.id);
  assert.equal(parent.label, 'load-order');
  assert.equal(worker.label, 'calculate-total');
  assert.equal(parent.submittedBy.name, 'main');
  assert.equal(parent.worker.name, 'orders-worker');
  assert.equal(worker.submittedBy.id, parent.worker.id);
  assert.equal(worker.worker.name, 'totals-worker');
  assert.notEqual(worker.worker.id, worker.submittedBy.id);
  const origin = parent.submissionFrames.find(frame => frame.type === fixture.mainClass && frame.method === 'queue');
  assert.equal(origin?.line, fixture.line('SUBMIT_ORDER'));
  const handoff = worker.submissionFrames.find(frame => frame.type === fixture.mainClass && frame.line === fixture.line('COMPLETE_ORDER'));
  assert.ok(handoff, JSON.stringify(worker.submissionFrames));
  return { rootLabel: parent.label, childLabel: worker.label, rootThread: parent.submittedBy.name,
    submissionThread: worker.submittedBy.name, executionThread: worker.worker.name,
    origin: { method: origin.method, line: origin.line }, handoff: { method: handoff.method, line: handoff.line },
    parentLinked: true };
}

module.exports = { asyncTraceFixture, assertAsyncChain };
