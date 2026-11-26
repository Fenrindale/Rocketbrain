'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { openAsyncTrace } = require('../../src/java/async-trace');
const { jdbcOptions } = require('./coroutine-watch-fixture');

function virtualTraceFixture(packageName, className) {
  const source = [
    'package ' + packageName + ';',
    'import java.nio.file.Path;',
    'import java.util.concurrent.CompletableFuture;',
    'import java.util.concurrent.Executors;',
    'import java.util.concurrent.TimeUnit;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'import rocketbrain.async.TaskTrace;',
    'public final class ' + className + ' {',
    '    record Result(String server, int value) {}',
    '    static void unwrapped() {',
    '        if (!Thread.currentThread().isVirtual()) throw new AssertionError("not virtual"); // UNWRAPPED_STOP',
    '    }',
    '    static Result readJdbc() {',
    '        if (!Thread.currentThread().isVirtual()) throw new AssertionError("not virtual");',
    '        var data = new DriverManagerDataSource(System.getenv("RB_COROUTINE_JDBC_URL"),',
    '            System.getenv("RB_COROUTINE_JDBC_USER"), System.getenv("RB_COROUTINE_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(data);',
    '        String server = jdbc.queryForObject("SELECT VERSION()", String.class);',
    '        int value = jdbc.queryForObject("SELECT 40 + 2", Integer.class);',
    '        return new Result(server, value); // VIRTUAL_STOP',
    '    }',
    '    static void join(Thread worker) {',
    '        try { worker.join(); } catch (InterruptedException failure) {',
    '            Thread.currentThread().interrupt();',
    '            throw new IllegalStateException("join interrupted", failure);',
    '        }',
    '    }',
    '    public static void main(String[] args) throws Exception {',
    '        try (var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath());',
    '             var executor = Executors.newVirtualThreadPerTaskExecutor()) {',
    '            var completed = new CompletableFuture<Result>();',
    '            Thread root = trace.startVirtualThread("load-order", () -> { // ROOT_LAUNCH',
    '                try {',
    '                    join(Thread.startVirtualThread(' + className + '::unwrapped));',
    '                    Runnable dispatch = () -> {',
    '                        Thread leaf = trace.startVirtualThread("query-jdbc", () -> { // LEAF_LAUNCH',
    '                            try { completed.complete(readJdbc()); }',
    '                            catch (Throwable failure) { completed.completeExceptionally(failure); }',
    '                        });',
    '                        join(leaf);',
    '                    };',
    '                    CompletableFuture.runAsync(dispatch, trace.executor(executor, "dispatch-total")).join(); // HANDOFF',
    '                } catch (Throwable failure) { completed.completeExceptionally(failure); }',
    '            });',
    '            join(root);',
    '            var result = completed.get(15, TimeUnit.SECONDS);',
    '            if (!trace.isHealthy()) throw new AssertionError("unhealthy trace");',
    '            System.out.println("VIRTUAL_JDBC:" + result.server() + "|" + result.value());',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n');
  return { mainClass: packageName + '.' + className, source,
    line: marker => source.split('\n').findIndex(value => value.includes(marker)) + 1 };
}

function checkVirtualChain(fixture, report) {
  assert.equal(report.chain.length, 3);
  const [root, middle, leaf] = report.chain;
  assert.equal(report.taskId, leaf.id);
  assert.deepEqual(report.chain.map(task => [task.label, task.handoff, task.worker.virtual]), [
    ['load-order', 'virtual-thread', true], ['dispatch-total', 'executor', true], ['query-jdbc', 'virtual-thread', true]
  ]);
  assert.deepEqual([root.parentId, middle.parentId, leaf.parentId], [0, root.id, middle.id]);
  assert.equal(root.submittedBy.virtual, false);
  assert.equal(middle.submittedBy.virtual, true);
  assert.equal(leaf.submittedBy.virtual, true);
  assert.equal(middle.submittedBy.id, root.worker.id);
  assert.equal(leaf.submittedBy.id, middle.worker.id);
  assert.equal(new Set([root.submittedBy.id, ...report.chain.map(task => task.worker.id)]).size, 4);
  const frames = report.chain.map((task, index) => {
    const marker = ['ROOT_LAUNCH', 'HANDOFF', 'LEAF_LAUNCH'][index];
    const frame = task.submissionFrames.find(frame => frame.type === fixture.mainClass && frame.line === fixture.line(marker));
    assert.ok(frame, JSON.stringify(task.submissionFrames));
    return frame;
  });
  return { handoffs: report.chain.map(task => task.handoff), workers: report.chain.map(task => task.worker),
    frames, parentLinked: true, workerIdentityVerified: true };
}

async function writeRejectedTraces(file, wrongId, wrongWorker, strippedWorker, activeTask) {
  const rows = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const changed = (file, map) => fs.writeFile(file, rows.map(row => JSON.stringify(map(row))).join('\n') + '\n', { flag: 'wx' });
  await Promise.all([
    changed(wrongId, row => row.kind === 'trace' ? { ...row, traceId: randomUUID() } : row),
    changed(wrongWorker, row => row.kind === 'entered' && row.id === activeTask ?
      { ...row, thread: { ...row.thread, id: row.thread.id + 10000 } } : row),
    changed(strippedWorker, row => {
      if (row.kind !== 'submitted' || row.id !== activeTask) return row;
      const { handoff, ...legacy } = row;
      return legacy;
    })
  ]);
}

async function verifyVirtualCompletion(file, output, engine) {
  const events = await openAsyncTrace(file);
  assert.equal(events.tasks.size, 3);
  assert.ok([...events.tasks.values()].every(task => task.state === 'completed'));
  const jdbc = /VIRTUAL_JDBC:([^|\r\n]+)\|(\d+)/u.exec(output);
  assert.ok(jdbc, 'The resumed virtual thread did not report actual Spring JDBC.');
  assert.match(jdbc[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(jdbc[2], '42');
  return { engine, server: jdbc[1], value: Number(jdbc[2]), completedTasks: events.tasks.size };
}

module.exports = { virtualTraceFixture, checkVirtualChain, writeRejectedTraces, verifyVirtualCompletion, jdbcOptions };
