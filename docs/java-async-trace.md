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

Coverage includes wrapped executors and explicit `trace.startVirtualThread` launches. An unwrapped `Thread.startVirtualThread` call, detached work after a trace closes, and automatic cross-framework task reconstruction remain outside this workflow.
