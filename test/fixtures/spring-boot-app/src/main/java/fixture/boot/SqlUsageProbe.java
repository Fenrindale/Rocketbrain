package fixture.boot;

import java.util.Map;
import org.springframework.data.jpa.repository.Query;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class SqlUsageProbe {
    private final JdbcTemplate jdbc;

    SqlUsageProbe(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/probe/sql-usages")
    Map<String, Integer> verify() {
        Integer direct = this.jdbc.queryForObject("""
                SELECT COUNT(p.display_name) FROM rb_spring_person p
                WHERE p.id > ?
                """, Integer.class, 0);
        Integer joinedLiteral = this.jdbc.queryForObject(
                "SELECT COUNT(p.display_name) " +
                "FROM rb_spring_person p WHERE p.id > ?", Integer.class, 0);
        return Map.of("textBlock", direct, "literalConcatenation", joinedLiteral);
    }
}

interface SqlUsageNativeRepository {
    @Query(value = "SELECT p.display_name FROM rb_spring_person p WHERE p.id > ?1", nativeQuery = true)
    String personNames(long minimumId);
}
