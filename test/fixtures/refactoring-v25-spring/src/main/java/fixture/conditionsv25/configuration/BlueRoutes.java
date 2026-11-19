package fixture.conditionsv25.configuration;

import fixture.conditionsv25.conditions.ColorRouteCondition;
import fixture.conditionsv25.conditions.RouteMarked;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@RouteMarked
@Conditional(ColorRouteCondition.class)
public class BlueRoutes {
    @Bean
    public String conditionalBlue() { return "condition-blue"; }
}
