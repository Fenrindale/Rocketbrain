package fixture.conditionsv25.app;

import java.util.Map;
import fixture.conditionsv25.configuration.BlueRoutes;
import fixture.conditionsv25.configuration.GreenRoutes;
import fixture.conditionsv25.configuration.PredicateRoutes;
import fixture.conditionsv25.configuration.SeedRoutes;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

@SpringBootApplication
@Import({SeedRoutes.class, BlueRoutes.class, GreenRoutes.class, PredicateRoutes.class})
public class ConditionsApplication {
    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(ConditionsApplication.class);
        app.setAdditionalProfiles("rocket-blue");
        app.setDefaultProperties(Map.of("rocketbrain.fixture.route", "blue"));
        app.run(args);
    }
}
