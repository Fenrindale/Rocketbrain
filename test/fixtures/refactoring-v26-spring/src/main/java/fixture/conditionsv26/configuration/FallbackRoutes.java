package fixture.conditionsv26.configuration;

import fixture.conditionsv26.conditions.BranchCondition;
import fixture.conditionsv26.conditions.FallbackRoute;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@FallbackRoute
@Conditional(BranchCondition.class)
public class FallbackRoutes {
    @Bean
    public String fallbackChoice() { return "branch-fallback"; }
}
