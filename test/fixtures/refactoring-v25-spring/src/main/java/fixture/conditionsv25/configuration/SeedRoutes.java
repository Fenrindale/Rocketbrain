package fixture.conditionsv25.configuration;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class SeedRoutes {
    @Bean(name = "fixtureConditionSeed")
    public String registrationSeed() { return "seed"; }
}
