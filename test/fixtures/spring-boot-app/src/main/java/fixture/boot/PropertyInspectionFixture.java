package fixture.boot;

import org.springframework.boot.actuate.endpoint.SanitizingFunction;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "fixture.inspection.enabled", havingValue = "true")
class PropertyInspectionFixture {
    @Bean
    SanitizingFunction fixturePropertiesOnly() {
        return SanitizingFunction.sanitizeValue().ifKeyMatches(key -> !key.equalsIgnoreCase("fixture.inspection.message"));
    }
}
