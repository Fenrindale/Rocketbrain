package dev.rocketbrain.futurefixture;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import rocketbrain.async.TaskTrace;

public final class FutureAsyncFixture {
    static void untracked() {
        System.out.println("untracked"); // FUTURE_UNTRACKED
    }

    static String query(JdbcTemplate jdbc, int input) {
        String server = jdbc.queryForObject("SELECT VERSION()", String.class);
        int people = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);
        int answer = jdbc.queryForObject("SELECT ? + 1", Integer.class, input);
        return server + "|" + people + "|" + answer; // FUTURE_STOP
    }

    static void await(CountDownLatch latch) {
        try {
            if (!latch.await(30, TimeUnit.SECONDS)) throw new AssertionError("stage timeout");
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
            throw new AssertionError(stopped);
        }
    }

    public static void main(String[] args) throws Exception {
        try (var beans = new AnnotationConfigApplicationContext();
             var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath());
             var queryExecutor = Executors.newSingleThreadExecutor(r -> new Thread(r, "rb-future-query"));
             var sourceExecutor = Executors.newSingleThreadExecutor(r -> new Thread(r, "rb-future-read"))) {
            untracked();
            beans.registerBean(JdbcTemplate.class, () -> new JdbcTemplate(new DriverManagerDataSource(
                System.getenv("RB_COROUTINE_JDBC_URL"), System.getenv("RB_COROUTINE_JDBC_USER"),
                System.getenv("RB_COROUTINE_JDBC_PASSWORD"))));
            beans.refresh();
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var first = trace.supplyAsync("read-base", () -> { // FUTURE_ORIGIN
                entered.countDown();
                await(release);
                return 40;
            }, sourceExecutor);
            await(entered);
            var adjusted = first.thenApplyAsync("add-adjustment", n -> n + 1, queryExecutor); // FUTURE_ADJUST
            var fetched = adjusted.thenComposeAsync("query-orders", n -> // FUTURE_QUERY
                CompletableFuture.completedFuture(query(beans.getBean(JdbcTemplate.class), n)), queryExecutor);
            release.countDown();
            String result = fetched.stage().toCompletableFuture().get(40, TimeUnit.SECONDS);

            var queued = new ArrayList<Runnable>();
            var canceled = trace.supplyAsync("canceled", () -> { throw new AssertionError("canceled work ran"); }, queued::add);
            if (!canceled.cancel()) throw new AssertionError("cancel not accepted");
            queued.removeFirst().run();

            var failed = trace.<Integer>supplyAsync("failed", () -> { throw new IllegalStateException("controlled"); }, Runnable::run);
            var bypassed = failed.thenApplyAsync("unreachable", n -> { throw new AssertionError("failed input reached"); }, Runnable::run);
            try {
                bypassed.stage().toCompletableFuture().join();
                throw new AssertionError("failed input was swallowed");
            } catch (CompletionException failure) {
                if (!(failure.getCause() instanceof IllegalStateException)) throw failure;
            }
            var rejected = first.thenApplyAsync("rejected", n -> n, r -> { throw new RejectedExecutionException("controlled"); });
            try {
                rejected.stage().toCompletableFuture().join();
                throw new AssertionError("rejected stage ran");
            } catch (CompletionException failure) {
                if (!(failure.getCause() instanceof RejectedExecutionException)) throw failure;
            }
            if (!trace.isHealthy()) throw new AssertionError("trace lost");
            System.out.println("FUTURE_JDBC:" + result);
        }
    }
}
