package fixture.conditionsv27.conditions;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.core.type.AnnotatedTypeMetadata;

public final class BranchCondition implements Condition {
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        final Environment environment = context.getEnvironment();
        final boolean active = environment.acceptsProfiles(Profiles.of("rocket-blue & (!rocket-prod | rocket-qa)", "rocket-fallback"));
        if (active && metadata.isAnnotated("fixture.conditionsv27.conditions.RouteMarked")) {
            final boolean preferPrimary = "blue".equals(environment.getProperty("rocketbrain.fixture.route"));
            return preferPrimary ? metadata.isAnnotated("fixture.conditionsv27.conditions.PrimaryMarker")
                : metadata.isAnnotated("fixture.conditionsv27.conditions.DormantMarker");
        } else if (metadata.isAnnotated("fixture.conditionsv27.conditions.FallbackRoute")) {
            return environment.containsProperty("rocketbrain.fixture.fallback");
        }
        return false;
    }
}
