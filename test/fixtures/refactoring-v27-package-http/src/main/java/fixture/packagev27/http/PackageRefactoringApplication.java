package fixture.packagev27.http;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class PackageRefactoringApplication {
    private final JdbcTemplate jdbc;

    public PackageRefactoringApplication(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public static void main(String[] args) {
        SpringApplication.run(PackageRefactoringApplication.class, args);
    }

    @GetMapping("/probe/package-v27")
    public Map<String, Object> packageService() throws Exception {
        Path java = Path.of(System.getProperty("java.home"), "bin", "java.exe");
        Path classes = Path.of("..", "refactoring-v27-package", "build", "classes", "java", "main").toAbsolutePath().normalize();
        Process probe = new ProcessBuilder(java.toString(), "--module-path", classes.toString(),
            "--module", "fixture.packagev27/fixture.packagev27.client.ModuleProbe").redirectErrorStream(true).start();
        try {
            if (!probe.waitFor(10, TimeUnit.SECONDS) || probe.exitValue() != 0) {
                throw new IllegalStateException("The named service probe failed.");
            }
            String providers = new String(probe.getInputStream().readNBytes(256), StandardCharsets.UTF_8).strip();
            if (!providers.matches("\\[\\d+(?:, \\d+)*\\]")) {
                throw new IllegalStateException("The named service probe returned an invalid result.");
            }
            return Map.of("module", "fixture.packagev27", "providerValues", providers,
                "people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class));
        } finally {
            if (probe.isAlive()) probe.destroyForcibly();
        }
    }

    @GetMapping("/probe/refactoring")
    public String refactoring() {
        return "module-service";
    }

    @GetMapping("/refactoring/move")
    public int moved() {
        return 1;
    }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
            "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
            "rolledBackNames", jdbc.queryForObject(
                "SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
