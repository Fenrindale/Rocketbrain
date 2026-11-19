package fixture.packagev24;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import fixture.packagev24.payload.RootValue;
import fixture.packagev24.payload.nested.NestedValue;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class PackageController {
    private final JdbcTemplate jdbc;
    public PackageController(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @GetMapping("/probe/package-v24") public Map<String,Object> packages() throws IOException, NoSuchAlgorithmException {
        try (InputStream standard = RootValue.class.getResourceAsStream("root.txt");
             InputStream csv = RootValue.class.getClassLoader().getResource("fixture/packagev24/payload/nested/rows.csv").openStream();
             InputStream json = RootValue.class.getClassLoader().getResourceAsStream("fixture/packagev24/payload/labels.json");
             InputStream properties = NestedValue.class.getResourceAsStream("labels.properties");
             InputStream png = RootValue.class.getClassLoader().getResourceAsStream("fixture/packagev24/payload/pixel.png");
             InputStream jpeg = NestedValue.class.getResourceAsStream("/fixture/packagev24/payload/nested/pixel.jpg");
             InputStream springRelative = new org.springframework.core.io.ClassPathResource("labels.properties", NestedValue.class).getInputStream();
             InputStream springAbsolute = new org.springframework.core.io.ClassPathResource("/fixture/packagev24/payload/labels.json", RootValue.class).getInputStream()) {
            return Map.of("value", RootValue.value()+NestedValue.value(),
                "standard", new String(standard.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "csv", new String(csv.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "json", new String(json.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "properties", new String(properties.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "png", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(png.readAllBytes())),
                "jpeg", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(jpeg.readAllBytes())),
                "springRelative", new String(springRelative.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "springAbsolute", new String(springAbsolute.readAllBytes(), StandardCharsets.UTF_8).trim());
        }
    }
    @GetMapping("/probe/refactoring") public Map<String,String> refactoring() { return Map.of("value", "value:3", "constructor", "ctor:4"); }
    @GetMapping("/refactoring/move") public int move() { return 42; }
    @GetMapping("/probe/testing-state") public Map<String,Integer> state() { return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class), "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class), "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class)); }
}
