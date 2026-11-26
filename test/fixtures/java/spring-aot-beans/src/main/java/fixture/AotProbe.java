package fixture;

import org.springframework.aot.AotDetector;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

@SpringBootConfiguration(proxyBeanMethods = false)
public class AotProbe {
    public static void main(String[] args) {
        try (var context = SpringApplication.run(AotProbe.class, args)) {
            if (!AotDetector.useGeneratedArtifacts()) {
                throw new IllegalStateException("The fixture must start from generated AOT definitions.");
            }
            var jdbc = context.getBean(JdbcTemplate.class);
            String server = jdbc.queryForObject("SELECT VERSION()", String.class);
            int value = jdbc.queryForObject("SELECT 42", Integer.class);
            System.out.println("rocketbrain-aot-proof:" + server + "|" + value + "|" +
                context.getBean("fixedAlias") + "|" + context.containsBean("activeProbe"));
        }
    }

    @Bean({"fixedProbe", "fixedAlias"})
    String fixed() {
        return "fixed";
    }

    @Bean
    @ConditionalOnProperty(name = "rocketbrain.aot.feature", havingValue = "enabled")
    Integer activeProbe() {
        return 42;
    }

    @Bean
    JdbcTemplate database() {
        return new JdbcTemplate(new DriverManagerDataSource(System.getenv("ROCKETBRAIN_AOT_DB_URL"),
            System.getenv("ROCKETBRAIN_AOT_DB_USER"), System.getenv("ROCKETBRAIN_AOT_DB_PASSWORD")));
    }
}
