package rocketbrain.observer;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Function;

/** Metadata scoped to the original WebFlux subscription by an opaque Reactor Context key. */
public final class ReactiveSecurityTrace {
    private static final String SPRING = "org.springframework.";
    private static final String WEB = SPRING + "web.server.";
    private static final String HTTP = SPRING + "http.";
    private static final String SECURITY = SPRING + "security.";
    private static final String REACTOR = "reactor.core.publisher.";
    private static final int MAX_MATCHES = 16, MAX_FILTERS = 32, MAX_METHODS = 8, MAX_RECENT = 16;
    private static final Object KEY = new Object();
    private static final AtomicInteger active = new AtomicInteger();
    private static final AtomicLong ids = new AtomicLong();
    private static final Set<String> HOOKS = new LinkedHashSet<>();
    private static final ArrayDeque<Map<String, Object>> RECENT = new ArrayDeque<>();
    private static final Set<String> HTTP_METHODS = Set.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT");
    private static volatile boolean enabled;
    private static long dropped;

    private ReactiveSecurityTrace() {}

    static boolean enabled() { return enabled; }

    static synchronized void configure(boolean value) {
        enabled = value;
        HOOKS.clear();
        RECENT.clear();
        dropped = 0;
    }

    static synchronized void instrumented(String hook) { HOOKS.add(hook); }

    private static synchronized void retain(Map<String, Object> report) {
        if (!enabled) return;
        if (RECENT.size() == MAX_RECENT) {
            RECENT.removeFirst();
            dropped++;
        }
        RECENT.addLast(report);
    }

    static synchronized Map<String, Object> snapshot() {
        return Map.of("schemaVersion", 1, "enabled", enabled, "state", !enabled ? "disabled" :
            HOOKS.contains("proxy") ? "ready" : "waiting", "hooks", List.copyOf(HOOKS), "dropped", dropped,
            "traces", List.copyOf(RECENT));
    }

    public static Object root(Object publisher, Object exchange) {
        return contextual(publisher, false, (reactor, source, context) -> {
            if (!enabled || reactor.trace(context) != null) return source;
            if (active.incrementAndGet() > 128) {
                active.decrementAndGet();
                synchronized (ReactiveSecurityTrace.class) { dropped++; }
                return source;
            }
            try {
                Trace trace = new Trace(httpMethod(exchange));
                Object terminal = reactor.monoFinally.invoke(source, (Consumer<Object>) signal -> {
                    safely(() -> {
                        Integer status = status(exchange);
                        retain(trace.finish(status, signal instanceof Enum<?> kind ? kind.name() : ""));
                    });
                    active.decrementAndGet();
                });
                return reactor.contextWrite.invoke(terminal, (Function<Object, Object>) original -> {
                    try { return reactor.put.invoke(original, KEY, trace); }
                    catch (Throwable ignored) { return original; }
                });
            } catch (Throwable ignored) {
                active.decrementAndGet();
                return source;
            }
        });
    }

    public static Object matcher(Object publisher, Object chain) {
        return observed(publisher, false, (reactor, source, trace) -> {
            Match match = trace.matcher(chain);
            if (match == null) return source;
            return reactor.monoSuccess.invoke(source, (Consumer<Object>) result -> safely(() ->
                trace.matched(match, result instanceof Boolean value ? value : null)));
        });
    }

    public static Object configured(Object publisher, Object chain) {
        return observed(publisher, true, (reactor, source, trace) -> {
            if (!trace.select(chain)) return source;
            Object emissions = reactor.fluxNext.invoke(source, (Consumer<Object>) filter -> safely(() -> trace.configured(filter)));
            return reactor.fluxComplete.invoke(emissions, (Runnable) () -> safely(trace::configuredComplete));
        });
    }

    public static Object entered(Object publisher, Object chain, Object filter) {
        return observed(publisher, false, (reactor, source, trace) -> {
            Object configured = read(chain, WEB + "handler.DefaultWebFilterChain", "getFilters");
            if (configured instanceof List<?> filters) trace.entered(filters, filter);
            return source;
        });
    }

    public static Object verified(Object publisher, Object filter) {
        return observed(publisher, false, (reactor, source, trace) -> {
            Object success = reactor.monoSuccess.invoke(source, (Consumer<Object>) ignored ->
                safely(() -> trace.verification(filter, "passed")));
            return reactor.monoError.invoke(success, (Consumer<Throwable>) error -> safely(() -> {
                if (denial(error)) trace.verification(filter, "denied");
            }));
        });
    }

