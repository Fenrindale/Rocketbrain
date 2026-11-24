package fixture.conditionsv27.configuration;

import fixture.conditionsv27.conditions.BranchGate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@BranchGate
public class GreenRoutes {
    @Bean
    public String greenChoice() { return "not-registered"; }
}
