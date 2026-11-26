package fixture;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

@Configuration
public class WslSpringConfiguration {
    @Bean
    String toolchainMarker() {
        return "wsl-spring";
    }

    public static void main(String[] args) throws IOException {
        try (var context = new AnnotationConfigApplicationContext(WslSpringConfiguration.class)) {
            String marker = context.getBean(String.class);
            String data = databaseScore();
            int answer = Integer.parseInt(data.substring(0, data.indexOf(':')));
            String result = marker + ':' + answer + ':' + System.getProperty("os.name") + data.substring(data.indexOf(':')); // DEBUG_GATE
            Files.writeString(Path.of("wsl-debug-result.txt"), result);
        }
    }

    private static String databaseScore() throws IOException {
        var file = Path.of("wsl-fixture-db.properties");
        if (!Files.isRegularFile(file)) return "42:";
        Properties config = new Properties();
        try (var reader = Files.newBufferedReader(file)) { config.load(reader); }
        var source = new DriverManagerDataSource(config.getProperty("url"), config.getProperty("user"), config.getProperty("password"));
        source.setDriverClassName(config.getProperty("driver"));
        var jdbc = new JdbcTemplate(source);
        return jdbc.queryForObject("SELECT score FROM probe", Integer.class) + ":" + jdbc.queryForObject("SELECT VERSION()", String.class);
    }
}