    public static Object method(Object publisher, Object invocation, String phase) {
        return observed(publisher, false, (reactor, source, trace) -> {
            Object value = read(invocation, "org.aopalliance.intercept.MethodInvocation", "getMethod");
            if (!(value instanceof Method resolved)) return source;
            MethodTarget target = MethodTarget.from(resolved);
            Object success = reactor.monoSuccess.invoke(source, (Consumer<Object>) decision -> safely(() -> {
                if (decision == null) trace.method(phase, target, "abstained");
                else {
                    Object granted = read(decision, SECURITY + "authorization.AuthorizationResult", "isGranted");
                    if (granted instanceof Boolean allowed) trace.method(phase, target, allowed ? "granted" : "denied");
                    else trace.incomplete();
                }
            }));
            return reactor.monoError.invoke(success, (Consumer<Throwable>) error -> safely(() -> {
                if (denial(error)) trace.method(phase, target, "denied");
            }));
        });
    }

    private static boolean denial(Throwable error) throws ReflectiveOperationException {
        return Class.forName(SECURITY + "access.AccessDeniedException", false, error.getClass().getClassLoader()).isInstance(error);
    }

    private static String httpMethod(Object exchange) {
        try {
            Object request = read(exchange, WEB + "ServerWebExchange", "getRequest");
            Object method = read(request, HTTP + "HttpRequest", "getMethod");
            Object name = read(method, HTTP + "HttpMethod", "name");
            return name instanceof String value && HTTP_METHODS.contains(value) ? value : "OTHER";
        } catch (Throwable ignored) { return "OTHER"; }
    }

    private static Integer status(Object exchange) {
        try {
            Object response = read(exchange, WEB + "ServerWebExchange", "getResponse");
            Object status = read(response, HTTP + "server.reactive.ServerHttpResponse", "getStatusCode");
            Object value = read(status, HTTP + "HttpStatusCode", "value");
            return value instanceof Integer code && code >= 100 && code <= 599 ? code : null;
        } catch (Throwable ignored) { return null; }
    }

    private static Object read(Object target, String api, String method) throws ReflectiveOperationException {
        if (target == null) return null;
        Class<?> type = Class.forName(api, false, target.getClass().getClassLoader());
        return type.isInstance(target) ? type.getMethod(method).invoke(target) : null;
    }

    private static String symbol(String value) {
        return value != null && value.length() <= 192 && value.matches("[A-Za-z0-9_.$]+") ? value : null;
    }

    private static String className(Object target) {
        return target == null ? null : symbol(target.getClass().getName());
    }

    @FunctionalInterface private interface Checked { void run() throws ReflectiveOperationException; }
    @FunctionalInterface private interface Scope { Object observe(Operators reactor, Object source, Object context) throws ReflectiveOperationException; }
    @FunctionalInterface private interface Observation { Object observe(Operators reactor, Object source, Trace trace) throws ReflectiveOperationException; }

    private static void safely(Checked action) {
        try { action.run(); } catch (Throwable ignored) {}
    }

    private static Object observed(Object publisher, boolean flux, Observation hook) {
        return contextual(publisher, flux, (reactor, source, context) -> {
            Trace trace = reactor.trace(context);
            return trace == null ? source : hook.observe(reactor, source, trace);
        });
    }

    private static Object contextual(Object publisher, boolean flux, Scope hook) {
        if (!enabled || publisher == null) return publisher;
        try {
            Operators reactor = operators.get(publisher.getClass());
            return (flux ? reactor.fluxContext : reactor.monoContext).invoke(publisher,
                (BiFunction<Object, Object, Object>) (source, context) -> {
                    try { return hook.observe(reactor, source, context); }
                    catch (Throwable ignored) { return source; }
                });
        } catch (Throwable ignored) { return publisher; }
    }

    private static final ClassValue<Operators> operators = new ClassValue<>() {
        @Override protected Operators computeValue(Class<?> type) {
            try { return new Operators(type.getClassLoader()); }
            catch (ReflectiveOperationException failure) { throw new IllegalStateException(failure); }
        }
    };

    private static final class Operators {
        final Method monoContext, fluxContext, contextWrite, get, put, monoSuccess, monoError, monoFinally, fluxNext, fluxComplete;

        Operators(ClassLoader loader) throws ReflectiveOperationException {
            Class<?> mono = Class.forName(REACTOR + "Mono", false, loader);
            Class<?> flux = Class.forName(REACTOR + "Flux", false, loader);
            Class<?> view = Class.forName("reactor.util.context.ContextView", false, loader);
            Class<?> context = Class.forName("reactor.util.context.Context", false, loader);
            monoContext = mono.getMethod("transformDeferredContextual", BiFunction.class);
            fluxContext = flux.getMethod("transformDeferredContextual", BiFunction.class);
            contextWrite = mono.getMethod("contextWrite", Function.class);
            get = view.getMethod("getOrDefault", Object.class, Object.class);
            put = context.getMethod("put", Object.class, Object.class);
            monoSuccess = mono.getMethod("doOnSuccess", Consumer.class);
            monoError = mono.getMethod("doOnError", Consumer.class);
            monoFinally = mono.getMethod("doFinally", Consumer.class);
            fluxNext = flux.getMethod("doOnNext", Consumer.class);
            fluxComplete = flux.getMethod("doOnComplete", Runnable.class);
        }

