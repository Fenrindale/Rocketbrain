package fixture.mavenv26;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class MavenContractApplication {
    private final JdbcTemplate jdbc;
    public MavenContractApplication(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public static void main(String[] args) { SpringApplication.run(MavenContractApplication.class, args); }

    @GetMapping("/probe/maven-v26")
    public Map<String, Integer> moved() { return Map.of("value", MoveProbe.value()); }

    @GetMapping("/probe/refactoring")
    public Map<String, String> signature() { return Map.of("value", "value:3", "constructor", "ctor:4"); }

    @GetMapping("/refactoring/move")
    public int move() { return MoveProbe.value(); }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> state() {
        return Map.of(
            "people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
            "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
            "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
