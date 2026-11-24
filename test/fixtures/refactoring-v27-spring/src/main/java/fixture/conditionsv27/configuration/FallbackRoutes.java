package fixture.conditionsv27.configuration;

import fixture.conditionsv27.conditions.BranchGate;
import fixture.conditionsv27.conditions.FallbackRoute;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@FallbackRoute
@BranchGate
public class FallbackRoutes {
    @Bean
    public String fallbackChoice() { return "branch-fallback"; }
}
