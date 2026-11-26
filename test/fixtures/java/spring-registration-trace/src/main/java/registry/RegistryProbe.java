package registry;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.BeanDefinitionRegistryPostProcessor;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import rocketbrain.spring.RegistrationTrace;

public final class RegistryProbe {
    private static final AtomicInteger CREATED = new AtomicInteger();

    public record Selected(String color) {}

    static void dynamicRegister(BeanDefinitionRegistry registry, String color) {
        String name = "selected" + color;
        var selected = new RootBeanDefinition(Selected.class, () -> {
            CREATED.incrementAndGet();
            return new Selected(color);
        });
        selected.setLazyInit(true);
        registry.registerBeanDefinition(name, selected); // REGISTRATION_ORIGIN
        registry.registerAlias(name, "selected");
        registry.registerAlias(name, "temporaryAlias");
        registry.removeAlias("temporaryAlias");
        registry.registerBeanDefinition("unused", new RootBeanDefinition(Selected.class));
        registry.removeBeanDefinition("unused");
    }

    public static void main(String[] args) throws Exception {
        try (var context = new AnnotationConfigApplicationContext();
             var trace = RegistrationTrace.open(Path.of(args[0]).toAbsolutePath())) {
            context.registerBean(JdbcTemplate.class, () -> new JdbcTemplate(new DriverManagerDataSource(
                System.getenv("RB_COROUTINE_JDBC_URL"), System.getenv("RB_COROUTINE_JDBC_USER"),
                System.getenv("RB_COROUTINE_JDBC_PASSWORD"))));
            context.addBeanFactoryPostProcessor((BeanDefinitionRegistryPostProcessor) registry ->
                trace.observe("dynamic registrar", registry, view -> dynamicRegister(view, args[1])));
            context.refresh();
            if (CREATED.get() != 0) throw new AssertionError("tracing instantiated the selected bean");
            var selected = context.getBean("selected", Selected.class);
            if (CREATED.get() != 1 || !selected.color().equals(args[1])) throw new AssertionError("alias changed");
            if (context.getDefaultListableBeanFactory().isAlias("temporaryAlias") || context.containsBeanDefinition("unused")) {
                throw new AssertionError("registry mutations were not delegated");
            }
            var controlled = new IllegalStateException("controlled callback failure");
            try {
                trace.observe("failed registrar", context.getDefaultListableBeanFactory(), registry -> {
                    registry.registerAlias("selected", "observedBeforeFailure");
                    throw controlled;
                });
                throw new AssertionError("expected callback failure");
            } catch (IllegalStateException actual) {
                if (actual != controlled) throw actual;
            }
            if (!trace.isHealthy() || !context.getDefaultListableBeanFactory().isAlias("observedBeforeFailure")) throw new AssertionError("trace failed");
            var jdbc = context.getBean(JdbcTemplate.class);
            System.out.println("REGISTRY_JDBC:" + selected.color() + "|" + jdbc.queryForObject("SELECT VERSION()", String.class)
                + "|" + jdbc.queryForObject("SELECT 40 + 2", Integer.class) + "|" + CREATED.get());
        }
    }
}
