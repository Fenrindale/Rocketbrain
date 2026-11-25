package fixture.feign;

import java.sql.DriverManager;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.openfeign.EnableFeignClients;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@EnableFeignClients(clients = {CatalogClient.class, CustomClient.class})
public class FeignContractFixture {
    public static void main(String[] args) { SpringApplication.run(FeignContractFixture.class, args); }
}

@RestController
class Probe {
    private final CatalogClient catalog;
    private final CustomClient custom;

    Probe(CatalogClient catalog, CustomClient custom) {
        this.catalog = catalog;
        this.custom = custom;
    }

    @GetMapping("/ready")
    Map<String, Boolean> ready() { return Map.of("ready", true); }

    @GetMapping("/probe/feign-contracts")
    Map<String, Object> routes() throws Exception {
        String inherited = catalog.person(7);
        String alternate = catalog.status();
        String overridden = catalog.notice();
        String nativeRoute = custom.custom(9);
        String db = System.getenv("RB_FEIGN_JDBC");
        int readback = 42;
        if (db != null) {
            try (var connection = DriverManager.getConnection(db, System.getenv("RB_FEIGN_USER"), System.getenv("RB_FEIGN_PASSWORD"));
                 var statement = connection.prepareStatement("SELECT 42");
                 var rows = statement.executeQuery()) {
                if (!rows.next()) throw new IllegalStateException("Missing JDBC fixture row");
                readback = rows.getInt(1);
            }
        }
        return Map.of("inherited", inherited, "alternate", alternate, "overridden", overridden,
            "custom", nativeRoute, "jdbc", db != null, "readback", readback);
    }
}
