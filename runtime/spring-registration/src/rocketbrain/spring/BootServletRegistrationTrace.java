package rocketbrain.spring;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;

import org.springframework.aot.AotDetector;
import org.springframework.beans.factory.support.BeanDefinitionRegistryPostProcessor;
import org.springframework.beans.factory.BeanRegistrar;
import org.springframework.context.ApplicationContextInitializer;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.web.server.servlet.context.AnnotationConfigServletWebServerApplicationContext;

/**
 * Observes one explicitly selected, source-owned Spring Boot 4 servlet context.
 * Supply the factory to a SpringApplication and run and close the application
 * inside the callback. Normal Spring Boot startup and ordering remain in use.
 *
 * <pre>{@code
 * BootServletRegistrationTrace.observe(traceFile, "dev startup", contextFactory -> {
 *     var application = new SpringApplication(MyApplication.class);
 *     application.setApplicationContextFactory(contextFactory);
 *     try (var context = application.run(args)) {
 *         // Use the selected context here.
 *         return null;
 *     }
 * });
 * }</pre>
 */
public final class BootServletRegistrationTrace {
    private static final StackWalker STACKS = StackWalker.getInstance();
    private static final String BOOT_AOT = "org.springframework.boot.SpringApplicationAotProcessor";
    private static final String CONTEXT_AOT = "org.springframework.context.aot.ContextAotProcessor";

    private BootServletRegistrationTrace() {}

    public static <T> T observe(Path file, String label, Function<ApplicationContextFactory,T> run) throws IOException {
        Objects.requireNonNull(label,"label");
        Objects.requireNonNull(run,"run");
        if (label.isEmpty() || label.length()>512) throw new IllegalArgumentException("Choose a short trace label");
        requireRuntime();
        try (var trace = RegistrationTrace.openFactory(file,BootServletRegistrationTrace::providerCallback)) {
            return trace.observeFactory(label, factory -> {
                var used = new AtomicBoolean();
                var active = new AtomicBoolean(true);
                try {
                    return run.apply(type -> {
                        requireRuntime();
                        if (!active.get() || type != WebApplicationType.SERVLET || !used.compareAndSet(false,true)) {
                            throw new IllegalStateException("Use this trace factory for a single Spring Boot servlet context in its active observation");
                        }
                        return new AnnotationConfigServletWebServerApplicationContext(factory);
                    });
                } finally {
                    active.set(false);
                }
            });
        }
    }

    private static boolean providerCallback(StackWalker.StackFrame frame) {
        Class<?> type = frame.getDeclaringClass();
        return switch (frame.getMethodName()) {
            case "initialize" -> ApplicationContextInitializer.class.isAssignableFrom(type);
            case "postProcessBeanDefinitionRegistry" -> BeanDefinitionRegistryPostProcessor.class.isAssignableFrom(type);
            case "registerBeanDefinitions" -> ImportBeanDefinitionRegistrar.class.isAssignableFrom(type);
            case "register" -> BeanRegistrar.class.isAssignableFrom(type);
            default -> false;
        };
    }

    private static void requireRuntime() {
        if (AotDetector.useGeneratedArtifacts() || STACKS.walk(frames -> frames.anyMatch(frame ->
                inProcessor(frame.getClassName(),BOOT_AOT) || inProcessor(frame.getClassName(),CONTEXT_AOT)))) {
            throw new IllegalStateException("Spring Boot servlet registration tracing requires an ordinary JVM runtime");
        }
    }

    private static boolean inProcessor(String type,String processor) {
        return type.equals(processor) || type.startsWith(processor+"$");
    }
}
