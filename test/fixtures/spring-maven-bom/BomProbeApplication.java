package fixture.bom;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class BomProbeApplication {
    private final JdbcClient jdbc;

    public BomProbeApplication(JdbcClient jdbc) { this.jdbc = jdbc; }

    public static void main(String[] args) { SpringApplication.run(BomProbeApplication.class, args); }

    @EventListener
    void reportPort(WebServerInitializedEvent event) {
        System.out.println("RocketbrainBomFixture listening on " + event.getWebServer().getPort());
    }

    @GetMapping("/bom-probe")
    Map<String, Object> probe() {
        return Map.of("nonce", System.getenv("RB_BOM_FIXTURE_NONCE"), "boot", SpringBootVersion.getVersion(),
            "version", jdbc.sql("SELECT VERSION()").query(String.class).single(),
            "people", jdbc.sql("SELECT COUNT(*) FROM rb_spring_person").query(Long.class).single(),
            "departments", jdbc.sql("SELECT COUNT(*) FROM rb_spring_department").query(Long.class).single());
    }
}
