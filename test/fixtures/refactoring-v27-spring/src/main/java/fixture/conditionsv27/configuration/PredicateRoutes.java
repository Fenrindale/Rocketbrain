package fixture.conditionsv27.configuration;

import fixture.conditionsv27.conditions.DeepFlags;
import fixture.conditionsv27.conditions.FixedChoice;
import fixture.conditionsv27.conditions.FlagGate;
import fixture.conditionsv27.conditions.TypeGate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@TypeGate("fixture.conditionsv27.conditions.AliasClasspathMarker")
public class PredicateRoutes {
    @Bean
    @FixedChoice
    public String ternaryTrue() { return "closed-choice"; }

    @Bean
    @ConditionalOnExpression("#{false ? true : (false ? true : false)}")
    public String ternaryFalse() { return "not-registered"; }

    @Bean
    @FlagGate({"enabled", "audited"})
    public String bothProperties() { return "both-enabled"; }

    @Bean
    @FlagGate("disabled")
    public String rejectedProperty() { return "not-registered"; }

    @Bean
    @ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags", name = "disabled", havingValue = false)
    public String expectedFalse() { return "explicit-false"; }

    @Bean
    @ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags", name = "missing", matchIfMissing = true)
    public String defaultMissing() { return "default-applied"; }

    @Bean
    @DeepFlags(routes = "enabled")
    public String flagOverride() { return "alias-override"; }

    @Bean
    @DeepFlags(routes = "disabled")
    public String flagDenied() { return "not-registered"; }

    @Bean
    @DeepFlags
    public String flagDefault() { return "alias-default"; }
}
