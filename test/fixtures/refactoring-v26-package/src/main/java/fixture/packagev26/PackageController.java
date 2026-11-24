package fixture.packagev26;

import fixture.packagev26.payload.RootValue;
import fixture.packagev26.payload.PackageValue;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PackageController {
    private final JdbcTemplate jdbc;

    public PackageController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/probe/package-v26")
    public Map<String,Object> packages() throws IOException {
        int service = java.util.ServiceLoader.load(PackageValue.class, PackageValue.class.getClassLoader()).findFirst().orElseThrow().value();
        List<Integer> providers = java.util.ServiceLoader.load(PackageValue.class, PackageValue.class.getClassLoader())
            .stream().map(provider -> provider.get().value()).toList();
        try (InputStream system = java.lang.ClassLoader.getSystemResourceAsStream("fixture/packagev26/payload/root.txt");
             InputStream systemUrl = java.lang.ClassLoader.getSystemResource("fixture/packagev26/payload/nested/child.txt").openStream();
             InputStream spring = new org.springframework.core.io.ClassPathResource("fixture/packagev26/payload/nested/child.txt", RootValue.class.getClassLoader()).getInputStream()) {
            return Map.of("service", service, "providers", providers, "utility", RootValue.utility(),
                "system", new String(system.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "systemUrl", new String(systemUrl.readAllBytes(), StandardCharsets.UTF_8).trim(),
                "spring", new String(spring.readAllBytes(), StandardCharsets.UTF_8).trim());
        }
    }

    @GetMapping("/probe/refactoring")
    public Map<String,String> refactoring() {
        return Map.of("value", "value:3", "constructor", "ctor:4");
    }

    @GetMapping("/refactoring/move")
    public int move() {
        return 42;
    }

    @GetMapping("/probe/testing-state")
    public Map<String,Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
            "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
            "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
