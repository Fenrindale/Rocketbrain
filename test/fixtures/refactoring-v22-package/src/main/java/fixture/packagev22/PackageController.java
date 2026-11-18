package fixture.packagev22;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import fixture.packagev22.payload.RootValue;
import fixture.packagev22.payload.nested.NestedValue;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class PackageController {
    private final JdbcTemplate jdbc;
    public PackageController(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @GetMapping("/probe/package-v22") public Map<String,Object> packages() throws IOException {
        try (InputStream root = RootValue.class.getResourceAsStream("root.txt");
             InputStream relative = NestedValue.class.getResourceAsStream("nested.txt");
             InputStream absolute = NestedValue.class.getResourceAsStream("/fixture/packagev22/payload/nested/nested.txt")) {
            return Map.of("value", RootValue.value()+NestedValue.value(),
                "root", new String(root.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "relative", new String(relative.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "absolute", new String(absolute.readAllBytes(), StandardCharsets.UTF_8).trim());
        }
    }
    @GetMapping("/probe/refactoring") public Map<String,String> refactoring() { return Map.of("value", "value:3", "constructor", "ctor:4"); }
    @GetMapping("/refactoring/move") public int move() { return 42; }
    @GetMapping("/probe/testing-state") public Map<String,Integer> state() { return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class), "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class), "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class)); }
}
