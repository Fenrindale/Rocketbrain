package fixture.conditionsv26.configuration;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnClass(name = "fixture.conditionsv26.conditions.ClasspathMarker")
public class PredicateRoutes {
    @Bean
    @ConditionalOnExpression("#{(2 == 2 && 'a' != 'b') ? (true ? true : false) : false}")
    public String ternaryTrue() { return "closed-choice"; }

    @Bean
    @ConditionalOnExpression("#{false ? true : (false ? true : false)}")
    public String ternaryFalse() { return "not-registered"; }

    @Bean
    @ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags", name = {"enabled", "audited"})
    public String bothProperties() { return "both-enabled"; }

    @Bean
    @ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags.", value = "disabled")
    public String rejectedProperty() { return "not-registered"; }

    @Bean
    @ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags", name = "disabled", havingValue = false)
    public String expectedFalse() { return "explicit-false"; }

    @Bean
    @ConditionalOnBooleanProperty(prefix = "rocketbrain.fixture.flags", name = "missing", matchIfMissing = true)
    public String defaultMissing() { return "default-applied"; }
}
