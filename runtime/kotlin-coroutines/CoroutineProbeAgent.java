package rocketbrain.coroutines;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class CoroutineProbeAgent {
    private static final String ROUTE = "/rocketbrain/coroutines";
    private static final int MAX_COROUTINES = 100;
    private static final int MAX_FRAMES = 40;

    private CoroutineProbeAgent() {}

    public static void premain(String argument, Instrumentation unused) {
        // Startup is explicit. The inspector never attaches to or mutates another running JVM.
        try {
            if (argument == null || argument.length() > 8192) throw new IllegalArgumentException("Invalid Rocketbrain probe launch arguments.");
            String descriptor = new String(Base64.getUrlDecoder().decode(argument), StandardCharsets.UTF_8);
            start(Path.of(descriptor));
        }
        catch (Exception error) { System.err.println("Rocketbrain coroutine probe startup failed: " + error.getClass().getSimpleName()); }
    }

    private static void start(Path descriptor) throws Exception {
        if (!descriptor.isAbsolute() || !descriptor.getFileName().toString().equals("coroutine-probe.json") ||
                !descriptor.equals(descriptor.normalize()) ||
                !descriptor.getParent().toRealPath().equals(descriptor.getParent()) || Files.exists(descriptor)) {
            throw new IllegalArgumentException("Expected a new local probe descriptor from Rocketbrain.");
        }
        byte[] tokenBytes = new byte[32];
        new SecureRandom().nextBytes(tokenBytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(tokenBytes);
        String session = UUID.randomUUID().toString();
        long pid = ProcessHandle.current().pid();
        var bind = new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0);
        var server = HttpServer.create(bind, 4);
        var executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(4),
                task -> daemon("Rocketbrain coroutine request", task));
        boolean started = false;
        byte[] metadata = null;
        try {
            server.setExecutor(executor);
            server.createContext(ROUTE, exchange -> answer(exchange, token, session, pid));
            // The JDK HTTP dispatcher inherits this thread's daemon setting.
            var starter = new FutureTask<Void>(() -> { server.start(); return null; });
            daemon("Rocketbrain coroutine loopback dispatcher", starter).start();
            starter.get(5, TimeUnit.SECONDS);
            metadata = json(Map.of("format", "RocketbrainCoroutineProbe", "version", 1,
                    "port", server.getAddress().getPort(), "session", session, "pid", pid, "token", token)).getBytes(StandardCharsets.UTF_8);
            Files.write(descriptor, metadata, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            byte[] ownedDescriptor = metadata;
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                server.stop(0);
                executor.shutdownNow();
                removeDescriptor(descriptor, ownedDescriptor);
            }, "Rocketbrain coroutine probe cleanup"));
            started = true;
        } finally {
            if (!started) {
                server.stop(0);
                executor.shutdownNow();
                if (metadata != null) removeDescriptor(descriptor, metadata);
            }
        }
    }

    private static Thread daemon(String name, Runnable task) {
        var thread = new Thread(task, name);
        thread.setDaemon(true);
        return thread;
    }

    private static void removeDescriptor(Path descriptor, byte[] expected) {
        try {
            if (Files.isRegularFile(descriptor, LinkOption.NOFOLLOW_LINKS) && Files.size(descriptor) == expected.length &&
                    MessageDigest.isEqual(Files.readAllBytes(descriptor), expected)) Files.deleteIfExists(descriptor);
        } catch (IOException ignored) { /* A stale descriptor cannot reconnect once the listener closes. */ }
    }

    private static void answer(HttpExchange exchange, String token, String session, long pid) throws IOException {
        try {
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            if (!"GET".equals(exchange.getRequestMethod()) || !ROUTE.equals(exchange.getRequestURI().toString())) {
                send(exchange, 404, Map.of("error", "Not found"));
            } else if (authorization == null || !MessageDigest.isEqual(authorization.getBytes(StandardCharsets.UTF_8),
                    ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) {
                send(exchange, 401, Map.of("error", "Unauthenticated"));
            } else {
                try { send(exchange, 200, snapshot(session, pid)); }
                catch (ReflectiveOperationException | RuntimeException | LinkageError unavailable) {
                    send(exchange, 409, Map.of("error", "Launch this JVM with the matching kotlinx-coroutines-debug startup agent."));
                }
            }
        } finally { exchange.close(); }
    }

    private static Map<String, Object> snapshot(String session, long pid) throws ReflectiveOperationException {
        ClassLoader application = ClassLoader.getSystemClassLoader();
        Class<?> probesType = Class.forName("kotlinx.coroutines.debug.DebugProbes", true, application);
        Object probes = probesType.getField("INSTANCE").get(null);
        if (!Boolean.TRUE.equals(probesType.getMethod("isInstalled").invoke(probes))) {
            throw new IllegalStateException("The official coroutine probes are not installed.");
        }
        boolean creationEnabled = Boolean.TRUE.equals(probesType.getMethod("getEnableCreationStackTraces").invoke(probes));
        List<?> infos = (List<?>) probesType.getMethod("dumpCoroutinesInfo").invoke(probes);
        Class<?> contextType = Class.forName("kotlin.coroutines.CoroutineContext", true, application);
        Class<?> keyType = Class.forName("kotlin.coroutines.CoroutineContext$Key", true, application);
        Class<?> nameType = Class.forName("kotlinx.coroutines.CoroutineName", true, application);
        Object nameKey = nameType.getField("Key").get(null);
        Method readContext = contextType.getMethod("get", keyType);
        var entries = new ArrayList<Map<String, Object>>();
        int count = Math.min(infos.size(), MAX_COROUTINES);
        for (int i = 0; i < count; i++) {
            Object info = infos.get(i);
            Class<?> type = info.getClass();
            Object name = readContext.invoke(type.getMethod("getContext").invoke(info), nameKey);
            String label = name == null ? "Coroutine " + (i + 1) : String.valueOf(nameType.getMethod("getName").invoke(name));
            entries.add(Map.of("name", clipped(label), "state", type.getMethod("getState").invoke(info).toString(),
                    "creation", frames((List<?>) type.getMethod("getCreationStackTrace").invoke(info)),
                    "observed", frames((List<?>) type.getMethod("lastObservedStackTrace").invoke(info))));
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("format", "RocketbrainCoroutineSnapshot");
        result.put("version", 1);
        result.put("session", session);
        result.put("pid", pid);
        result.put("capturedAt", Instant.now().toString());
        result.put("creationEnabled", creationEnabled);
        result.put("truncated", infos.size() > count);
        result.put("coroutines", entries);
        return result;
    }

    private static List<Map<String, Object>> frames(List<?> stack) {
        var result = new ArrayList<Map<String, Object>>();
        for (Object item : stack) {
            if (!(item instanceof StackTraceElement frame)) continue;
            result.add(Map.of("className", clipped(frame.getClassName()), "method", clipped(frame.getMethodName()),
                    "file", clipped(frame.getFileName() == null ? "" : frame.getFileName()), "line", frame.getLineNumber()));
            if (result.size() >= MAX_FRAMES) break;
        }
        return result;
    }

    private static String clipped(String value) { return value.length() > 200 ? value.substring(0, 200) : value; }

    private static void send(HttpExchange exchange, int status, Map<String, Object> value) throws IOException {
        byte[] encoded = json(value).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, encoded.length);
        exchange.getResponseBody().write(encoded);
    }

    private static String json(Object value) {
        if (value instanceof Map<?, ?> object) {
            var elements = new ArrayList<String>();
            object.forEach((key, item) -> elements.add(quoted(key.toString()) + ":" + json(item)));
            return "{" + String.join(",", elements) + "}";
        }
        if (value instanceof List<?> list) return "[" + String.join(",", list.stream().map(CoroutineProbeAgent::json).toList()) + "]";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        return quoted(String.valueOf(value));
    }

    private static String quoted(String text) {
        var out = new StringBuilder("\"");
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch == '"' || ch == '\\') out.append('\\').append(ch);
            else if (ch < 32 || Character.isSurrogate(ch)) out.append(String.format("\\u%04x", (int) ch));
            else out.append(ch);
        }
        return out.append('"').toString();
    }
}
