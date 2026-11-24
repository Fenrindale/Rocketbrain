package fixture.conditionsv27.app;

import java.util.Map;
import fixture.conditionsv27.configuration.BlueRoutes;
import fixture.conditionsv27.configuration.FallbackRoutes;
import fixture.conditionsv27.configuration.GreenRoutes;
import fixture.conditionsv27.configuration.PredicateRoutes;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

@SpringBootApplication
@Import({BlueRoutes.class, GreenRoutes.class, FallbackRoutes.class, PredicateRoutes.class})
public class ConditionsApplication {
    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(ConditionsApplication.class);
        app.setAdditionalProfiles("rocket-blue");
        app.setDefaultProperties(Map.of(
            "rocketbrain.fixture.route", "blue",
            "rocketbrain.fixture.fallback", "present",
            "rocketbrain.fixture.flags.enabled", "true",
            "rocketbrain.fixture.flags.audited", "true",
            "rocketbrain.fixture.flags.disabled", "false"));
        app.run(args);
    }
}
