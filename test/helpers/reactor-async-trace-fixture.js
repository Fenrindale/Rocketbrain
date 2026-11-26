'use strict';

const assert = require('node:assert/strict');
const { openAsyncTrace } = require('../../src/java/async-trace');

function reactorTraceFixture(packageName, className) {
  const source = [
    'package ' + packageName + ';',
    'import java.nio.file.Path;',
    'import java.time.Duration;',
    'import java.util.concurrent.CompletableFuture;',
    'import java.util.concurrent.CountDownLatch;',
    'import java.util.concurrent.RejectedExecutionException;',
    'import java.util.concurrent.TimeUnit;',
    'import java.util.concurrent.atomic.AtomicInteger;',
    'import org.springframework.context.annotation.AnnotationConfigApplicationContext;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'import reactor.core.publisher.Mono;',
    'import reactor.core.scheduler.Scheduler;',
    'import reactor.core.scheduler.Schedulers;',
    'import rocketbrain.async.TaskTrace;',
    'import rocketbrain.async.ReactorTaskTrace;',
    'public final class ' + className + ' {',
    '    record Result(String server, int people, int answer) {}',
    '    static void untracked(CountDownLatch done) {',
    '        done.countDown(); // PERIODIC_STOP',
    '    }',
    '    static Result query(JdbcTemplate jdbc) {',
    '        String server = jdbc.queryForObject("SELECT VERSION()", String.class);',
    '        int people = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);',
    '        int answer = jdbc.queryForObject("SELECT 40 + 2", Integer.class);',
    '        return new Result(server, people, answer); // REACTOR_STOP',
    '    }',
    '    static CompletableFuture<Result> afterDelay(Scheduler timer, JdbcTemplate jdbc) {',
    '        return Mono.delay(Duration.ofMillis(40), timer).map(ignored -> query(jdbc)).toFuture(); // DELAY_SUBMIT',
    '    }',
    '    public static void main(String[] args) throws Exception {',
    '        try (var beans = new AnnotationConfigApplicationContext();',
    '             var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath())) {',
    '            beans.registerBean(JdbcTemplate.class, () -> new JdbcTemplate(new DriverManagerDataSource(',
    '                System.getenv("RB_COROUTINE_JDBC_URL"), System.getenv("RB_COROUTINE_JDBC_USER"),',
    '                System.getenv("RB_COROUTINE_JDBC_PASSWORD"))));',
    '            beans.refresh();',
    '            var source = ReactorTaskTrace.scheduler(trace, Schedulers.newSingle("rb-reactor-source"), "subscribe-orders");',
    '            var timer = ReactorTaskTrace.scheduler(trace, Schedulers.newSingle("rb-reactor-timer"), "delay-jdbc");',
    '            try {',
    '                var done = new CountDownLatch(1);',
    '                var periodic = source.schedulePeriodically(() -> untracked(done), 0, 1, TimeUnit.DAYS);',
    '                if (!done.await(20, TimeUnit.SECONDS)) throw new AssertionError("periodic not executed");',
    '                periodic.dispose();',
    '                var unexpectedlyRun = new AtomicInteger();',
    '                var worker = timer.createWorker();',
    '                var canceled = worker.schedule(unexpectedlyRun::incrementAndGet, 1, TimeUnit.DAYS);',
    '                canceled.dispose();',
    '                worker.dispose();',
    '                try {',
    '                    worker.schedule(unexpectedlyRun::incrementAndGet);',
    '                    throw new AssertionError("disposed worker accepted a submission");',
    '                } catch (RejectedExecutionException expected) {}',
    '                var result = Mono.defer(() -> Mono.fromFuture(afterDelay(timer, beans.getBean(JdbcTemplate.class))))',
    '                    .subscribeOn(source).block(Duration.ofSeconds(40)); // ROOT_SUBMIT',
    '                if (!periodic.isDisposed() || !canceled.isDisposed() || !worker.isDisposed()',
    '                    || unexpectedlyRun.get() != 0 || !trace.isHealthy()) throw new AssertionError("trace changed scheduling");',
    '                var reactor = Mono.class.getPackage().getImplementationVersion();',
    '                System.out.println("REACTOR_JDBC:" + reactor + "|" + result.server() + "|" + result.people() + "|" + result.answer());',
    '            } finally {',
    '                source.dispose();',
    '                timer.disposeGracefully().block(Duration.ofSeconds(10));',
    '            }',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n');
  return { mainClass: packageName + '.' + className, source,
    line: marker => source.split('\n').findIndex(line => line.includes(marker)) + 1 };
}

function checkReactorChain(fixture, report) {
  const [source, timer] = report.chain;
  assert.equal(report.chain.length, 2);
  assert.equal(report.taskId, timer.id);
  assert.deepEqual(report.chain.map(task => [task.label, task.handoff, task.worker.virtual]), [
    ['subscribe-orders', 'reactor-scheduler', false], ['delay-jdbc', 'reactor-scheduler', false]
  ]);
  assert.deepEqual([source.parentId, timer.parentId], [0, source.id]);
  assert.notEqual(source.submittedBy.id, source.worker.id);
  assert.equal(timer.submittedBy.id, source.worker.id);
  assert.notEqual(timer.worker.id, source.worker.id);
  const originFrames = ['ROOT_SUBMIT', 'DELAY_SUBMIT'].map((marker, index) => {
    const task = report.chain[index];
    assert.ok(task.submissionFrames.some(frame => frame.type.startsWith('reactor.core.publisher.Mono')),
      JSON.stringify(task.submissionFrames));
    const origin = task.submissionFrames.find(frame => frame.type === fixture.mainClass && frame.line === fixture.line(marker));
    assert.ok(origin, JSON.stringify(task.submissionFrames));
    return origin;
  });
  return { handoffs: report.chain.map(task => task.handoff), originFrames, parentLinked: true, workerIdentityVerified: true };
}

async function verifyReactorCompletion(trace, output, engine) {
  const { tasks } = await openAsyncTrace(trace);
  assert.deepEqual([...tasks.values()].map(task => task.state), ['submitted', 'rejected', 'completed', 'completed']);
  const jdbc = /REACTOR_JDBC:(3\.8\.8)\|([^|\r\n]+)\|(\d+)\|(\d+)/u.exec(output);
  assert.ok(jdbc, 'The resumed Reactor task did not report actual Spring JDBC.');
  assert.match(jdbc[2], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.deepEqual([jdbc[3], jdbc[4]], ['2', '42']);
  return { engine, reactorVersion: jdbc[1], server: jdbc[2], people: 2, answer: 42,
    completedTasks: 2, canceledBeforeExecution: true, rejectionRecorded: true, periodicUntraced: true };
}

module.exports = { reactorTraceFixture, checkReactorChain, verifyReactorCompletion };
