package rocketbrain.coroutines;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.lang.ref.WeakReference;
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
import java.util.IdentityHashMap;
import java.util.HexFormat;
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
    private static final String CORE_SHA256 = "d1d75aa01dffbb4d1c520e67e4c4e7f5f6174718e7cb4632412503f2f0e604fa";
    private static volatile String debugSession;
    private static volatile long debugPid;
    private static volatile DebugCapture debugCapture;

    private record DebugCapture(String id, DebugFrame[] frames) {}
    private record DebugFrame(String sequence, String className, String file, int line, int label, WeakReference<Object> continuation) {}

    private CoroutineProbeAgent() {}

    public static void premain(String argument, Instrumentation unused) {
        // The application explicitly opts in before it starts accepting observers.
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
        int debugPort = approvedDebugPort();
        var bind = new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0);
        var server = HttpServer.create(bind, 4);
        var executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(4),
                task -> daemon("Rocketbrain coroutine request", task));
        boolean started = false;
        byte[] metadata = null;
        try {
            server.setExecutor(executor);
            server.createContext(ROUTE, exchange -> answer(exchange, token, session, pid, debugPort != 0));
            // The JDK HTTP dispatcher inherits this thread's daemon setting.
            var starter = new FutureTask<Void>(() -> { server.start(); return null; });
            daemon("Rocketbrain coroutine loopback dispatcher", starter).start();
            starter.get(5, TimeUnit.SECONDS);
            var details = new LinkedHashMap<>(Map.<String, Object>of("format", "RocketbrainCoroutineProbe", "version", 1,
                    "port", server.getAddress().getPort(), "session", session, "pid", pid, "token", token));
            if (debugPort != 0) {
                debugSession = session;
                debugPid = pid;
                details.put("debugPort", debugPort);
            }
            metadata = json(details).getBytes(StandardCharsets.UTF_8);
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

    private static int approvedDebugPort() {
        if (!Boolean.getBoolean("rocketbrain.coroutines.allowDebugger")) return 0;
        var launch = java.util.regex.Pattern.compile("^-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127\\.0\\.0\\.1:([1-9][0-9]{0,4})$");
        var agents = ManagementFactory.getRuntimeMXBean().getInputArguments().stream()
                .filter(value -> value.startsWith("-agentlib:jdwp") || value.startsWith("-Xrunjdwp")).toList();
        if (agents.size() != 1) return 0;
        var match = launch.matcher(agents.get(0));
        int port = match.matches() ? Integer.parseInt(match.group(1)) : 0;
        return port <= 65535 ? port : 0;
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

    private static void answer(HttpExchange exchange, String token, String session, long pid, boolean allowDebug) throws IOException {
        try {
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            if (!"GET".equals(exchange.getRequestMethod()) || !ROUTE.equals(exchange.getRequestURI().toString())) {
                send(exchange, 404, Map.of("error", "Not found"));
            } else if (authorization == null || !MessageDigest.isEqual(authorization.getBytes(StandardCharsets.UTF_8),
                    ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) {
                send(exchange, 401, Map.of("error", "Unauthenticated"));
            } else {
                try { send(exchange, 200, snapshot(session, pid, allowDebug)); }
                catch (ReflectiveOperationException | RuntimeException | LinkageError unavailable) {
                    send(exchange, 409, Map.of("error", "Launch this JVM with the matching kotlinx-coroutines-debug startup agent."));
                }
            }
        } finally { exchange.close(); }
    }

    private static Map<String, Object> snapshot(String session, long pid, boolean allowDebug) throws ReflectiveOperationException {
        ClassLoader application = ClassLoader.getSystemClassLoader();
        Class<?> probesType = Class.forName("kotlinx.coroutines.debug.DebugProbes", true, application);
        Object probes = probesType.getField("INSTANCE").get(null);
        if (!Boolean.TRUE.equals(probesType.getMethod("isInstalled").invoke(probes))) {
            throw new IllegalStateException("The official coroutine probes are not installed.");
        }
        boolean creationEnabled = Boolean.TRUE.equals(probesType.getMethod("getEnableCreationStackTraces").invoke(probes));
        if (allowDebug) debugCapture = null;
        var debug = allowDebug ? DebugObservation.create(application) : null;
        List<?> infos = debug == null ? (List<?>) probesType.getMethod("dumpCoroutinesInfo").invoke(probes) : debug.infos();
        Class<?> contextType = Class.forName("kotlin.coroutines.CoroutineContext", true, application);
        Class<?> keyType = Class.forName("kotlin.coroutines.CoroutineContext$Key", true, application);
        Class<?> nameType = Class.forName("kotlinx.coroutines.CoroutineName", true, application);
        Object nameKey = nameType.getField("Key").get(null);
        Method readContext = contextType.getMethod("get", keyType);
        JobObservation jobs = JobObservation.create(application);
        var entries = new ArrayList<Map<String, Object>>();
        int count = Math.min(infos.size(), MAX_COROUTINES);
        var targets = debug == null ? null : new DebugFrame[count];
        for (int i = 0; i < count; i++) {
            Object info = infos.get(i);
            Class<?> type = info.getClass();
            Object context = type.getMethod("getContext").invoke(info);
            Object name = readContext.invoke(context, nameKey);
            String label = name == null ? "Coroutine " + (i + 1) : String.valueOf(nameType.getMethod("getName").invoke(name));
            entries.add(new LinkedHashMap<>(Map.of("name", clipped(label), "state", type.getMethod("getState").invoke(info).toString(),
                    "creation", frames((List<?>) type.getMethod("getCreationStackTrace").invoke(info)),
                    "observed", frames((List<?>) type.getMethod("lastObservedStackTrace").invoke(info)))));
            if (jobs != null) jobs.observe(readContext.invoke(context, jobs.key()), i);
            if (debug != null && "SUSPENDED".equals(entries.get(i).get("state"))) {
                var target = debug.find(info);
                if (target != null) {
                    targets[i] = target;
                    entries.get(i).put("debugFrame", Map.of("sequence", target.sequence(), "className", target.className(),
                            "file", target.file(), "line", target.line()));
                }
            }
        }
        if (jobs != null) jobs.addRelationships(entries);
        if (targets != null) {
            var identities = new IdentityHashMap<Object, Integer>();
            for (var item : targets) {
                Object continuation = item == null ? null : item.continuation().get();
                if (continuation != null) identities.merge(continuation, 1, Integer::sum);
            }
            for (int i = 0; i < targets.length; i++) {
                if (targets[i] != null && identities.getOrDefault(targets[i].continuation().get(), 0) != 1) {
                    targets[i] = null;
                    entries.get(i).remove("debugFrame");
                }
            }
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
        if (targets != null) {
            var key = UUID.randomUUID().toString();
            debugCapture = new DebugCapture(key, targets);
            result.put("debugCapture", key);
        }
        return result;
    }

    private record DebugObservation(List<?> infos, Class<?> suspendLambda, Method sequence, Method lastFrame,
                                    Method caller, Method location) {
        static DebugObservation create(ClassLoader loader) {
            try {
                var impl = Class.forName("kotlinx.coroutines.debug.internal.DebugProbesImpl", false, loader);
                var location = Path.of(impl.getProtectionDomain().getCodeSource().getLocation().toURI());
                if (!Files.isRegularFile(location, LinkOption.NOFOLLOW_LINKS) || Files.size(location) > 8 * 1024 * 1024 ||
                        !HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(location))).equals(CORE_SHA256)) return null;
                var info = Class.forName("kotlinx.coroutines.debug.internal.DebugCoroutineInfo", false, loader);
                var frame = Class.forName("kotlin.coroutines.jvm.internal.CoroutineStackFrame", false, loader);
                var lambda = Class.forName("kotlin.coroutines.jvm.internal.SuspendLambda", false, loader);
                return new DebugObservation((List<?>) impl.getMethod("dumpCoroutinesInfo").invoke(impl.getField("INSTANCE").get(null)),
                        lambda, info.getMethod("getSequenceNumber"), info.getMethod("getLastObservedFrame"),
                        frame.getMethod("getCallerFrame"), frame.getMethod("getStackTraceElement"));
            } catch (ReflectiveOperationException | IOException | java.net.URISyntaxException |
                     java.security.NoSuchAlgorithmException | RuntimeException | LinkageError unavailable) {
                return null;
            }
        }

        DebugFrame find(Object info) {
            try {
                Object frame = lastFrame.invoke(info);
                for (int depth = 0; frame != null && depth < MAX_FRAMES; depth++, frame = caller.invoke(frame)) {
                    if (!suspendLambda.isInstance(frame)) continue;
                    var at = (StackTraceElement) location.invoke(frame);
                    if (at != null && at.getLineNumber() > 0 && "invokeSuspend".equals(at.getMethodName()) &&
                            frame.getClass().getName().equals(at.getClassName()) && at.getFileName() != null &&
                            at.getFileName().matches("[\\p{L}\\p{N}_.-]{1,150}\\.kt")) {
                        var field = frame.getClass().getDeclaredField("label");
                        if (field.getType() != int.class || !field.trySetAccessible()) return null;
                        int label = field.getInt(frame);
                        if (label < 1) return null;
                        return new DebugFrame(sequence.invoke(info).toString(), at.getClassName(), at.getFileName(),
                                at.getLineNumber(), label, new WeakReference<>(frame));
                    }
                }
            } catch (ReflectiveOperationException | RuntimeException unavailable) {
                // A frame without usable Kotlin continuation metadata is still available in the source list.
            }
            return null;
        }
    }

    private record JobObservation(Object key, Method readParent, List<Object> byOrdinal,
                                  Map<Object, Integer> ordinals) {
        static JobObservation create(ClassLoader loader) {
            try {
                var job = Class.forName("kotlinx.coroutines.Job", false, loader);
                var builtIn = Class.forName("kotlinx.coroutines.JobSupport", false, loader);
                return new JobObservation(job.getField("Key").get(null), builtIn.getMethod("getParent"),
                        new ArrayList<>(), new IdentityHashMap<>());
            } catch (ReflectiveOperationException | LinkageError unavailable) {
                return null;
            }
        }

        void observe(Object job, int ordinal) {
            byOrdinal.add(job);
            if (job != null) ordinals.merge(job, ordinal, (first, second) -> -1);
        }

        void addRelationships(List<Map<String, Object>> entries) {
            for (int i = 0; i < byOrdinal.size(); i++) {
                Object job = byOrdinal.get(i);
                if (job == null || ordinals.get(job) != i || !readParent.getDeclaringClass().isInstance(job)) continue;
                try {
                    // Read only the kotlinx implementation and correlate by object identity inside this capture.
                    if (!job.getClass().getMethod("getParent").equals(readParent)) continue;
                    Object parent = readParent.invoke(job);
                    var entry = entries.get(i);
                    if (parent == null) entry.put("jobRelationship", "no-parent-observed");
                    else if (parent != job && ordinals.getOrDefault(parent, -1) >= 0) {
                        entry.put("jobRelationship", "parent-observed");
                        entry.put("parentOrdinal", ordinals.get(parent));
                    } else if (parent != job) entry.put("jobRelationship", "parent-outside-capture");
                } catch (ReflectiveOperationException | RuntimeException unavailable) {
                    // The existing state and stack inspection remain available.
                }
            }
        }
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
