package fixture.springjdbc;

import java.util.Map;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import static org.springframework.http.HttpStatus.NOT_FOUND;
import static org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE;

@SpringBootApplication
@RestController
public class SpringComparison {
    private final Map<String, JdbcTemplate> sources = Map.of("mysql", source("MYSQL"), "mariadb", source("MARIADB"));
    private volatile boolean seeded;

    public static void main(String[] args) { SpringApplication.run(SpringComparison.class, args); }

    private static JdbcTemplate source(String engine) {
        return new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_NATIVE_" + engine + "_URL"),
            System.getenv("RB_NATIVE_DB_USER"), System.getenv("RB_NATIVE_DB_PASSWORD")));
    }

    @Bean ApplicationRunner seedOwnedDatabases() {
        return args -> {
            for (JdbcTemplate jdbc : sources.values()) {
                jdbc.execute("CREATE TABLE IF NOT EXISTS rb_native_people (id INT PRIMARY KEY, points INT NOT NULL)");
                jdbc.update("DELETE FROM rb_native_people");
                jdbc.update("INSERT INTO rb_native_people(id, points) VALUES(1, 19), (2, 23)");
            }
            seeded = true;
        };
    }

    @GetMapping("/probe/{engine}")
    String rows(@PathVariable String engine) {
        if (!seeded) throw new ResponseStatusException(SERVICE_UNAVAILABLE);
        JdbcTemplate jdbc = sources.get(engine);
        if (jdbc == null) throw new ResponseStatusException(NOT_FOUND);
        return jdbc.queryForObject("SELECT COUNT(*), SUM(points), VERSION() FROM rb_native_people",
            (row, index) -> "spring|" + row.getInt(1) + "|" + row.getInt(2) + "|" + row.getString(3));
    }
}