        Trace trace(Object context) throws ReflectiveOperationException {
            Object value = get.invoke(context, KEY, null);
            return value instanceof Trace trace ? trace : null;
        }
    }

    private record MethodTarget(String owner, String method, List<String> parameters) {
        static MethodTarget from(Method method) {
            List<String> parameters = null;
            if (method.getParameterCount() <= 16) {
                List<String> observed = new ArrayList<>();
                for (Class<?> parameter : method.getParameterTypes()) {
                    String type = parameter.getTypeName();
                    if (type.length() > 192 || !type.matches("[A-Za-z0-9_.$]+(\\[\\])*")) break;
                    observed.add(type);
                }
                if (observed.size() == method.getParameterCount()) parameters = List.copyOf(observed);
            }
            return new MethodTarget(symbol(method.getDeclaringClass().getName()), symbol(method.getName()), parameters);
        }
    }

    private static final class Match {
        final Object chain;
        Boolean matched;

        Match(Object chain) { this.chain = chain; }
    }

    private static final class Trace {
        final long id = ids.incrementAndGet(), started = System.nanoTime();
        final Instant at = Instant.now();
        final String requestMethod;
        final List<Match> matches = new ArrayList<>();
        final List<Object> configured = new ArrayList<>();
        final List<Map<String, Object>> methods = new ArrayList<>();
        int selected = -1, entered;
        boolean gotConfiguration, incomplete, finished;
        String verification = "unobserved";

        Trace(String requestMethod) { this.requestMethod = requestMethod; }

        synchronized Match matcher(Object chain) {
            if (finished) return null;
            if (matches.size() == MAX_MATCHES) {
                incomplete = true;
                return null;
            }
            Match match = new Match(chain);
            matches.add(match);
            return match;
        }

        synchronized void matched(Match match, Boolean value) {
            if (!finished) match.matched = value;
        }

        synchronized boolean select(Object chain) {
            if (finished) return false;
            if (selected >= 0) {
                incomplete = true;
                return false;
            }
            for (int index = 0; index < matches.size(); index++) {
                Match match = matches.get(index);
                if (match.chain == chain && Boolean.TRUE.equals(match.matched)) {
                    selected = index;
                    return true;
                }
            }
            incomplete = true;
            return false;
        }

        synchronized void configured(Object filter) {
            if (finished) return;
            if (configured.size() == MAX_FILTERS) incomplete = true;
            else configured.add(filter);
        }

        synchronized void configuredComplete() { if (!finished) gotConfiguration = true; }
        synchronized void incomplete() { if (!finished) incomplete = true; }

        synchronized void entered(List<?> chain, Object filter) {
            if (finished || !gotConfiguration || chain.size() != configured.size() || entered >= configured.size()) return;
            for (int index = 0; index < configured.size(); index++) {
                if (configured.get(index) != chain.get(index)) return;
            }
            if (configured.get(entered) == filter) entered++;
            else incomplete = true;
        }

        synchronized void verification(Object filter, String outcome) {
            if (finished || !gotConfiguration || configured.stream().noneMatch(candidate -> candidate == filter)) return;
            if (!verification.equals("unobserved")) incomplete = true;
            else verification = outcome;
        }

        synchronized void method(String phase, MethodTarget target, String decision) {
            if (finished) return;
            if (methods.size() == MAX_METHODS) {
                incomplete = true;
                return;
            }
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("phase", phase);
            event.put("owner", target.owner());
            event.put("method", target.method());
            event.put("parameterTypes", target.parameters());
            event.put("decision", decision);
            methods.add(event);
        }

        synchronized Map<String, Object> finish(Integer status, String signal) {
            finished = true;
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("id", id);
            report.put("startedAt", at.toString());
            report.put("method", requestMethod);
            report.put("status", status);
            report.put("terminal", switch (signal) {
                case "ON_COMPLETE" -> "completed";
                case "ON_ERROR" -> "error";
                case "CANCEL" -> "canceled";
                default -> "unobserved";
            });
            report.put("durationMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            report.put("coverage", !incomplete && signal.equals("ON_COMPLETE") && gotConfiguration && (configured.isEmpty() || entered > 0) ? "observed" : "partial");
            report.put("matches", matches.stream().map(match -> {
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("type", className(match.chain));
                result.put("matched", match.matched);
                return result;
            }).toList());
            report.put("selectedChain", selected >= 0 ? selected : null);
            report.put("configured", configured.stream().map(ReactiveSecurityTrace::className).toList());
            report.put("entered", entered);
            report.put("verification", verification);
            report.put("methodDecisions", List.copyOf(methods));
            matches.clear();
            configured.clear();
            return report;
        }
    }
}
