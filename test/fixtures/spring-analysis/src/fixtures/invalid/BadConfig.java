package fixtures.invalid;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
@Configuration(proxyBeanMethods = false)
public class BadConfig {
    @Bean public String alpha() { return "alpha"; }
    @Bean public String beta() { return "beta"; }
}
