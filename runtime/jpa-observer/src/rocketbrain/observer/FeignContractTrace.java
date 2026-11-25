package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.lang.reflect.Method;
import java.net.URI;
import java.security.MessageDigest;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Captures description data returned to the real Feign proxy factory. */
public final class FeignContractTrace {
    private static final String HOOK_CLASS = "feign/ReflectiveFeign$ParseHandlersByName";
    private static final String FINGERPRINT = "143fdc98a48536b364e32039f50ed6890afc3d81eae5b6b8567e69afdbe65c7d";
    private static final String TARGET = "feign.Target$HardCodedTarget";
    private static final String METADATA = "feign.MethodMetadata";
    private static final String TEMPLATE = "feign.RequestTemplate";
    private static final Set<String> VERBS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT");
    private static final int MAX_CLIENTS = 32, MAX_METHODS = 64;
    private static final ClassDesc HELPER = ClassDesc.of("rocketbrain.observer.FeignContractTrace");
    private static final ClassDesc OBJECT = ClassDesc.of("java.lang.Object");
    private static final ClassDesc VOID = ClassDesc.ofDescriptor("V");
    private static final Map<String, Map<String, Object>> CLIENTS = new LinkedHashMap<>();
    private static volatile boolean enabled;
    private static String state = "disabled";
    private static long dropped;

    private FeignContractTrace() {}

    static synchronized void configure(boolean value) {
        enabled = value;
        state = value ? "waiting" : "disabled";
        dropped = 0;
        CLIENTS.clear();
    }

    static boolean enabled() { return enabled; }

    private static synchronized void hook(String value) {
        if (enabled && !state.equals("ready")) state = value;
    }

    static synchronized Map<String, Object> snapshot() {
        return Map.of("schemaVersion", 1, "enabled", enabled, "state", state,
            "dropped", dropped, "clients", List.copyOf(CLIENTS.values()));
    }

    private static synchronized void retain(Map<String, Object> data) {
        if (!enabled) return;
        String key = Json.encode(data);
        if (CLIENTS.containsKey(key)) return;
        if (CLIENTS.size() == MAX_CLIENTS) {
            CLIENTS.remove(CLIENTS.keySet().iterator().next());
            dropped++;
        }
        CLIENTS.put(key, data);
    }

    public static void observe(Object metadata, Object type, Object target, Object contract) {
        if (!enabled || !(type instanceof Class<?> client) || !client.isInterface() || contract == null ||
            symbol(client.getName()) == null || symbol(contract.getClass().getName()) == null ||
            !(metadata instanceof List<?> items) || !safeList(items)) return;
        try {
            String base = basePath(target);
            List<Map<String, Object>> methods = new ArrayList<>();
            int unavailable = Math.max(0, items.size() - MAX_METHODS), inspected = 0;
            for (Object item : items) {
                if (++inspected > MAX_METHODS) break;
                Map<String, Object> row = row(client, item, base);
                if (row == null) unavailable++;
                else methods.add(row);
            }
            methods.sort(Comparator.comparing(item -> item.get("declaration") + "#" + item.get("name") + item.get("parameters")));
            retain(Map.of("client", client.getName(), "contract", contract.getClass().getName(),
                "basePathObserved", base != null, "methods", List.copyOf(methods), "unavailable", unavailable));
        } catch (Throwable ignored) {
            // A probe must leave the proxy factory's return value and exceptions intact.
        }
    }

    private static boolean safeList(List<?> items) {
        Class<?> type = items.getClass();
        return type == ArrayList.class || type.getClassLoader() == null &&
            Set.of("java.util.ImmutableCollections$List12", "java.util.ImmutableCollections$ListN").contains(type.getName());
    }

