package rocketbrain.spring;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Objects;
import java.util.function.Consumer;

import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;

/** Records the registry operations that a selected Spring callback makes through this view. */
public final class RegistrationTrace implements AutoCloseable {
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final int MAX_RECORDS = 4096;
    private static final int MAX_NAME = 512;
    private static final StackWalker STACKS = StackWalker.getInstance();

    private final BufferedWriter writer;
    private int bytes;
    private int records;
    private int nextScope;
    private boolean recording = true;
    private boolean healthy = true;
    private boolean closed;

    private RegistrationTrace(BufferedWriter writer) throws IOException {
        this.writer = writer;
        write("{\"kind\":\"spring-registration\",\"version\":1}");
    }

    public static RegistrationTrace open(Path file) throws IOException {
        Objects.requireNonNull(file, "trace file");
        if (!file.isAbsolute()) throw new IllegalArgumentException("Use an absolute Spring registration trace path");
        var writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        try {
            return new RegistrationTrace(writer);
        } catch (IOException failure) {
            try { writer.close(); } catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    public void observe(String label, BeanDefinitionRegistry registry, Consumer<BeanDefinitionRegistry> callback) {
        Objects.requireNonNull(label, "label");
        Objects.requireNonNull(registry, "registry");
        Objects.requireNonNull(callback, "callback");
        Scope scope = begin(label);
        boolean succeeded = false;
        try {
            callback.accept(scope == null ? registry : new RegistryView(registry, scope));
            succeeded = true;
        } finally {
            if (scope != null) end(scope, succeeded);
        }
    }

    private synchronized Scope begin(String label) {
        if (!recording || closed) return null;
        if (label.isEmpty() || label.length() > MAX_NAME) {
            truncate();
            return null;
        }
        int id = ++nextScope;
        return append("{\"kind\":\"begin\",\"id\":" + id + ",\"label\":" + json(label) + "}") ? new Scope(id) : null;
    }

    private synchronized void mutation(Scope scope, String operation, String name, String alias) {
        if (scope.finished || !recording || closed) return;
        if (name == null || name.length() > MAX_NAME || alias != null && alias.length() > MAX_NAME) {
            truncate();
            return;
        }
        var frame = STACKS.walk(stream -> stream
            .filter(item -> !item.getClassName().equals(RegistrationTrace.class.getName())
                && !item.getClassName().startsWith(RegistrationTrace.class.getName() + "$"))
            .findFirst().orElse(null));
        var origin = frame == null ? "null" : "{\"type\":" + json(frame.getClassName()) + ",\"method\":" + json(frame.getMethodName())
            + ",\"file\":" + json(Objects.toString(frame.getFileName(), "")) + ",\"line\":" + frame.getLineNumber() + "}";
        append("{\"kind\":\"mutation\",\"id\":" + scope.id + ",\"operation\":" + json(operation)
            + ",\"name\":" + json(name) + (alias == null ? "" : ",\"alias\":" + json(alias)) + ",\"origin\":" + origin + "}");
    }

    private synchronized void end(Scope scope, boolean succeeded) {
        scope.finished = true;
        append("{\"kind\":\"end\",\"id\":" + scope.id + ",\"outcome\":\"" + (succeeded ? "returned" : "threw") + "\"}");
    }

    public synchronized boolean isHealthy() { return healthy; }

    private boolean append(String line) {
        if (!recording || closed) return false;
        if (records >= MAX_RECORDS || bytes + line.getBytes(StandardCharsets.UTF_8).length + 1 > MAX_BYTES - 64) {
            truncate();
            return false;
        }
        try {
            write(line);
            records++;
            return true;
        } catch (IOException failure) {
            recording = false;
            healthy = false;
            return false;
        }
    }

    private void truncate() {
        recording = false;
        try { write("{\"kind\":\"truncated\"}"); }
        catch (IOException failure) { healthy = false; }
    }

    private void write(String line) throws IOException {
        writer.write(line);
        writer.write('\n');
        writer.flush();
        bytes += line.getBytes(StandardCharsets.UTF_8).length + 1;
    }

    private static String json(String value) {
        var out = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char unit = value.charAt(index);
            if (unit == '"' || unit == '\\') out.append('\\').append(unit);
            else if (unit < 32 || Character.isSurrogate(unit)) out.append(String.format("\\u%04x", (int) unit));
            else out.append(unit);
        }
        return out.append('"').toString();
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        try { writer.close(); } catch (IOException failure) { healthy = false; }
    }

    private static final class Scope {
        final int id;
        boolean finished;
        Scope(int id) { this.id = id; }
    }

    private final class RegistryView implements BeanDefinitionRegistry {
        private final BeanDefinitionRegistry delegate;
        private final Scope scope;

        RegistryView(BeanDefinitionRegistry delegate, Scope scope) {
            this.delegate = delegate;
            this.scope = scope;
        }

        @Override public void registerBeanDefinition(String name, BeanDefinition definition) {
            delegate.registerBeanDefinition(name, definition);
            mutation(scope, "register", name, null);
        }
        @Override public void removeBeanDefinition(String name) {
            delegate.removeBeanDefinition(name);
            mutation(scope, "remove", name, null);
        }
        @Override public void registerAlias(String name, String alias) {
            delegate.registerAlias(name, alias);
            mutation(scope, "alias", name, alias);
        }
        @Override public void removeAlias(String alias) {
            delegate.removeAlias(alias);
            mutation(scope, "unalias", alias, null);
        }
        @Override public BeanDefinition getBeanDefinition(String name) { return delegate.getBeanDefinition(name); }
        @Override public boolean containsBeanDefinition(String name) { return delegate.containsBeanDefinition(name); }
        @Override public String[] getBeanDefinitionNames() { return delegate.getBeanDefinitionNames(); }
        @Override public int getBeanDefinitionCount() { return delegate.getBeanDefinitionCount(); }
        @Override public boolean isBeanDefinitionOverridable(String name) { return delegate.isBeanDefinitionOverridable(name); }
        @Override public boolean isBeanNameInUse(String name) { return delegate.isBeanNameInUse(name); }
        @Override public boolean isAlias(String name) { return delegate.isAlias(name); }
        @Override public String[] getAliases(String name) { return delegate.getAliases(name); }
    }
}
