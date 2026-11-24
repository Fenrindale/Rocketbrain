package fixture.conditionsv27.configuration;

import fixture.conditionsv27.conditions.BranchGate;
import fixture.conditionsv27.conditions.RouteMarked;
import fixture.conditionsv27.conditions.PrimaryMarker;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@RouteMarked
@PrimaryMarker
@BranchGate
public class BlueRoutes {
    @Bean
    public String blueChoice() { return "branch-blue"; }
}