    private static Map<String, Object> row(Class<?> client, Object item, String base) throws ReflectiveOperationException {
        if (!exactType(item, METADATA)) return null;
        Object bound = call(item, "method");
        if (!(bound instanceof Method reflected) || reflected.getParameterCount() > 16 ||
            !reflected.getDeclaringClass().isAssignableFrom(client) || symbol(reflected.getDeclaringClass().getName()) == null ||
            symbol(reflected.getName()) == null) return null;
        Object template = call(item, "template");
        if (!exactType(template, TEMPLATE)) return null;
        Object rawVerb = call(template, "method"), rawPath = call(template, "path");
        if (!(rawVerb instanceof String verb) || !VERBS.contains(verb) || !(rawPath instanceof String path) || !path(path)) return null;
        List<String> parameters = new ArrayList<>();
        for (Class<?> parameter : reflected.getParameterTypes()) {
            String signature = parameter.getTypeName();
            if (signature.length() > 192 || !signature.matches("[A-Za-z0-9_.$]+(\\[\\])*")) return null;
            parameters.add(signature);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("declaration", reflected.getDeclaringClass().getName());
        result.put("name", reflected.getName());
        result.put("parameters", List.copyOf(parameters));
        result.put("inherited", reflected.getDeclaringClass() != client);
        result.put("verb", verb);
        result.put("template", path);
        String route = base == null ? null : base.replaceFirst("/$", "") + path;
        result.put("path", route != null && path(route) ? route : null);
        return result;
    }

    private static String basePath(Object target) {
        if (!exactType(target, TARGET)) return null;
        try {
            Object raw = call(target, "url");
            if (!(raw instanceof String url) || url.length() > 2048) return null;
            URI uri = URI.create(url);
            if (!Set.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null) return null;
            String path = uri.getRawPath();
            return path != null && (path.isEmpty() || path(path)) ? path : null;
        } catch (Throwable ignored) { return null; }
    }

    private static boolean path(String value) {
        return value.length() <= 512 && !value.startsWith("//") && value.matches("/[A-Za-z0-9_.~/{}/%:+*()\\-]*");
    }

    private static boolean exactType(Object target, String name) {
        return target != null && target.getClass().getName().equals(name);
    }

    private static Object call(Object target, String method) throws ReflectiveOperationException {
        return target.getClass().getMethod(method).invoke(target);
    }

    private static String symbol(String value) {
        return value.length() <= 192 && value.matches("[A-Za-z0-9_.$]+") ? value : null;
    }

    static final class Transformer implements ClassFileTransformer {
        @Override public byte[] transform(Module module, ClassLoader loader, String name, Class<?> redefined,
                                          ProtectionDomain domain, byte[] bytes) {
            if (!HOOK_CLASS.equals(name)) return null;
            try {
                String fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                if (!FINGERPRINT.equals(fingerprint) || Class.forName(FeignContractTrace.class.getName(), false, loader) != FeignContractTrace.class ||
                    module != null && !module.canRead(FeignContractTrace.class.getModule())) {
                    hook("unsupported");
                    return null;
                }
                int[] sites = {0};
                ClassFile format = ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
                byte[] parsed = format.transformClass(format.parse(bytes), (builder, element) -> {
                    if (element instanceof MethodModel method && method.methodName().equalsString("apply") &&
                        method.methodType().equalsString("(Lfeign/Target;Ljava/lang/Object;)Ljava/util/Map;")) {
                        builder.transformMethod(method, MethodTransform.transformingCode((code, instruction) -> {
                            if (instruction instanceof InvokeInstruction invoke && invoke.owner().asInternalName().equals("feign/Contract") &&
                                invoke.name().equalsString("parseAndValidateMetadata") &&
                                invoke.type().equalsString("(Ljava/lang/Class;)Ljava/util/List;")) {
                                sites[0]++;
                                int type = code.allocateLocal(TypeKind.REFERENCE), contract = code.allocateLocal(TypeKind.REFERENCE);
                                code.astore(type).astore(contract).aload(contract).aload(type).with(instruction);
                                code.dup().aload(type).aload(1).aload(contract).invokestatic(HELPER, "observe",
                                    MethodTypeDesc.of(VOID, OBJECT, OBJECT, OBJECT, OBJECT));
                            } else code.with(instruction);
                        }));
                    } else builder.with(element);
                });
                if (sites[0] != 1) throw new IllegalStateException("Unsupported Feign shape");
                hook("ready");
                return parsed;
            } catch (Throwable error) {
                hook("unsupported");
                ObserverRuntime.warning("OpenFeign contract probe unavailable (" + error.getClass().getSimpleName() + ")");
                return null;
            }
        }
    }
}
