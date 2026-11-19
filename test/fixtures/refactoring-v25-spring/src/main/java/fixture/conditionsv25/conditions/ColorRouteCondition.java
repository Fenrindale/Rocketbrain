package fixture.conditionsv25.conditions;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.type.AnnotatedTypeMetadata;

public final class ColorRouteCondition implements Condition {
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        return (context.getEnvironment().matchesProfiles("rocket-blue & (!rocket-prod | rocket-qa)", "rocket-fallback")
            && "blue".equals(context.getEnvironment().getProperty("rocketbrain.fixture.route"))
            && metadata.isAnnotated("fixture.conditionsv25.conditions.RouteMarked"))
            || context.getEnvironment().containsProperty("rocketbrain.fixture.override");
    }
}
