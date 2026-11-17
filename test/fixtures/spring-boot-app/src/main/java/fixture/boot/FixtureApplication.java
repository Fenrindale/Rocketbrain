package fixture.boot;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(SecretSettings.class)
public class FixtureApplication {
    public static void main(String[] args) {
        SpringApplication.run(FixtureApplication.class, args);
    }
}
