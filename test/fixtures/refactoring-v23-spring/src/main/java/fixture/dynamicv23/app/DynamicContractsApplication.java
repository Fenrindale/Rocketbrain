package fixture.dynamicv23.app;

import fixture.dynamicv23.configuration.WithComposedConfiguration;
import fixture.dynamicv23.configuration.WithoutMarkerConfiguration;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

@SpringBootApplication
@Import({WithComposedConfiguration.class, WithoutMarkerConfiguration.class})
public class DynamicContractsApplication {
    public static void main(String[] args) { SpringApplication.run(DynamicContractsApplication.class, args); }
}
