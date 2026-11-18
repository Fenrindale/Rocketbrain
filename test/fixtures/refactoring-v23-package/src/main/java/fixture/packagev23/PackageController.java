package fixture.packagev23;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.Map;
import fixture.packagev23.payload.RootValue;
import fixture.packagev23.payload.nested.NestedValue;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class PackageController {
    private final JdbcTemplate jdbc;
    public PackageController(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @GetMapping("/probe/package-v23") public Map<String,Object> packages() throws IOException {
        try (InputStream standard = RootValue.class.getResourceAsStream("root.txt");
             InputStream custom = NestedValue.class.getResourceAsStream("custom.txt");
             InputStream binary = RootValue.class.getResourceAsStream("payload.bin");
             InputStream absolute = RootValue.class.getResourceAsStream("/fixture/packagev23/payload/payload.bin")) {
            return Map.of("value", RootValue.value()+NestedValue.value(),
                "standard", new String(standard.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "custom", new String(custom.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "binary", HexFormat.of().formatHex(binary.readAllBytes()),
                "absolute", HexFormat.of().formatHex(absolute.readAllBytes()));
        }
    }
    @GetMapping("/probe/refactoring") public Map<String,String> refactoring() { return Map.of("value", "value:3", "constructor", "ctor:4"); }
    @GetMapping("/refactoring/move") public int move() { return 42; }
    @GetMapping("/probe/testing-state") public Map<String,Integer> state() { return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class), "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class), "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class)); }
}
