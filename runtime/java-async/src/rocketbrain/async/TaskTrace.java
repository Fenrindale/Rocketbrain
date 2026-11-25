package rocketbrain.async;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Executor;

/** Opt-in submission stacks for work sent through a wrapped Executor. */
public final class TaskTrace implements AutoCloseable {
    private static final int FILE_BYTES = 4 * 1024 * 1024;
    private static final int MAX_TASKS = 2048;
    private static final int MAX_FRAMES = 20;
    private static final StackWalker STACKS = StackWalker.getInstance();
    private static final String OWN_CLASS = TaskTrace.class.getName();

    private final BufferedWriter writer;
    private final String traceId = UUID.randomUUID().toString();
    private final ThreadLocal<Long> activeTask = new ThreadLocal<>();
    private long nextTask;
    private int bytes;
    private boolean recording = true;
    private boolean healthy = true;
    private boolean closed;

    private TaskTrace(BufferedWriter writer) throws IOException {
        this.writer = writer;
        var header = "{\"kind\":\"trace\",\"version\":1,\"traceId\":" + json(traceId)
            + ",\"pid\":" + ProcessHandle.current().pid() + "}";
        write(header);
    }

    public static TaskTrace open(Path file) throws IOException {
        Objects.requireNonNull(file, "trace file");
        if (!file.isAbsolute()) throw new IllegalArgumentException("Use an absolute async trace file path");
        var writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        try {
            return new TaskTrace(writer);
        } catch (IOException failure) {
            try { writer.close(); } catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    public Executor executor(Executor delegate, String label) {
        Objects.requireNonNull(delegate, "delegate");
        Objects.requireNonNull(label, "label");
        return runnable -> {
            Objects.requireNonNull(runnable, "runnable");
            Task task = submitted(label);
            if (task == null) {
                delegate.execute(runnable);
                return;
            }
            try {
                delegate.execute(() -> runRecorded(task, runnable));
            } catch (RuntimeException | Error failure) {
                if (!task.started) phase("rejected", task.id);
                throw failure;
            }
        };
    }

    public synchronized boolean isHealthy() { return healthy; }

    private synchronized Task submitted(String label) {
        if (closed || !recording) return null;
        if (nextTask >= MAX_TASKS) {
            truncate();
            return null;
        }
        long id = ++nextTask;
        Long parent = activeTask.get();
        var frames = STACKS.walk(stream -> stream
            .filter(frame -> !frame.getClassName().equals(OWN_CLASS))
            .limit(MAX_FRAMES).map(TaskTrace::frame).toList());
        var entry = "{\"kind\":\"submitted\",\"id\":" + id + ",\"parent\":" + (parent == null ? 0 : parent)
            + ",\"label\":" + json(shorten(label, 160)) + ",\"thread\":" + thread()
            + ",\"frames\":[" + String.join(",", frames) + "]}";
        return append(entry) ? new Task(id) : null;
    }

    private void runRecorded(Task task, Runnable runnable) {
        // The debugger reads these two locals around the user's task call.
        String rocketbrainTraceId = traceId;
        long rocketbrainTaskId = task.id;
        task.started = true;
        Long previous = activeTask.get();
        activeTask.set(rocketbrainTaskId);
        entered(rocketbrainTraceId, rocketbrainTaskId);
        boolean returned = false;
        try {
            runnable.run();
            returned = true;
        } finally {
            phase(returned ? "completed" : "failed", rocketbrainTaskId);
            if (previous == null) activeTask.remove();
            else activeTask.set(previous);
        }
    }

    private synchronized void entered(String trace, long id) {
        if (traceId.equals(trace)) append("{\"kind\":\"entered\",\"id\":" + id + ",\"thread\":" + thread() + "}");
    }

    private synchronized void phase(String kind, long id) {
        append("{\"kind\":" + json(kind) + ",\"id\":" + id + "}");
    }

    private static String thread() {
        Thread thread = Thread.currentThread();
        return "{\"id\":" + thread.threadId() + ",\"name\":" + json(shorten(thread.getName(), 120)) + "}";
    }

    private static String frame(StackWalker.StackFrame frame) {
        return "{\"type\":" + json(shorten(frame.getClassName(), 350))
            + ",\"method\":" + json(shorten(frame.getMethodName(), 120))
            + ",\"file\":" + json(frame.getFileName() == null ? "" : shorten(frame.getFileName(), 160))
            + ",\"line\":" + frame.getLineNumber() + "}";
    }

    private static String shorten(String text, int size) {
        return text.length() > size ? text.substring(0, size) : text;
    }

    private static String json(String text) {
        var output = new StringBuilder(text.length() + 2).append('"');
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            if (c == '"' || c == '\\') output.append('\\').append(c);
            else if (c < 32) output.append(String.format("\\u%04x", (int) c));
            else output.append(c);
        }
        return output.append('"').toString();
    }

    private boolean append(String entry) {
        if (!recording || closed) return false;
        if (bytes + entry.getBytes(StandardCharsets.UTF_8).length + 1 > FILE_BYTES - 128) {
            truncate();
            return false;
        }
        try {
            write(entry);
            return true;
        } catch (IOException failure) {
            recording = false;
            healthy = false;
            return false;
        }
    }

    private void truncate() {
        try { write("{\"kind\":\"truncated\"}"); }
        catch (IOException failure) { healthy = false; }
        recording = false;
    }

    private void write(String entry) throws IOException {
        writer.write(entry);
        writer.write('\n');
        writer.flush();
        bytes += entry.getBytes(StandardCharsets.UTF_8).length + 1;
    }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        try { writer.close(); } catch (IOException failure) { healthy = false; }
    }

    private static final class Task {
        final long id;
        volatile boolean started;
        Task(long id) { this.id = id; }
    }
}
