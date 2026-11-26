package rocketbrain.async;

import java.util.Objects;
import java.util.concurrent.TimeUnit;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;

/** Wrap a dedicated Reactor 3.8 scheduler and its workers without JVM-wide hooks. */
public final class ReactorTaskTrace implements Scheduler {
    private final TaskTrace trace;
    private final Scheduler delegate;
    private final String label;

    private ReactorTaskTrace(TaskTrace trace, Scheduler delegate, String label) {
        this.trace = trace;
        this.delegate = delegate;
        this.label = label;
    }

    public static Scheduler scheduler(TaskTrace trace, Scheduler delegate, String label) {
        Objects.requireNonNull(trace, "trace");
        Objects.requireNonNull(delegate, "scheduler");
        Objects.requireNonNull(label, "label");
        if (delegate instanceof ReactorTaskTrace) throw new IllegalArgumentException("The Reactor scheduler is already traced");
        return new ReactorTaskTrace(trace, delegate, label);
    }

    @Override public Disposable schedule(Runnable task) {
        return trace.scheduleReactor(label, task, delegate::schedule);
    }

    @Override public Disposable schedule(Runnable task, long delay, TimeUnit unit) {
        return trace.scheduleReactor(label, task, wrapped -> delegate.schedule(wrapped, delay, unit));
    }

    @Override public Disposable schedulePeriodically(Runnable task, long initialDelay, long period, TimeUnit unit) {
        return delegate.schedulePeriodically(task, initialDelay, period, unit);
    }

    @Override public Worker createWorker() { return new TracedWorker(delegate.createWorker()); }
    @Override public long now(TimeUnit unit) { return delegate.now(unit); }
    @Override public boolean isDisposed() { return delegate.isDisposed(); }
    @Override public void dispose() { delegate.dispose(); }
    @Override public Mono<Void> disposeGracefully() { return delegate.disposeGracefully(); }
    @Override public void init() { delegate.init(); }
    @SuppressWarnings("deprecation")
    @Override public void start() { delegate.start(); }

    private final class TracedWorker implements Worker {
        private final Worker worker;
        TracedWorker(Worker worker) { this.worker = worker; }

        @Override public Disposable schedule(Runnable task) {
            return trace.scheduleReactor(label, task, worker::schedule);
        }

        @Override public Disposable schedule(Runnable task, long delay, TimeUnit unit) {
            return trace.scheduleReactor(label, task, wrapped -> worker.schedule(wrapped, delay, unit));
        }

        @Override public Disposable schedulePeriodically(Runnable task, long initialDelay, long period, TimeUnit unit) {
            return worker.schedulePeriodically(task, initialDelay, period, unit);
        }

        @Override public void dispose() { worker.dispose(); }
        @Override public boolean isDisposed() { return worker.isDisposed(); }
    }
}
