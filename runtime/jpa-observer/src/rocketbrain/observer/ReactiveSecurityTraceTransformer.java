package rocketbrain.observer;

import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassHierarchyResolver;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeTransform;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.lang.instrument.ClassFileTransformer;
import java.security.MessageDigest;
import java.security.ProtectionDomain;
import java.util.HexFormat;
import java.util.Map;

/** Installs probes only into the verified Spring Security and Spring Web classes. */
final class ReactiveSecurityTraceTransformer implements ClassFileTransformer {
    private static final String WEB = "org/springframework/web/server/";
    private static final String SECURITY = "org/springframework/security/web/server/";
    private static final String AUTH = "org/springframework/security/authorization/";
    private static final String EXCHANGE = "L" + WEB + "ServerWebExchange;";
    private static final String WEB_CHAIN = "L" + WEB + "WebFilterChain;";
    private static final String SECURITY_CHAIN = SECURITY + "SecurityWebFilterChain";
    private static final String DEFAULT_CHAIN = WEB + "handler/DefaultWebFilterChain";
    private static final String INVOCATION = "Lorg/aopalliance/intercept/MethodInvocation;";
    private static final String MONO = "Lreactor/core/publisher/Mono;";
    private static final String FLUX = "Lreactor/core/publisher/Flux;";
    private static final String MANAGER = AUTH + "ReactiveAuthorizationManager";
    private static final String AUTH_CALL = "(" + MONO + "Ljava/lang/Object;)" + MONO;
    private static final ClassDesc HELPER = ClassDesc.of("rocketbrain.observer.ReactiveSecurityTrace");
    private static final ClassDesc OBJECT = ClassDesc.of("java.lang.Object");
    private static final ClassDesc STRING = ClassDesc.of("java.lang.String");

    private enum Hook {
        PROXY("proxy", 3, "03cab2b9e9e7d4be261a3b673fff3843db99f538cf433f6e2cfe64f0539c8eb6"),
        FILTER("filter-execution", 1, "755611a2e42951785f6db638cdfc50f4ba82872d90977df82c30d36fa2aec491"),
        VERIFY("web-verification", 1, "4d19e5921101f5e0dcfa6f519ac92c0b3bf3d048617812fdcc5013747aff5366"),
        BEFORE("method-before", 2, "9713b03d6899e79302960204fa032bb3f542fd9b35f23955bba04e3670d829ad"),
        AFTER("method-after", 1, "32ec647e3f5756bf9db6dd12de24c4dc6b707da3c30eab12eb23b04b76cc961e");

        final String label;
        final int sites;
        final String sha256;

        Hook(String label, int sites, String sha256) {
            this.label = label;
            this.sites = sites;
            this.sha256 = sha256;
        }
    }

    private static final Map<String, Hook> CLASSES = Map.of(
        SECURITY + "WebFilterChainProxy", Hook.PROXY,
        DEFAULT_CHAIN, Hook.FILTER,
        SECURITY + "authorization/AuthorizationWebFilter", Hook.VERIFY,
        AUTH + "method/AuthorizationManagerBeforeReactiveMethodInterceptor", Hook.BEFORE,
        AUTH + "method/AuthorizationManagerAfterReactiveMethodInterceptor", Hook.AFTER);

