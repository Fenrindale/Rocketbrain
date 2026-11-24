package fixture.conditionsv26.configuration;

import fixture.conditionsv26.conditions.BranchCondition;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@Conditional(BranchCondition.class)
public class GreenRoutes {
    @Bean
    public String greenChoice() { return "not-registered"; }
}
