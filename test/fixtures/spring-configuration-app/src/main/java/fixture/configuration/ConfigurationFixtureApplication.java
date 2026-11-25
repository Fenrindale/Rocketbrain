package fixture.configuration;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
@EnableConfigurationProperties(CatalogSettings.class)
public class ConfigurationFixtureApplication {
    private final JdbcClient jdbc;
    private final CatalogSettings catalog;
    private final Environment environment;

    public ConfigurationFixtureApplication(JdbcClient jdbc, CatalogSettings catalog, Environment environment) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.environment = environment;
    }

    public static void main(String[] args) {
        SpringApplication.run(ConfigurationFixtureApplication.class, args);
    }

    @GetMapping("/config-probe")
    Map<String,Object> probe() {
        return Map.of("displayName", catalog.getDisplayName(), "queryLimit", catalog.getQueryLimit(),
            "timeoutMillis", catalog.getTimeout().toMillis(), "thresholds", catalog.getThresholds(),
            "labels", catalog.getLabels(), "retries", catalog.getRetries(),
            "shadowIndex", environment.getRequiredProperty("fixture.catalog.thresholds[1]", Integer.class),
            "people", jdbc.sql("SELECT id FROM rb_spring_person ORDER BY id LIMIT :limit").param("limit", catalog.getQueryLimit()).query(Long.class).list(),
            "serverVersion", jdbc.sql("SELECT VERSION()").query(String.class).single());
    }

    @EventListener
    void reportPort(WebServerInitializedEvent event) {
        System.out.println("RocketbrainConfigurationFixture listening on " + event.getWebServer().getPort());
    }
}
