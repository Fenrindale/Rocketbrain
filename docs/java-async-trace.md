# Java async submission stacks

Use **Rocketbrain: Copy Java Async Trace Helper** and choose an existing Java source root, such as `src/main/java`. The command copies `rocketbrain.async.TaskTrace` into your project. Compile it with normal local debug variables, for example `javac -g`. The helper uses Java 21 or later.

Open a new, absolute JSONL path in your application and wrap the executors you want to trace. Keep the trace open until those tasks have finished.

```java
try (var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath());
     var orders = Executors.newSingleThreadExecutor();
     var totals = Executors.newSingleThreadExecutor()) {
    var result = CompletableFuture.supplyAsync(() -> {
        int price = 41;
        return CompletableFuture.supplyAsync(() -> price + 1, trace.executor(totals, "calculate-total"));
    }, trace.executor(orders, "load-order")).thenCompose(task -> task);
    System.out.println(result.join());
}
```

Use `trace.startVirtualThread(label, runnable)` to trace a direct Java virtual-thread launch. It returns the started `Thread`, so the application still controls joining it. The helper records virtual and platform workers and follows nested launches or executor submissions made by a traced worker.

```java
try (var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath());
     var totals = Executors.newVirtualThreadPerTaskExecutor()) {
    var result = new CompletableFuture<Integer>();
    Thread order = trace.startVirtualThread("load-order",
        () -> trace.executor(totals, "calculate-total").execute(() -> result.complete(42)));
    order.join();
    System.out.println(result.join());
}
```

Pause inside a traced task and run **Rocketbrain: Show Java Async Submission Stack**. Select the JSONL file from that run. Rocketbrain checks the trace ID and task ID in the paused JVM, then shows the recorded submission frames from the outermost tracked task to the selected task. Select a frame to open its unique workspace source.

With the current helper, Rocketbrain also checks the recorded worker ID and thread kind against the paused Java frame before showing the chain. Older helper files and their version 1 traces remain readable.

The trace records submissions at the wrapped executor boundary. A submission made within a traced task links to that parent. An already-completed future can schedule later continuations from a caller thread, so those submissions can have an independent root. Use new paths for each run. The trace retains up to 2,048 jobs and 4 MiB and contains labels, thread names, and source frames. The application's trace instance exposes `isHealthy()` to check for write failures.

## CompletableFuture stages

Use the current Java trace helper to follow an explicit chain of suppliers and asynchronous continuations. Give each stage a label and its normal executor. A dependent stage retains its predecessor even when the application registers the continuation on a different thread.

```java
try (var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath());
     var orders = Executors.newSingleThreadExecutor();
     var totals = Executors.newSingleThreadExecutor()) {
    var amount = trace.supplyAsync("read-order", () -> 41, orders);
    var total = amount.thenApplyAsync("calculate-total", price -> price + 1, totals);
    System.out.println(total.stage().toCompletableFuture().join());
}
```

Use `thenComposeAsync` when the next callback produces a `CompletionStage`. `stage()` exposes the result as a read-only completion stage, and `cancel()` uses normal CompletableFuture cancellation. Trace records describe callback entry and return. A continuation bypassed by an upstream failure and a canceled task that never runs both keep their submission records without a worker. Pause a tracked callback and select **Rocketbrain: Show Java Async Submission Stack** to inspect the recorded registration locations.

## Reactor scheduler submissions

In a project that already uses Reactor Core 3.8, copy the current Java helper first. Run **Rocketbrain: Copy Reactor Async Trace Helper** and choose the same Java source root. If you already customized `TaskTrace.java`, retain it in source control and review the new helper source before merging. Both copy commands preserve existing files.

```java
try (var trace = TaskTrace.open(Path.of(args[0]).toAbsolutePath())) {
    var input = ReactorTaskTrace.scheduler(trace, Schedulers.newSingle("order-input"), "subscribe-order");
    var timer = ReactorTaskTrace.scheduler(trace, Schedulers.newSingle("order-timer"), "wait-for-order");
    try {
        var total = Mono.defer(() -> Mono.fromFuture(
                Mono.delay(Duration.ofMillis(25), timer).map(tick -> 42).toFuture()))
            .subscribeOn(input)
            .block(Duration.ofSeconds(5));
        System.out.println(total);
    } finally {
        input.dispose();
        timer.dispose();
    }
}
```

Pass dedicated schedulers to the wrapper and manage their normal Reactor lifecycle. The helper records one-time immediate and delayed submissions on the selected scheduler and its workers. Reactor's task disposal still cancels the work. A canceled task that never enters has a submission record without a worker or completion. Periodic work follows the original schedule and runs outside the recorded chain.

The recorded parent comes from the worker that actually made the next submission. Work submitted outside a traced task starts a new root. Pause the worker in a local Rocketbrain Java launch or attach session and open the trace. You can navigate to recorded submission frames that resolve to a unique workspace source.
