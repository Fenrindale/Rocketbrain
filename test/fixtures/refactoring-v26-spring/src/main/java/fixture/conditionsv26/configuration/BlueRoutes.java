package fixture.conditionsv26.configuration;

import fixture.conditionsv26.conditions.BranchCondition;
import fixture.conditionsv26.conditions.RouteMarked;
import fixture.conditionsv26.conditions.PrimaryMarker;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@RouteMarked
@PrimaryMarker
@Conditional(BranchCondition.class)
public class BlueRoutes {
    @Bean
    public String blueChoice() { return "branch-blue"; }
}
