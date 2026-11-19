package fixture.conditionsv25.configuration;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingClass;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

@Configuration(proxyBeanMethods = false)
public class PredicateRoutes {
    @Bean
    @Profile({"rocket-blue & (!rocket-prod | rocket-qa)", "rocket-fallback"})
    public String profilePresent() { return "profile-blue"; }

    @Bean
    @Profile("rocket-green & !rocket-blue")
    public String profileAbsent() { return "profile-green"; }

    @Bean
    @ConditionalOnExpression("#{!false && (3 == 3 || 'blue' != 'blue')}")
    public String expressionPresent() { return "closed-spel"; }

    @Bean
    @ConditionalOnExpression("true && 'green' == 'blue'")
    public String expressionAbsent() { return "excluded-spel"; }

    @Bean
    @ConditionalOnClass(name = "fixture.conditionsv25.conditions.ClasspathMarker")
    public String classPresent() { return "class-present"; }

    @Bean
    @ConditionalOnMissingClass("fixture.conditionsv25.conditions.ClasspathMarker")
    public String classMissing() { return "class-missing"; }

    @Bean
    @ConditionalOnBean(name = "fixtureConditionSeed")
    public String namedBean() { return "seed-present"; }
}
