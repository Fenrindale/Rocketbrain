package fixture.conditionsv25.configuration;

import fixture.conditionsv25.conditions.ColorRouteCondition;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@Conditional(ColorRouteCondition.class)
public class GreenRoutes {
    @Bean
    public String conditionalGreen() { return "condition-green"; }
}
