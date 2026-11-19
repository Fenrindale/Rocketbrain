package fixture.dynamicv24.app;

import fixture.dynamicv24.configuration.BlueConfiguration;
import fixture.dynamicv24.configuration.GreenConfiguration;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;

@SpringBootApplication
@Import({BlueConfiguration.class, GreenConfiguration.class})
public class DynamicContractsApplication {
    public static void main(String[] args) { SpringApplication.run(DynamicContractsApplication.class, args); }
}