    @Override
    public byte[] transform(Module module, ClassLoader loader, String name, Class<?> redefining,
                            ProtectionDomain domain, byte[] bytes) {
        Hook hook = name == null ? null : CLASSES.get(name);
        if (hook == null) return null;
        try {
            String fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!hook.sha256.equals(fingerprint)) throw new IllegalArgumentException("Unsupported artifact");
            if (Class.forName(ReactiveSecurityTrace.class.getName(), false, loader) != ReactiveSecurityTrace.class
                || (module != null && !module.canRead(ReactiveSecurityTrace.class.getModule()))) {
                throw new IllegalStateException("Trace helper unavailable");
            }
            int[] sites = {0};
            ClassFile format = ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(ClassHierarchyResolver.ofResourceParsing(loader)));
            byte[] transformed = format.transformClass(format.parse(bytes), (builder, element) -> {
                if (element instanceof MethodModel method) {
                    CodeTransform action = probe(hook, method, sites);
                    if (action != null) {
                        builder.transformMethod(method, MethodTransform.transformingCode(action));
                        return;
                    }
                }
                builder.with(element);
            });
            if (sites[0] != hook.sites) throw new IllegalStateException("Unsupported bytecode shape");
            ReactiveSecurityTrace.instrumented(hook.label);
            return transformed;
        } catch (Throwable error) {
            ObserverRuntime.warning("Reactive Spring Security probe unavailable for " + hook.label + " (" +
                error.getClass().getSimpleName() + ")");
            return null;
        }
    }

    private static CodeTransform probe(Hook hook, MethodModel method, int[] sites) {
        String name = method.methodName().stringValue();
        String descriptor = method.methodType().stringValue();
        return switch (hook) {
            case PROXY -> {
                if (name.equals("filter") && descriptor.equals("(" + EXCHANGE + WEB_CHAIN + ")" + MONO))
                    yield onReturn("root", sites, 1);
                if (name.equals("lambda$filterFirewalledExchange$0"))
                    yield afterCall(SECURITY_CHAIN, "matches", "(" + EXCHANGE + ")" + MONO, "matcher", MONO, sites, 1);
                if (name.equals("lambda$filterFirewalledExchange$2"))
                    yield afterCall(SECURITY_CHAIN, "getWebFilters", "()" + FLUX, "configured", FLUX, sites, 0);
                yield null;
            }
            case FILTER -> name.equals("invokeFilter") &&
                descriptor.equals("(L" + WEB + "WebFilter;L" + DEFAULT_CHAIN + ";" + EXCHANGE + ")" + MONO)
                ? onReturn("entered", sites, 0, 1) : null;
            case VERIFY -> name.equals("lambda$filter$1")
                ? afterCall(MANAGER, "verify", AUTH_CALL, "verified", MONO, sites, 0) : null;
            case BEFORE -> name.equals("preAuthorized") && descriptor.startsWith("(" + INVOCATION)
                ? methodDecision("before", 1, sites) : null;
            case AFTER -> name.equals("postAuthorize") &&
                descriptor.equals("(" + MONO + INVOCATION + "Ljava/lang/Object;)" + MONO)
                ? methodDecision("after", 2, sites) : null;
        };
    }

    private static CodeTransform onReturn(String method, int[] sites, int... locals) {
        return (code, element) -> {
            if (element instanceof ReturnInstruction ret && ret.typeKind() == TypeKind.REFERENCE) {
                sites[0]++;
                invokeProbe(code, method, MONO, locals);
            }
            code.with(element);
        };
    }

    private static CodeTransform afterCall(String owner, String name, String descriptor, String probe,
                                           String output, int[] sites, int... locals) {
        return (code, element) -> {
            code.with(element);
            if (calls(element, owner, name, descriptor)) {
                sites[0]++;
                invokeProbe(code, probe, output, locals);
            }
        };
    }

    private static CodeTransform methodDecision(String phase, int invocation, int[] sites) {
        return (code, element) -> {
            code.with(element);
            if (calls(element, MANAGER, "authorize", AUTH_CALL)) {
                sites[0]++;
                code.aload(invocation).ldc(phase).invokestatic(HELPER, "method", MethodTypeDesc.of(OBJECT, OBJECT, OBJECT, STRING))
                    .checkcast(ClassDesc.ofDescriptor(MONO));
            }
        };
    }

    private static boolean calls(CodeElement element, String owner, String name, String descriptor) {
        return element instanceof InvokeInstruction invoke && invoke.owner().asInternalName().equals(owner) &&
            invoke.name().equalsString(name) && invoke.type().equalsString(descriptor);
    }

    private static void invokeProbe(CodeBuilder code, String method, String output, int[] locals) {
        ClassDesc[] parameters = new ClassDesc[locals.length + 1];
        parameters[0] = OBJECT;
        for (int i = 0; i < locals.length; i++) {
            parameters[i + 1] = OBJECT;
            code.aload(locals[i]);
        }
        code.invokestatic(HELPER, method, MethodTypeDesc.of(OBJECT, parameters)).checkcast(ClassDesc.ofDescriptor(output));
    }
}
