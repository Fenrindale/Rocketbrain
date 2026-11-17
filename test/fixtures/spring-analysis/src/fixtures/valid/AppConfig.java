package fixtures.valid;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Conditional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties
public class AppConfig {
    @Bean(name = {"aliasPort", "aliasedPort"})
    @Qualifier("factory")
    public Port factoryPort() { return new Port() { public String id() { return "factory"; } }; }

    @Bean
    public Holder holder(@Qualifier("blue") Port port, @Value("${app.greeting:Hello}") String greeting) { return new Holder(port, greeting); }

    @Bean
    @ConditionalOnProperty(prefix = "feature", name = "enabled", havingValue = "true")
    public Feature feature() { return new Feature(); }

    @Bean
    @Conditional(NeverCondition.class)
    public UnknownThing unknownThing() { return new UnknownThing(); }
}
