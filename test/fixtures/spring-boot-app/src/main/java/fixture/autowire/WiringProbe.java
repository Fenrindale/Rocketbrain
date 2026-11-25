package fixture.autowire;

import java.util.Arrays;
import org.springframework.beans.factory.NoUniqueBeanDefinitionException;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

public final class WiringProbe {
    private WiringProbe() {}

    public static void main(String[] arguments) {
        var source = new DriverManagerDataSource(System.getenv("RB_WIRING_DB_URL"),
            System.getenv("RB_WIRING_DB_USER"), System.getenv("RB_WIRING_DB_PASSWORD"));
        source.setDriverClassName(System.getenv("RB_WIRING_DB_DRIVER"));
        try (var context = new AnnotationConfigApplicationContext()) {
            context.registerBean(JdbcTemplate.class, () -> new JdbcTemplate(source));
            context.register(WiringConfiguration.class, WiringConsumer.class);
            try {
                context.refresh();
            } catch (RuntimeException startupFailure) {
                for (Throwable cause = startupFailure; cause != null; cause = cause.getCause()) {
                    if (cause instanceof NoUniqueBeanDefinitionException ambiguous) {
                        String names = String.join(",", ambiguous.getBeanNamesFound().stream().sorted().toList());
                        System.out.println("RB_WIRING ambiguous|" + names);
                        return;
                    }
                }
                throw startupFailure;
            }
            String[] candidates = context.getBeanNamesForType(Mode.class);
            Arrays.sort(candidates);
            System.out.println("RB_WIRING resolved|" + String.join(",", candidates) + "|" + context.getBean(WiringConsumer.class).result());
        }
    }
}
